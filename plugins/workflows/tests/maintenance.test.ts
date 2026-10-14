import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { ProtocolSession } from "../src/adapter.ts";
import { activateMcpServer, applyMaintenance, createGitWorkspace, maintenanceFingerprint, reviewMaintenance, validateGitWorkspace, validateMaintenance } from "../src/maintenance.ts";
import type { ActivationSessionFactory } from "../src/maintenance.ts";
import type { MaintenancePlan } from "../src/types.ts";
import { assertPrivateFixtureFile, preparePrivateFixtureDirectory } from "./fixtures/private-file.ts";
import { gitCommandPreview } from "../src/submodules.ts";

const exec = promisify(execFile);
const plan: MaintenancePlan = { steps: [{ id: "check", command: ["node", "--version"] }] };
async function git(cwd: string, ...args: string[]) {
  const { stdout } = await exec("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Workflow Test", GIT_AUTHOR_EMAIL: "workflow-test@example.invalid", GIT_COMMITTER_NAME: "Workflow Test", GIT_COMMITTER_EMAIL: "workflow-test@example.invalid", GIT_TERMINAL_PROMPT: "0" } });
  return stdout.trim();
}
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(await realpath(tmpdir()), "workflow-maintenance-test-")));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  await preparePrivateFixtureDirectory(root);
  const project = path.join(root, "project"), remote = path.join(root, "origin.git"), data = path.join(root, "run");
  await mkdir(project);
  await git(root, "init", "--bare", "--quiet", remote);
  await git(project, "init", "--quiet", "--initial-branch=main");
  await writeFile(path.join(project, ".gitattributes"), "* text eol=lf\n");
  await writeFile(path.join(project, ".gitignore"), "dist/\nnode_modules/\n");
  await writeFile(path.join(project, "source.mjs"), "export const version = 1;\n");
  await mkdir(path.join(project, "nested"));
  await writeFile(path.join(project, "nested", "source.txt"), "inside fixture\n");
  await git(project, "add", "--all"); await git(project, "commit", "--quiet", "-m", "Add initial fixture");
  await writeFile(path.join(project, "history.txt"), "second commit\n");
  await git(project, "add", "--all"); await git(project, "commit", "--quiet", "-m", "Add fixture history");
  await git(project, "remote", "add", "origin", remote); await git(project, "push", "--quiet", "--set-upstream", "origin", "main");
  const base = await git(project, "rev-parse", "HEAD");
  const advance = async () => {
    const publisher = path.join(root, "publisher");
    await git(root, "clone", "--quiet", "--branch", "main", remote, publisher);
    await writeFile(path.join(publisher, "source.mjs"), "export const version = 2;\n");
    await git(publisher, "add", "--all"); await git(publisher, "commit", "--quiet", "-m", "Advance fixture release");
    await git(publisher, "push", "--quiet", "origin", "main");
    return git(publisher, "rev-parse", "HEAD");
  };
  return { root, project, remote, data, base, advance };
}

async function fullPatchFingerprint(cwd: string, args: string[]) {
  const hash = createHash("sha256"); let bytes = 0;
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["--no-pager", ...args], { cwd, stdio: ["ignore", "pipe", "ignore"] });
    child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; hash.update(chunk); });
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve() : reject(new Error("Reference Git diff failed")));
  });
  return { bytes, hash: hash.digest("hex") };
}

test("Git previews retain complete byte/hash metadata without cutting UTF-8 code points", async t => {
  const { project } = await fixture(t);
  const value = "A你🙂Z\n";
  await writeFile(path.join(project, "utf8.txt"), value);
  await git(project, "add", "--all"); await git(project, "commit", "--quiet", "-m", "Add Unicode fixture");
  const clipped = await gitCommandPreview(project, ["show", "HEAD:utf8.txt"], { previewBytes: 5 });
  assert.equal(clipped.text, "A你");
  assert.equal(clipped.text.includes("\ufffd"), false);
  assert.equal(clipped.previewTruncated, true);
  assert.equal(clipped.totalBytes, Buffer.byteLength(value));
  assert.equal(clipped.contentSha256, createHash("sha256").update(value).digest("hex"));
  const complete = await gitCommandPreview(project, ["show", "HEAD:utf8.txt"]);
  assert.equal(complete.text, value); assert.equal(complete.previewTruncated, false);
  assert.equal(complete.contentSha256, clipped.contentSha256);
  const legacyBytes = Buffer.from([0xff, 0xe9, 0x42, 0xfe]);
  await writeFile(path.join(project, "legacy.txt"), legacyBytes);
  await git(project, "add", "--all"); await git(project, "commit", "--quiet", "-m", "Add non-UTF8 fixture");
  const legacy = await gitCommandPreview(project, ["show", "HEAD:legacy.txt"], { previewBytes: 6 });
  assert.equal(legacy.totalBytes, legacyBytes.length);
  assert.equal(legacy.contentSha256, createHash("sha256").update(legacyBytes).digest("hex"));
  assert.equal(legacy.previewTruncated, true, "Replacement characters must not expand a complete raw prefix beyond the serialized preview cap.");
  assert.ok(Buffer.byteLength(legacy.text) <= 6);
  assert.equal(legacy.text, "\ufffd\ufffd");
  await assert.rejects(gitCommandPreview(project, ["show", "private-fixture-secret-revision"]), error => {
    assert.ok(error instanceof Error); assert.equal(error.message.includes("private-fixture-secret-revision"), false);
    assert.match(error.message, /Git show failed/); return true;
  });
});

test("maintenance reviews and applies a real patch larger than 32 MiB using a bounded preview", async t => {
  const { project, data, base } = await fixture(t);
  const workspace = await createGitWorkspace(project, data);
  const filename = path.join(workspace.root, "bulk.txt");
  const block = ("large-review-content-" + "x".repeat(106) + "\n").repeat(8192);
  const contentHash = createHash("sha256"), file = await open(filename, "w");
  try { for (let index = 0; index < 35; index++) { await file.writeFile(block); contentHash.update(block); } }
  finally { await file.close(); }
  const expectedContentHash = contentHash.digest("hex");
  await git(workspace.root, "add", "--all"); await git(workspace.root, "commit", "--quiet", "-m", "Add large real review fixture");
  await git(workspace.root, "config", "color.ui", "always");
  const target = await git(workspace.root, "rev-parse", "HEAD");
  const args = ["diff", "--binary", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", base, target, "--"];
  const expected = await fullPatchFingerprint(workspace.root, args);
  assert.ok(expected.bytes > 32 * 1024 * 1024, "The real patch must exceed the previous Git buffer limit.");
  const review = await reviewMaintenance(workspace, plan);
  assert.equal(review.diff.previewTruncated, true);
  assert.ok(Buffer.byteLength(review.diff.text) <= 4 * 1024 * 1024);
  assert.equal(review.diff.totalBytes, expected.bytes);
  assert.equal(review.diff.contentSha256, expected.hash);
  assert.equal(review.diff.text.includes("\u001b["), false);
  assert.deepEqual(review.diff.files, [{ path: "bulk.txt", status: "added" }]);
  assert.equal(review.preparedClean, true);
  const begin = Date.now();
  await assert.rejects(gitCommandPreview(workspace.root, args, { timeoutMs: 5 }), error => {
    assert.equal((error as NodeJS.ErrnoException).code, "ETIMEDOUT"); return true;
  });
  assert.ok(Date.now() - begin < 10000, "A timed-out Git process must be terminated and reaped.");
  await appendFile(filename, "uncommitted change beyond the preview\n");
  const tampered = await reviewMaintenance(workspace, plan);
  assert.equal(tampered.diff.text, review.diff.text);
  assert.equal(tampered.diff.contentSha256, review.diff.contentSha256);
  assert.notEqual(tampered.fingerprint, review.fingerprint, "Full checkout state, not patch preview or patch hash, protects application.");
  await assert.rejects(applyMaintenance(workspace, review, plan), /changed since review/);
  await git(workspace.root, "restore", "--", "bulk.txt");
  assert.equal((await applyMaintenance(workspace, review, plan)).applied, true);
  assert.equal(await git(project, "rev-parse", "HEAD"), target);
  assert.equal(createHash("sha256").update(await readFile(path.join(project, "bulk.txt"))).digest("hex"), expectedContentHash);
});

test("maintenance plans are explicit argument vectors with bounded retries and a separate network grant", () => {
  assert.deepEqual(validateMaintenance(plan, false), plan);
  assert.throws(() => validateMaintenance({ steps: [{ id: "fetch", command: ["git", "fetch"], networkAccess: true }] }, false), /network grant/);
  assert.throws(() => validateMaintenance({ steps: [{ id: "check", command: ["node"], retries: 3 }] }, false), /retries/);
  assert.throws(() => validateMaintenance({ steps: [{ id: "same", command: ["node"] }, { id: "same", command: ["node"] }] }, false), /unique/);
});

test("protected maintenance paths are explicit bounded relative directories and normalize without changing old plans", () => {
  const normalized = validateMaintenance({ steps: [{ id: "generate", command: ["node", "generate.mjs"], protectedPaths: [".codex/cache", ".agents/skills", ".agents/skills"] }] }, false);
  assert.deepEqual(normalized.steps[0]?.protectedPaths, [".agents/skills", ".codex/cache"]);
  assert.equal(Object.hasOwn(validateMaintenance(plan, false).steps[0]!, "protectedPaths"), false);
  for (const value of [null, [], ".agents", ["/absolute"], [".git"], ["../.agents"], [".agents/../outside"], [".agents\\skills"], [".agents/./skills"], [".agents/"], [" .agents/skills"], [".agents/*"], [".agents/foo\0bar"], [".agents/" + "a".repeat(1024)], Array.from({ length: 17 }, (_, index) => `.agents/path-${index}`)]) {
    assert.throws(() => validateMaintenance({ steps: [{ id: "invalid", command: ["node"], protectedPaths: value }] } as unknown as MaintenancePlan, false), /protected|relative|path|director|array|length|control|segment|limit|entry/i);
  }
});

test("independent Git checkout retains history, original remotes and upstream without shared metadata", async t => {
  const { project, remote, data, base } = await fixture(t);
  await git(project, "remote", "add", "backup", remote);
  const workspace = await createGitWorkspace(project, data);
  assert.equal(await git(workspace.root, "rev-parse", "HEAD"), base);
  assert.equal(await git(workspace.root, "rev-list", "--count", "HEAD"), "2");
  assert.equal(await git(workspace.root, "remote", "get-url", "origin"), remote);
  assert.equal(await git(workspace.root, "remote", "get-url", "backup"), remote);
  assert.equal(await git(workspace.root, "rev-parse", "--abbrev-ref", "@{upstream}"), "origin/main");
  assert.notEqual(await realpath(path.join(workspace.root, ".git")), await realpath(path.join(project, ".git")));
  await assert.rejects(lstat(path.join(workspace.root, ".git", "objects", "info", "alternates")), { code: "ENOENT" });
  await validateGitWorkspace(workspace);
});

test("checkout preparation overrides global hooks and templates without importing source hook settings", async t => {
  const { root, project, data, advance } = await fixture(t);
  const target = await advance();
  const marker = path.join(root, "unexpected-hook-marker");
  const globalHooks = path.join(root, "global-hooks"), localHooks = path.join(root, "source-hooks"), template = path.join(root, "git-template");
  await mkdir(globalHooks); await mkdir(localHooks); await mkdir(path.join(template, "hooks"), { recursive: true });
  const script = '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(' + JSON.stringify(marker) + ', "unexpected hook execution");\n';
  for (const directory of [globalHooks, localHooks, path.join(template, "hooks")]) for (const event of ["post-checkout", "post-merge"]) {
    const hook = path.join(directory, event); await writeFile(hook, script); await chmod(hook, 0o755);
  }
  await git(project, "config", "core.hooksPath", localHooks);
  const globalConfig = path.join(root, "test-gitconfig");
  const previous = process.env.GIT_CONFIG_GLOBAL;
  try {
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    await writeFile(globalConfig, `[core]\nhooksPath = ${JSON.stringify(globalHooks)}\n[init]\ntemplateDir = ${JSON.stringify(template)}\n`);
    const first = await createGitWorkspace(project, data);
    assert.notEqual(await git(first.root, "config", "core.hooksPath"), localHooks);
    assert.notEqual(await git(first.root, "config", "core.hooksPath"), globalHooks);
    await assert.rejects(lstat(marker), { code: "ENOENT" });
    await assert.rejects(lstat(path.join(first.root, ".git", "hooks", "post-checkout")), { code: "ENOENT" });
    await git(first.root, "pull", "--quiet", "--ff-only", "origin", "main");
    assert.equal((await applyMaintenance(first, await reviewMaintenance(first, plan), plan)).applied, true);
    assert.equal(await git(project, "rev-parse", "HEAD"), target);
    await assert.rejects(lstat(marker), { code: "ENOENT" });
    const checkpoint = await maintenanceFingerprint(first);
    await git(first.root, "config", "test.scope", "changed-local-setting");
    assert.notEqual(await maintenanceFingerprint(first), checkpoint);
    await writeFile(globalConfig, `[init]\ntemplateDir = ${JSON.stringify(template)}\n`);
    const second = await createGitWorkspace(project, path.join(root, "second-run"));
    await assert.rejects(lstat(marker), { code: "ENOENT" });
    await assert.rejects(lstat(path.join(second.root, ".git", "hooks", "post-checkout")), { code: "ENOENT" });
    assert.equal(await git(project, "config", "core.hooksPath"), localHooks);
  } finally { if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = previous; }
});

test("dirty originals are rejected before cloning and changed original HEAD invalidates resume", async t => {
  const { project, data } = await fixture(t);
  await writeFile(path.join(project, "source.mjs"), "dirty\n");
  await assert.rejects(createGitWorkspace(project, data), /clean/);
  await git(project, "restore", "source.mjs");
  const workspace = await createGitWorkspace(project, data);
  await writeFile(path.join(project, "later.txt"), "user later commit\n");
  await git(project, "add", "--all"); await git(project, "commit", "--quiet", "-m", "Advance original independently");
  await assert.rejects(validateGitWorkspace(workspace), /HEAD or branch changed/);
});

test("review pins the commit and ignored artifacts; application fast-forwards the original only", async t => {
  const { project, data, base, advance } = await fixture(t);
  const workspace = await createGitWorkspace(project, data);
  const target = await advance();
  await git(workspace.root, "pull", "--quiet", "--ff-only", "origin", "main");
  await mkdir(path.join(workspace.root, "dist"));
  await writeFile(path.join(workspace.root, "dist", "server.mjs"), "export const built = 2;\n");
  const review = await reviewMaintenance(workspace, plan);
  assert.equal(review.base, base); assert.equal(review.target, target); assert.equal(review.preparedClean, true);
  assert.deepEqual(review.diff.files, [{ path: "source.mjs", status: "modified" }]);
  assert.ok(review.artifacts.some(item => item.path === "dist/server.mjs"));
  assert.equal(await git(project, "rev-parse", "HEAD"), base);
  const applied = await applyMaintenance(workspace, review, plan);
  assert.equal(applied.applied, true);
  assert.equal(await git(project, "rev-parse", "HEAD"), target);
  assert.equal(await readFile(path.join(project, "source.mjs"), "utf8"), "export const version = 2;\n");
  await assert.rejects(lstat(path.join(project, "dist")), { code: "ENOENT" });
  assert.equal((await applyMaintenance(workspace, review, plan)).applied, true);
});

test("ignored artifact or source tampering invalidates the review and checkpoint", async t => {
  const { project, data } = await fixture(t);
  const workspace = await createGitWorkspace(project, data);
  await mkdir(path.join(workspace.root, "dist"));
  await writeFile(path.join(workspace.root, "dist", "server.mjs"), "one\n");
  const checkpoint = await maintenanceFingerprint(workspace), review = await reviewMaintenance(workspace, plan);
  await writeFile(path.join(workspace.root, "dist", "server.mjs"), "two\n");
  assert.notEqual(await maintenanceFingerprint(workspace), checkpoint);
  await assert.rejects(applyMaintenance(workspace, review, plan), /changed since review/);
  const afterArtifact = await maintenanceFingerprint(workspace);
  await writeFile(path.join(workspace.root, "source.mjs"), "uncommitted source\n");
  assert.notEqual(await maintenanceFingerprint(workspace), afterArtifact);
  await assert.rejects(applyMaintenance(workspace, await reviewMaintenance(workspace, plan), plan), /uncommitted source/);
});

test("a changed original baseline and a divergent prepared commit refuse application", async t => {
  const { project, data } = await fixture(t);
  const workspace = await createGitWorkspace(project, data);
  const review = await reviewMaintenance(workspace, plan);
  await writeFile(path.join(project, "source.mjs"), "original changed after review\n");
  assert.equal((await applyMaintenance(workspace, review, plan)).applied, false);
  await git(project, "restore", "source.mjs");
  await git(workspace.root, "checkout", "--quiet", "--orphan", "divergent");
  await git(workspace.root, "rm", "--quiet", "--force", "-r", ".");
  await writeFile(path.join(workspace.root, "unrelated.txt"), "unrelated history\n");
  await git(workspace.root, "add", "--all"); await git(workspace.root, "commit", "--quiet", "-m", "Create divergent fixture history");
  const divergent = await reviewMaintenance(workspace, plan);
  assert.deepEqual((await applyMaintenance(workspace, divergent, plan)).conflicts, ["non-fast-forward-target"]);
});

test("artifact hashing rejects external leaves and tracked files under a replaced parent", async t => {
  const { root, project, data } = await fixture(t);
  const workspace = await createGitWorkspace(project, data);
  const external = path.join(root, "external"); await mkdir(external);
  await writeFile(path.join(external, "source.txt"), "external fixture\n");
  await rm(path.join(workspace.root, "nested"), { recursive: true });
  await symlink(external, path.join(workspace.root, "nested"), process.platform === "win32" ? "junction" : "dir");
  await writeFile(path.join(workspace.root, ".gitignore"), "nested\ndist\n");
  await assert.rejects(maintenanceFingerprint(workspace), /unsafe parent|external.*symlink/i);
  await rm(path.join(workspace.root, "nested")); await git(workspace.root, "restore", "nested", ".gitignore");
  await symlink(external, path.join(workspace.root, "dist"), process.platform === "win32" ? "junction" : "dir");
  await writeFile(path.join(workspace.root, ".gitignore"), "dist\n");
  await assert.rejects(maintenanceFingerprint(workspace), /unsafe parent|external.*symlink/i);
});

async function configFixture(t: TestContext) {
  const setup = await fixture(t);
  const workspace = await createGitWorkspace(setup.project, setup.data);
  const settingsRoot = path.join(setup.root, "codex-test-home"); await mkdir(settingsRoot, { mode: 0o700 });
  const configFile = path.join(settingsRoot, "config.toml");
  const content = '# Keep this comment\nmodel = "fixture-unused"\n\n[mcp_servers.sample]\ncommand = "node"\nargs = ["old-server.mjs"]\nstartup_timeout_sec = 37\ntool_timeout_sec = 91\n\n[mcp_servers.sample.env]\nAPP_SETTING = "fixture-value"\n\n[mcp_servers.other]\ncommand = "node"\nargs = ["other-server.mjs"]\n';
  await writeFile(configFile, content, { mode: 0o600 });
  const wrapper = fileURLToPath(new URL("./fixtures/config-app-server.mjs", import.meta.url));
  let writes = 0;
  const factory: ActivationSessionFactory = cwd => {
    const session = new ProtocolSession(process.execPath, [wrapper, settingsRoot], cwd, 15000, 5000, () => {});
    return { request: async (method, params) => { const result = await session.request(method, params); if (method === "config/batchWrite") writes++; return result; }, send: message => session.send(message), close: async () => {
      try { await session.request("fixture/shutdown", {}, 7000); }
      finally { await session.close(); }
    } };
  };
  const activation = { serverName: "sample", command: "node", args: ["${WORKSPACE}/dist/server.mjs"] };
  const readConfig = async () => {
    const session = factory(workspace.root);
    try {
      await session.request("initialize", { clientInfo: { name: "maintenance_test", title: "Maintenance test", version: "1" } });
      session.send({ method: "initialized", params: {} });
      const response = await session.request("config/read", { includeLayers: true }) as { layers: Array<{ name: { type: string; profile?: unknown }; config: Record<string, unknown> }> };
      return response.layers.find(item => item.name.type === "user" && !item.name.profile)!.config;
    } finally { await session.close(); }
  };
  return { ...setup, workspace, configFile, content, factory, activation, readConfig, writes: () => writes };
}

test("real owned app-server updates one server, preserves its settings and returns pending_restart", async t => {
  const setup = await configFixture(t);
  const before = await setup.readConfig();
  const result = await activateMcpServer(setup.workspace, setup.activation, setup.factory);
  assert.equal(result.status, "pending_restart", result.error);
  const after = await setup.readConfig();
  const servers = after.mcp_servers as Record<string, Record<string, unknown>>;
  assert.equal(servers.sample!.command, "node");
  assert.deepEqual(servers.sample!.args, setup.activation.args.map(argument => argument.replaceAll("${WORKSPACE}", setup.workspace.root)));
  assert.equal(servers.sample!.startup_timeout_sec, 37); assert.equal(servers.sample!.tool_timeout_sec, 91);
  assert.deepEqual(servers.sample!.env, { APP_SETTING: "fixture-value" });
  assert.deepEqual(servers.other, (before.mcp_servers as Record<string, unknown>).other);
  assert.equal(after.model, before.model);
  assert.equal(await readFile(result.backupPath!, "utf8"), setup.content);
  assert.match(await readFile(setup.configFile, "utf8"), /Keep this comment/);
  await assertPrivateFixtureFile(result.backupPath!);
  await assertPrivateFixtureFile(path.join(setup.data, "activation-journal.json"));
});

test("activation recovery recognizes an already committed target without rewriting its true preimage", async t => {
  const setup = await configFixture(t);
  const first = await activateMcpServer(setup.workspace, setup.activation, setup.factory);
  assert.equal(first.status, "pending_restart", first.error);
  const journalFile = path.join(setup.data, "activation-journal.json");
  const journal = JSON.parse(await readFile(journalFile, "utf8")) as Record<string, unknown>;
  const before = structuredClone(journal.before);
  journal.state = "prepared"; delete journal.writtenVersion;
  await writeFile(journalFile, JSON.stringify(journal), { mode: 0o600 });
  const writes = setup.writes();
  const recovered = await activateMcpServer(setup.workspace, setup.activation, setup.factory);
  assert.equal(recovered.status, "pending_restart", recovered.error);
  assert.equal(setup.writes(), writes);
  assert.deepEqual(JSON.parse(await readFile(journalFile, "utf8")).before, before);
  assert.equal(await readFile(first.backupPath!, "utf8"), setup.content);
});

test("a post-write verification failure rolls back only the server and verifies restoration", async t => {
  const setup = await configFixture(t);
  const before = await setup.readConfig();
  let didWrite = false, failedOnce = false;
  const factory: ActivationSessionFactory = cwd => {
    const session = setup.factory(cwd);
    return { ...session, request: async (method, params) => {
      if (method === "config/read" && didWrite && !failedOnce) { failedOnce = true; throw new Error("Injected verification failure after a real write"); }
      const result = await session.request(method, params);
      if (method === "config/batchWrite") didWrite = true;
      return result;
    } };
  };
  const result = await activateMcpServer(setup.workspace, setup.activation, factory);
  assert.equal(result.status, "failed"); assert.match(result.error!, /restored and verified/);
  assert.deepEqual(await setup.readConfig(), before);
  const journal = JSON.parse(await readFile(path.join(setup.data, "activation-journal.json"), "utf8"));
  assert.equal(journal.state, "rolled_back");
  const retry = await activateMcpServer(setup.workspace, setup.activation, setup.factory);
  assert.equal(retry.status, "pending_restart", retry.error);
});

test("configuration CAS refuses a concurrent edit instead of overwriting it", async t => {
  const setup = await configFixture(t);
  let interfered = false;
  const factory: ActivationSessionFactory = cwd => {
    const session = setup.factory(cwd);
    return { ...session, request: async (method, params) => {
      if (method === "config/batchWrite" && !interfered) {
        interfered = true;
        await session.request("config/batchWrite", { filePath: params.filePath, expectedVersion: params.expectedVersion, edits: [{ keyPath: "model", value: "concurrent-fixture-value", mergeStrategy: "replace" }], reloadUserConfig: false });
      }
      return session.request(method, params);
    } };
  };
  const result = await activateMcpServer(setup.workspace, setup.activation, factory);
  assert.equal(result.status, "failed");
  const config = await setup.readConfig();
  assert.equal(config.model, "concurrent-fixture-value");
  assert.deepEqual((config.mcp_servers as Record<string, Record<string, unknown>>).sample!.args, ["old-server.mjs"]);
  assert.equal(await readFile(result.backupPath!, "utf8"), setup.content);
  assert.equal((await activateMcpServer(setup.workspace, setup.activation, setup.factory)).status, "pending_restart");
});

test("source fast-forward plus failed activation is explicit and retries only activation", async t => {
  const setup = await configFixture(t);
  const target = await setup.advance();
  await git(setup.workspace.root, "pull", "--quiet", "--ff-only", "origin", "main");
  const maintenance: MaintenancePlan = { ...plan, activation: setup.activation };
  const review = await reviewMaintenance(setup.workspace, maintenance);
  let didWrite = false, failedOnce = false;
  const faulty: ActivationSessionFactory = cwd => {
    const session = setup.factory(cwd);
    return { ...session, request: async (method, params) => {
      if (method === "config/read" && didWrite && !failedOnce) { failedOnce = true; throw new Error("Injected post-write verification failure"); }
      const result = await session.request(method, params); if (method === "config/batchWrite") didWrite = true; return result;
    } };
  };
  const partial = await applyMaintenance(setup.workspace, review, maintenance, faulty);
  assert.equal(partial.applied, true);
  assert.equal(partial.activation?.status, "failed");
  assert.equal(await git(setup.project, "rev-parse", "HEAD"), target);
  const restored = await setup.readConfig();
  assert.deepEqual((restored.mcp_servers as Record<string, Record<string, unknown>>).sample!.args, ["old-server.mjs"]);
  const complete = await applyMaintenance(setup.workspace, review, maintenance, setup.factory);
  assert.equal(complete.applied, true);
  assert.equal(complete.activation?.status, "pending_restart", complete.activation?.error);
  assert.equal(await git(setup.project, "rev-parse", "HEAD"), target);
});

test("automatic operation retry requires an explicit idempotency declaration",()=>{
  assert.throws(()=>validateMaintenance({steps:[{id:"submit",command:["node","submit.mjs"],networkAccess:true,retries:1}]},true),/idempotent/);
  assert.equal(validateMaintenance({steps:[{id:"install",command:["npm","ci"],networkAccess:true,retries:1,idempotent:true}]},true).steps[0]?.idempotent,true);
});
