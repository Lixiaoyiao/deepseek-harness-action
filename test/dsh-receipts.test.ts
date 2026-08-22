import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readToolReceipts } from "../src/dsh/receipts.js";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map(async (path) => rm(path, { force: true, recursive: true })),
  );
});

describe("DSH receipt ranges", () => {
  it("reads only the current turn range and retains first-seen call order", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-receipts-test-"));
    temporaryPaths.push(root);
    const path = join(root, "receipts.jsonl");
    const previousTurn = "not-json-from-an-already-reconciled-turn\n";
    const events = [
      {
        schemaVersion: 1,
        phase: "started",
        callId: "first",
        id: "workspace.read",
        runtimeName: "read",
        provider: "builtin",
        counted: true,
        ok: false,
        durationMs: 0,
        code: "ACTION_TOOL_INCOMPLETE",
      },
      {
        schemaVersion: 1,
        phase: "completed",
        callId: "second",
        id: "mcp.remote.search",
        runtimeName: "remote_search",
        provider: "mcp",
        counted: false,
        ok: false,
        durationMs: 2,
        code: "ACTION_TOOL_DENIED",
      },
      {
        schemaVersion: 1,
        phase: "completed",
        callId: "first",
        id: "workspace.read",
        runtimeName: "read",
        provider: "builtin",
        counted: true,
        ok: true,
        durationMs: 3,
      },
    ];
    await writeFile(
      path,
      `${previousTurn}${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );

    const receipts = await readToolReceipts(path, Buffer.byteLength(previousTurn));
    expect(receipts.map(({ callId }) => callId)).toEqual(["first", "second"]);
    expect(receipts).toMatchObject([
      { callId: "first", counted: true, completed: true, ok: true },
      { callId: "second", counted: false, completed: true, ok: false },
    ]);
  });
});
