import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { isWindowsNamedPipe, resolveReferencePath } from "../src/deletion-path.ts";
import type { ReferenceFileSystem } from "../src/deletion-path.ts";

const root = path.join(tmpdir(), "workflows-deletion-path-fixture");
const errno = (code: string) => Object.assign(new Error(`Synthetic filesystem failure: ${code}`), { code });
const unexpected = async (): Promise<never> => { throw new Error("Unexpected filesystem operation"); };

function filesystem(overrides: Partial<ReferenceFileSystem>): ReferenceFileSystem {
  return { realpath: unexpected, lstat: unexpected, readlink: unexpected, ...overrides };
}

for (const code of ["EACCES", "EPERM"]) {
  test(`Windows application aliases resolve their verified targets after ${code}`, async () => {
    const alias = path.join(root, "WindowsApps", "python.exe");
    const target = path.join(root, "installed-python", "python.exe");
    const canonicalTarget = path.join(root, "canonical-python", "python.exe");
    const calls: Array<[string, string]> = [];
    const resolved = await resolveReferencePath(alias, filesystem({
      realpath: async filename => {
        calls.push(["realpath", filename]);
        if (filename === alias) throw errno(code);
        assert.equal(filename, target);
        return canonicalTarget;
      },
      lstat: async filename => { calls.push(["lstat", filename]); assert.equal(filename, alias); return { isSymbolicLink: () => true }; },
      readlink: async filename => { calls.push(["readlink", filename]); assert.equal(filename, alias); return target; },
    }));
    assert.equal(resolved, canonicalTarget);
    assert.ok(calls.some(([operation, filename]) => operation === "lstat" && filename === alias));
    assert.ok(calls.some(([operation, filename]) => operation === "readlink" && filename === alias));
  });
}

test("an inaccessible alias targeting a retained run still resolves into that run", async () => {
  const alias = path.join(root, "WindowsApps", "workflow-server.exe");
  const target = path.join(root, "wf_0123456789abcdef01234567", "workspace", "server.exe");
  const resolved = await resolveReferencePath(alias, filesystem({
    realpath: async filename => { if (filename === alias) throw errno("EACCES"); assert.equal(filename, target); return target; },
    lstat: async filename => { assert.equal(filename, alias); return { isSymbolicLink: () => true }; },
    readlink: async filename => { assert.equal(filename, alias); return target; },
  }));
  assert.equal(resolved, target);
});

for (const code of ["EACCES", "EPERM"]) {
  test(`ordinary ${code} failures remain blocked instead of becoming absent paths`, async () => {
    const filename = path.join(root, "protected", "server.exe");
    const failure = errno(code);
    await assert.rejects(resolveReferencePath(filename, filesystem({
      realpath: async actual => { assert.equal(actual, filename); throw failure; },
      lstat: async actual => { assert.equal(actual, filename); return { isSymbolicLink: () => false }; },
    })), (error: unknown) => (error as NodeJS.ErrnoException).code === code);
  });
}

test("relative link targets use the canonical parent directory", async () => {
  const lexicalParent = path.join(root, "parent-alias", "commands");
  const canonicalParent = path.join(root, "canonical-parent", "commands");
  const alias = path.join(lexicalParent, "server.exe");
  const link = path.join("..", "workspace", "server.exe");
  const target = path.resolve(canonicalParent, link);
  const resolved = await resolveReferencePath(alias, filesystem({
    realpath: async filename => {
      if (filename === alias) throw errno("EACCES");
      if (filename === lexicalParent) return canonicalParent;
      assert.equal(filename, target);
      return target;
    },
    lstat: async filename => { assert.equal(filename, alias); return { isSymbolicLink: () => true }; },
    readlink: async filename => { assert.equal(filename, alias); return link; },
  }));
  assert.equal(resolved, target);
});

test("alias loops stop after a bounded number of filesystem operations", async () => {
  const first = path.join(root, "first.exe");
  const second = path.join(root, "second.exe");
  let reads = 0;
  const guard = new Error("Fixture recursion guard must not be reached");
  await assert.rejects(resolveReferencePath(first, filesystem({
    realpath: async filename => {
      if (++reads > 64) throw guard;
      assert.ok(filename === first || filename === second);
      throw errno("EACCES");
    },
    lstat: async filename => { assert.ok(filename === first || filename === second); return { isSymbolicLink: () => true }; },
    readlink: async filename => filename === first ? second : first,
  })), (error: unknown) => error !== guard && (error as NodeJS.ErrnoException).code === "ELOOP");
  assert.ok(reads <= 64);
});

test("long alias chains are rejected before exceeding the resolution bound", async () => {
  const aliases = Array.from({ length: 42 }, (_, index) => path.join(root, `alias-${index}.exe`));
  const target = path.join(root, "resolved-server.exe");
  let reads = 0;
  let targetResolved = false;
  await assert.rejects(resolveReferencePath(aliases[0]!, filesystem({
    realpath: async filename => {
      reads++;
      if (filename === target) { targetResolved = true; return target; }
      assert.ok(aliases.includes(filename));
      throw errno("EACCES");
    },
    lstat: async filename => { assert.ok(aliases.includes(filename)); return { isSymbolicLink: () => true }; },
    readlink: async filename => {
      const index = aliases.indexOf(filename);
      assert.ok(index >= 0);
      return aliases[index + 1] ?? target;
    },
  })), (error: unknown) => (error as NodeJS.ErrnoException).code === "ELOOP");
  assert.ok(reads <= 41);
  assert.equal(targetResolved, false);
});

for (const code of ["ENOENT", "ENOTDIR"]) {
  test(`${code} still represents an absent reference path`, async () => {
    const filename = path.join(root, "missing", "server.exe");
    assert.equal(await resolveReferencePath(filename, filesystem({
      realpath: async actual => { assert.equal(actual, filename); throw errno(code); },
    })), undefined);
  });
}

test("permission errors during alias inspection or target resolution do not authorize deletion", async () => {
  const alias = path.join(root, "WindowsApps", "server.exe");
  const target = path.join(root, "protected", "server.exe");
  for (const stage of ["lstat", "readlink", "target"] as const) {
    const fs = filesystem({
      realpath: async filename => { assert.ok(filename === alias || filename === target); throw errno("EACCES"); },
      lstat: async filename => { assert.ok(filename === alias || filename === target); if (stage === "lstat") throw errno("EPERM"); return { isSymbolicLink: () => filename === alias }; },
      readlink: async filename => { assert.equal(filename, alias); if (stage === "readlink") throw errno("EPERM"); return target; },
    });
    await assert.rejects(resolveReferencePath(alias, fs), (error: unknown) => ["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? ""));
  }
});

test("Windows named-pipe namespaces are recognized independently of host platform", () => {
  for (const value of [
    String.raw`\\.\pipe`, String.raw`\\.\pipe` + "\\", String.raw`\\.\pipe\workflows`,
    String.raw`\\.\PIPE\workflows\nested`, String.raw`\\server\pipe`, String.raw`\\server\pipe\workflows`,
    String.raw`\\SERVER\PiPe\workflows`,
  ]) assert.equal(isWindowsNamedPipe(value), true, `Expected a named-pipe namespace: ${value}`);
  for (const value of [
    "", "pipe", "pipe/server", String.raw`C:\pipe\server`, String.raw`\\server\share\pipe`,
    String.raw`\\.\pipeline\server`, String.raw`\\server\pipelines\server`,
    "https://example.invalid/pipe/server", path.join(root, "pipe", "server"),
  ]) assert.equal(isWindowsNamedPipe(value), false, `Expected an ordinary value: ${value}`);
});
