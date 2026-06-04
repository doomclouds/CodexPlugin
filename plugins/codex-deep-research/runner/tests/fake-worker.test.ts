import { describe, expect, it } from "vitest";
import { FakeWorkerClient } from "../src/workers/fake-worker.js";

describe("FakeWorkerClient", () => {
  it("returns queued fixture results", async () => {
    const worker = new FakeWorkerClient([{ ok: true }]);
    await expect(worker.run({ label: "scope", prompt: "test", schemaName: "ScopeSchema" })).resolves.toEqual({
      ok: true,
    });
  });
});
