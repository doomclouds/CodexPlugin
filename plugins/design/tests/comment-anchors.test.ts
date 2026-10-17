import assert from "node:assert/strict";
import test from "node:test";
import { createCodeTemplate } from "../src/code-project.ts";
import { compileCodeProject } from "../src/code-preview.ts";
import { CommentAnchorIndex } from "../ui/comment-anchors.ts";

function sharedProject() {
  const project = createCodeTemplate("Comment identities", "react");
  project.files = [
    { path: "src/Card.tsx", encoding: "utf8", content: 'export function Card(){return <article data-design-id="shared"><h2>Shared source</h2></article>}' },
    { path: "src/First.tsx", encoding: "utf8", content: 'import {Card} from "./Card";export default function First(){return <main><Card/><Card/></main>}' },
    { path: "src/Second.tsx", encoding: "utf8", content: 'import {Card} from "./Card";export default function Second(){const visible=false;return <main>{visible&&<Card/>}</main>}' },
    { path: "empty.html", encoding: "utf8", content: "<main>Another actual page</main>" },
  ];
  project.pages = [{ id: "first", name: "First", entry: "src/First.tsx", route: "/" }, { id: "second", name: "Second", entry: "src/Second.tsx", route: "/second" }, { id: "empty", name: "Empty", entry: "empty.html", route: "/empty" }];
  project.defaultPageId = "first";
  return project;
}

test("source registries find exact shared anchors across actual entries and keep incomplete or failed pages unknown", async () => {
  const project = sharedProject(), index = new CommentAnchorIndex(); index.reset(project);
  const first = await compileCodeProject(project, { pageId: "first" });
  const marker = first.sources.find(source => source.file === "src/Card.tsx" && source.identity === "stable")!;
  assert.ok(marker);
  const comment = { file: marker.file, sourceId: marker.id };
  assert.equal(index.resolve(comment).status, "checking");
  index.begin(project.id, project.revision, "first"); index.record(first);
  assert.deepEqual(index.resolve(comment).pages.map(page => page.id), ["first"]);
  const second = await compileCodeProject(project, { pageId: "second" }); index.record(second);
  // A registry includes source for conditional and repeated components; it does not identify their DOM instances.
  assert.deepEqual(index.resolve(comment).pages.map(page => page.id), ["first", "second"]);
  assert.equal(index.resolve({ file: marker.file, sourceId: "removed-anchor" }).status, "checking");
  index.fail(project.id, project.revision, "empty", "Actual compilation failed");
  assert.equal(index.resolve({ file: marker.file, sourceId: "removed-anchor" }).status, "unknown");
  index.record(await compileCodeProject(project, { pageId: "empty" }));
  assert.equal(index.resolve({ file: marker.file, sourceId: "removed-anchor" }).status, "missing");
  assert.equal(index.resolve({ file: "removed.tsx", sourceId: marker.id }).status, "missing");
  assert.equal(index.resolve({ file: marker.file }).status, "file");
});

test("removing a semantic marker stays missing after recompilation and an old registry cannot revive it", async () => {
  const project = sharedProject(), index = new CommentAnchorIndex(); index.reset(project);
  const original = await compileCodeProject(project, { pageId: "first" });
  const marker = original.sources.find(source => source.identity === "stable")!;
  const comment = { file: marker.file, sourceId: marker.id };
  const changed = structuredClone(project); changed.revision++;
  changed.files[0]!.content = changed.files[0]!.content.replace(' data-design-id="shared"', "");
  index.reset(changed, true);
  assert.equal(index.record(original), false);
  assert.equal(index.fail(project.id, project.revision, "first", "stale failure"), false);
  for (const page of changed.pages) index.record(await compileCodeProject(changed, { pageId: page.id }));
  assert.equal(index.resolve(comment).status, "missing");
  assert.deepEqual(index.resolve(comment).pages, []);
  assert.equal(index.record({ ...original, projectId: "different-project", revision: changed.revision }), false);
  assert.equal(index.resolve(comment).status, "missing");
});

test("metadata-only revisions reuse checked source identities, while source and page-entry changes invalidate them", () => {
  const project = sharedProject(), index = new CommentAnchorIndex(); index.reset(project);
  index.record({ projectId: project.id, revision: project.revision, pageId: "first", sources: [{ id: "stable", file: "src/Card.tsx", identity: "stable" }], diagnostics: [] });
  const metadata = structuredClone(project); metadata.revision++; metadata.pages[0]!.name = "Renamed actual page";
  index.reset(metadata, true);
  assert.equal(index.resolve({ file: "src/Card.tsx", sourceId: "stable" }).pages[0]?.name, "Renamed actual page");
  assert.deepEqual(index.pendingPageIds(), ["second", "empty"]);
  const changedEntry = structuredClone(metadata); changedEntry.revision++; changedEntry.pages[0]!.entry = "src/Second.tsx";
  index.reset(changedEntry, true); assert.equal(index.pendingPageIds().length, 3);
  index.record({ projectId: changedEntry.id, revision: changedEntry.revision, pageId: "first", sources: [{ id: "stable", file: "src/Card.tsx" }], diagnostics: [{ level: "error", message: "Partial registry cannot prove a usable page" }] });
  assert.equal(index.resolve({ file: "src/Card.tsx", sourceId: "stable" }).pages.length, 0);
  index.retryUnknown(); assert.deepEqual(index.pendingPageIds(), ["first", "second", "empty"]);
});
