import assert from "node:assert/strict";
import test from "node:test";
import { createCodeTemplate } from "../src/code-project.ts";
import { acceptsCodeRevisionAck, sameCodeRenderInputs } from "../src/code-render-inputs.ts";
import type { CodeRevisionBinding } from "../src/code-render-inputs.ts";

test("only unchanged render inputs permit binding a live document across descriptive metadata revisions", () => {
  const project = createCodeTemplate("Render identity", "html"), commentOnly = structuredClone(project);
  commentOnly.revision++; commentOnly.updatedAt = new Date().toISOString(); commentOnly.comments.push({ id: "comment", file: "index.html", text: "Feedback only", status: "open", createdAt: project.createdAt });
  assert.equal(sameCodeRenderInputs(project, commentOnly), true);
  const referencesOnly = structuredClone(commentOnly);
  referencesOnly.designSystem.notes += "Updated brand intent, without changing actual CSS.";
  referencesOnly.designSystem.components[0]!.usage = "Updated instructions for the same component source.";
  assert.equal(sameCodeRenderInputs(project, referencesOnly), true, "Reference values and usage notes must not rebuild a running prototype without a source change");
  for (const change of [
    (next: typeof project) => { next.id += "_other"; },
    (next: typeof project) => { next.files[0]!.content += "\n"; },
    (next: typeof project) => { next.pages[0]!.route = "/new"; },
    (next: typeof project) => { next.pages[0]!.entry = "different.html"; },
    (next: typeof project) => { next.viewports[0]!.width++; },
    (next: typeof project) => { next.name = "Different title"; },
  ]) { const changed = structuredClone(commentOnly); change(changed); assert.equal(sameCodeRenderInputs(project, changed), false); }
});

test("revision acknowledgements reject old nonces, old frame scope and changed source hashes before mutation", () => {
  const binding: CodeRevisionBinding = { projectId: "project", pageId: "page", revision: 3, desiredRevision: 5, renderIdentity: "render-code", fileHashes: { "App.tsx": "source-hash" }, syncing: { from: 3, to: 4, nonce: "current-nonce" } };
  const current = { projectId: "project", pageId: "page", revision: 5, fileHashes: new Map([["App.tsx", "source-hash"]]) };
  const acknowledgement = { type: "design:revision-synced", projectId: "project", pageId: "page", previousRevision: 3, revision: 4, nonce: "current-nonce", renderIdentity: "render-code", fileHashes: { "App.tsx": "source-hash" } };
  assert.equal(acceptsCodeRevisionAck(binding, current, acknowledgement), true, "The actual pending revision may finish before the next queued metadata revision");
  for (const override of [{ nonce: "old-nonce" }, { projectId: "old-project" }, { pageId: "old-page" }, { previousRevision: 2 }, { revision: 5 }, { renderIdentity: "old-source" }, { fileHashes: { "App.tsx": "changed-source-hash" } }, { fileHashes: {} }]) assert.equal(acceptsCodeRevisionAck(binding, current, { ...acknowledgement, ...override }), false);
  assert.equal(acceptsCodeRevisionAck({ ...binding, syncing: undefined }, current, acknowledgement), false, "Duplicate acknowledgements cannot advance an already confirmed frame");
  assert.equal(acceptsCodeRevisionAck({ ...binding, revision: 2 }, current, acknowledgement), false);
  assert.equal(acceptsCodeRevisionAck(binding, { ...current, fileHashes: new Map([["App.tsx", "new-project-source"]]) }, acknowledgement), false);
  assert.equal(binding.revision, 3, "Validation never mutates a live frame");
});
