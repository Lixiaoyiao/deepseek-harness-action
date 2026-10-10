import { z } from "zod";
import { createHash } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sessionFormatCatalog } from "@deepseek-ai/dsh-session-format-catalog";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDshPrompt } from "../src/dsh/prompt.js";

import {
  exportSessionCheckpoint,
  importSessionCheckpoint,
  inspectStoredSession,
  SESSION_CHECKPOINT_LIMITS,
  SESSION_LOG_FILE,
  sessionPayloadMatchesManifest,
  validateSessionPayload,
} from "../src/session/checkpoint.js";
import type {
  SessionBinding,
  SessionCheckpoint,
  SessionManifestWithoutPayload,
  SessionRunIdentity,
} from "../src/session/contracts.js";

const now = Date.parse("2026-10-04T01:00:00.000Z");
const sessionId = "session-11111111-1111-4111-8111-111111111111";
const workspacePath = "/workspace";
const binding: SessionBinding = {
  repository: { id: 1, owner: "octo", repo: "repo" },
  workflow: { path: ".github/workflows/action.yml", jobId: "dsh", jobName: "DSH" },
  task: { kind: "issue", identity: "issue:17" },
  runtime: {
    dshVersion: "0.2.0-rc.2",
    mode: "controlled",
    compositionId: "controlled",
    containerImage: `node:24-bookworm@sha256:${"a".repeat(64)}`,
    extensionDigest: "b".repeat(64),
  },
  keyHash: "c".repeat(64),
};
const source: SessionRunIdentity = {
  runId: 42,
  runAttempt: 1,
  sourceSha: "d".repeat(40),
  actorId: 9,
  actorLogin: "maintainer",
  jobRunId: 43,
};
const manifest: SessionManifestWithoutPayload = {
  schemaVersion: 1,
  repository: binding.repository,
  workflow: {
    ...binding.workflow,
    runId: source.runId,
    runAttempt: 1,
    sourceSha: source.sourceSha,
  },
  task: binding.task,
  runtime: binding.runtime,
  issuer: { actorId: source.actorId, actorLogin: source.actorLogin, jobRunId: source.jobRunId },
  session: { keyHash: binding.keyHash, sessionId, generation: 1 },
  createdAt: new Date(now).toISOString(),
  expiresAt: new Date(now + 2 * 24 * 60 * 60 * 1000).toISOString(),
};

function header(overrides: Record<string, unknown> = {}): unknown {
  return {
    ...sessionFormatCatalog.encodeCurrentHeader(
      {
        version: 4,
        id: sessionId,
        createdAt: now,
        cwd: workspacePath,
        isSeeded: false,
        delegationDepth: 0,
      },
      0,
    ),
    ...overrides,
  };
}

function message(text = "Hello 世界", id = "message-1") {
  return { id, role: "user", content: [{ type: "text", text }], source: { kind: "user" } };
}

function settledEvents(): Record<string, unknown>[] {
  return [
    { type: "turn/start", seq: 0, time: now, data: { turn: 1 } },
    { type: "user/message", seq: 1, time: now + 1, data: message(), surfaceOp: "append" },
    { type: "turn/end", seq: 2, time: now + 2, data: { turn: 1, reason: { kind: "completed" } } },
  ];
}

function raw(rows: unknown[] = settledEvents(), first: unknown = header()): Buffer {
  // Preserve spacing: successful import/export must retain original physical bytes.
  return Buffer.from([first, ...rows].map((row) => JSON.stringify(row, null, 0)).join("\n") + "\n");
}

function opaque(data: unknown, seq = 0): Record<string, unknown> {
  return { type: "test/plugin-record", seq, time: now, data, ignorable: true };
}

function validate(payload = raw(), knownSecrets: readonly string[] = []) {
  return validateSessionPayload({ payload, sessionId, workspacePath, knownSecrets });
}

function checkpoint(payload = raw()): SessionCheckpoint {
  return {
    manifest: {
      ...manifest,
      payload: {
        file: "session.jsonl",
        bytes: payload.byteLength,
        sha256: createHash("sha256").update(payload).digest("hex"),
      },
    },
    payload,
  };
}

function attachment(type: "image" | "file") {
  const attachmentId = `sha256:${"a".repeat(64)}`;
  return type === "image"
    ? { type, attachment: { attachmentId, mediaType: "image/png", bytes: 68, width: 1, height: 1 } }
    : { type, attachment: { attachmentId, name: "document.pdf", bytes: 100 } };
}

const contentSlots = [
  "user",
  "system",
  "developer",
  "assistant",
  "tool",
  "ptc",
  "stream",
  "compaction-summary",
  "compaction-raw-output",
  "inbox",
] as const;
type ContentSlot = (typeof contentSlots)[number];

function contentFixture(slot: ContentSlot, block: unknown): Buffer {
  const user = message("Read the file", "user-1");
  const step: [string, unknown][] = [
    ["turn/start", { turn: 1 }],
    ["step/start", { turn: 1, step: 1 }],
    [
      "request/header",
      { header: { config: { provider: "fixture", model: "fixture" } }, reason: "initial" },
    ],
  ];
  const completed: [string, unknown] = ["turn/end", { turn: 1, reason: { kind: "completed" } }];
  const end: [string, unknown][] = [["step/end", { turn: 1, step: 1 }], completed];
  const assistant = {
    turn: 1,
    step: 1,
    message: {
      id: "assistant-1",
      role: "assistant",
      content: [block],
      source: { kind: "model", provider: "fixture", model: "fixture" },
    },
    stream: [],
  };
  let events: [string, unknown][];
  switch (slot) {
    case "user":
      events = [
        ["turn/start", { turn: 1 }],
        ["user/message", { ...user, content: [block] }],
        completed,
      ];
      break;
    case "system":
    case "developer":
      events = [
        ...step,
        ...(slot === "developer" ? [["user/message", user] as [string, unknown]] : []),
        [
          `${slot}/message`,
          {
            turn: 1,
            step: 1,
            message: {
              id: `${slot}-1`,
              role: slot,
              content: [block],
              source: { kind: slot === "system" ? "system-prompt" : "fixture" },
            },
          },
        ],
        ...end,
      ];
      break;
    case "assistant":
      events = [...step, ["user/message", user], ["assistant/message", assistant], ...end];
      break;
    case "tool":
    case "ptc":
      events = [
        ...step,
        ["user/message", user],
        [
          "assistant/message",
          {
            ...assistant,
            message: {
              ...assistant.message,
              content: [
                {
                  type: "tool-call",
                  id: "call-1",
                  name: slot === "ptc" ? "run_code" : "read_image",
                  arguments: "{}",
                },
              ],
            },
          },
        ],
        [
          "tool/call",
          {
            turn: 1,
            step: 1,
            callId: "call-1",
            name: slot === "ptc" ? "run_code" : "read_image",
            arguments: "{}",
          },
        ],
        ...(slot === "ptc"
          ? ([
              [
                "tool/ptc-dispatch-start",
                {
                  rootCallId: "call-1",
                  parentCallId: "call-1",
                  subCallId: "call-1:ptc:1",
                  name: "read_image",
                  arguments: {},
                },
              ],
              [
                "tool/ptc-dispatch",
                {
                  rootCallId: "call-1",
                  parentCallId: "call-1",
                  subCallId: "call-1:ptc:1",
                  name: "read_image",
                  arguments: {},
                  content: [block],
                  isError: false,
                },
              ],
            ] as [string, unknown][])
          : []),
        [
          "tool/result",
          {
            turn: 1,
            step: 1,
            message: {
              id: "result-1",
              role: "tool",
              toolCallId: "call-1",
              source: { kind: "tool", callId: "call-1" },
              content:
                slot === "ptc" ? [{ type: "text", text: "Nested invocation completed" }] : [block],
            },
          },
        ],
        ...end,
      ];
      break;
    case "stream":
      events = [
        ...step,
        [
          "assistant/attempt",
          {
            turn: 1,
            step: 1,
            stream: [
              { type: "chunk", time: now + 3, chunk: { type: "block-end", index: 0, block } },
            ],
          },
        ],
        ...end,
      ];
      break;
    case "compaction-summary":
    case "compaction-raw-output":
      events = [
        ["turn/start", { turn: 1 }],
        ["user/message", user],
        completed,
        ["compaction/start", { compactionId: "compact-1", turn: null }],
        [
          "compaction/summary",
          {
            compactionId: "compact-1",
            summary: slot === "compaction-summary" ? [block] : [{ type: "text", text: "summary" }],
            rawOutput:
              slot === "compaction-raw-output" ? [block] : [{ type: "text", text: "summary" }],
            shadowedRange: { start: 1, end: 1 },
            shadowedSeqs: [1],
            shadowedTokenCount: 1,
            provider: "fixture",
            model: "fixture",
          },
        ],
        ["user/message", { ...user, id: "summary-1" }],
        ["compaction/end", { compactionId: "compact-1", turn: null }],
      ];
      break;
    case "inbox":
      events = [
        [
          "agent/inbox/spliced",
          { target: "next-turn", start: 0, inserted: [{ ...user, content: [block] }] },
        ],
        [
          "agent/inbox/spliced",
          { target: "next-turn", start: 0, removedCount: 1, inserted: [], outcome: "canceled" },
        ],
      ];
      break;
  }
  return raw(
    events.map(([type, data], seq) => ({
      type,
      data,
      seq,
      time: now + seq,
      ...([
        "user/message",
        "system/message",
        "developer/message",
        "assistant/message",
        "tool/result",
      ].includes(type)
        ? { surfaceOp: "append" }
        : {}),
    })),
  );
}

function assertPublicCodecAccepts(payload: Buffer): void {
  const rows = payload
    .toString("utf8")
    .trimEnd()
    .split("\n")
    .map((line: string) => JSON.parse(line) as unknown);
  const restore = sessionFormatCatalog.createRestore(rows[0], {
    recovery: "strict",
    validation: "current",
  });
  for (const row of rows.slice(1)) restore.decodeRow(row);
  restore.finish();
}

const temporary: string[] = [];
afterEach(async () => {
  for (const root of temporary.splice(0)) await rm(root, { recursive: true, force: true });
});

async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dsh-session-checkpoint-test-"));
  temporary.push(root);
  return root;
}

async function stored(payload = raw()): Promise<{ root: string; log: string; session: string }> {
  const root = await directory();
  const session = join(root, "--workspace--", sessionId);
  await mkdir(session, { recursive: true });
  const log = join(session, SESSION_LOG_FILE);
  await writeFile(log, payload);
  return { root, log, session };
}

describe("genuine bounded Session persistence", () => {
  it("validates the released v4 codec and exact raw bytes", () => {
    const payload = raw();
    expect(validate(payload)).toEqual({
      sessionId,
      eventCount: 3,
      bytes: payload.length,
      sha256: createHash("sha256").update(payload).digest("hex"),
    });
    expect(sessionPayloadMatchesManifest(payload, checkpoint(payload).manifest)).toBe(true);
    expect(
      sessionPayloadMatchesManifest(
        Buffer.concat([payload, Buffer.from(" ")]),
        checkpoint(payload).manifest,
      ),
    ).toBe(false);
  });

  it("keeps optional external events without substituting an event projection", () => {
    const payload = raw([opaque({ retained: ["arbitrary", "plugin", "event"] })]);
    expect(validate(payload).eventCount).toBe(1);
  });

  it.each([
    '[header] task text with "unterminated prose',
    '{"example":true}\nThen ordinary text with "unterminated prose',
  ])("preserves ordinary container-prefixed task text in complete raw persistence", (text) => {
    const events = settledEvents();
    events[1] = { ...events[1], data: message(text) };
    expect(validate(raw(events)).eventCount).toBe(3);
  });

  it("preserves the current rendered Controller prompt and its ordinary text context", () => {
    const text = '[header] task text with "unterminated prose';
    const packet = JSON.stringify({ body: text });
    const rendered = buildDshPrompt({
      operation: "task",
      prompt: packet,
      trustedInstructions: text,
      trust: "trusted-read",
    });
    expect(rendered.startsWith("<")).toBe(true);
    expect(rendered.endsWith(packet)).toBe(true);
    const events = settledEvents();
    events[1] = { ...events[1], data: message(rendered) };
    // The exact rendered terminal context is valid JSON containing ordinary prose.
    // It must also remain readable in durable plugin metadata or tool output.
    events.push(opaque({ renderedContext: packet }, 3));
    expect(validate(raw(events)).eventCount).toBe(4);
  });

  it("retains nested valid JSON credential and duplicate-key refusal", () => {
    expect(() => validate(raw([opaque({ argument: '{"password":"short-value"}' })]))).toThrow(
      /credential field/u,
    );
    expect(() => validate(raw([opaque({ argument: '{"value":1,"value":2}' })]))).toThrow(
      /duplicate JSON keys \(outer JSONL record 1, embedded JSON string\)/u,
    );
    expect(() => validate(Buffer.from(raw([]).toString() + '{"unterminated\n'))).toThrow(
      /malformed JSON \(outer JSONL record 1\)/u,
    );
  });

  it("rejects complete deeply nested embedded JSON before parsing its object graph", () => {
    const embedded = "[".repeat(1000) + "0" + "]".repeat(1000);
    const payload = raw([opaque({ argument: embedded })]);
    const parse = vi.spyOn(JSON, "parse");
    try {
      expect(() => validate(payload)).toThrow(
        /depth limit \(outer JSONL record 1, embedded JSON string\)/u,
      );
      expect(parse.mock.calls.some(([input]) => input === embedded)).toBe(false);
    } finally {
      parse.mockRestore();
    }
    // The same bracket-heavy content followed by prose is ordinary text.
    expect(
      validate(raw([opaque({ argument: embedded + '\nExplanation with "unclosed prose' })]))
        .eventCount,
    ).toBe(1);
  });

  it.each([
    "{}",
    "[]",
    '[true,false,null,-1,2.5,3e-4,{"value":"ordinary"}]',
    '{"list":[{"text":"quote \\" and unicode \\u4e16"}],"empty":{}}',
  ])("accepts complete embedded JSON without losing its raw bytes", (embedded) => {
    expect(() => JSON.parse(embedded) as unknown).not.toThrow();
    const payload = raw([opaque({ argument: embedded })]);
    expect(validate(payload).sha256).toBe(createHash("sha256").update(payload).digest("hex"));
  });

  it.each([
    ["future version", { version: 999 }],
    ["old version", { version: 3 }],
    ["wrong id", { id: "other-session" }],
    ["wrong cwd", { cwd: "/other-workspace" }],
    ["missing cwd", { cwd: undefined }],
    ["child origin", { origin: "subagent" }],
    ["forked parent", { parentSession: "other-session" }],
    ["inherited prefix", { isSeeded: true }],
    ["delegation", { delegationDepth: 1 }],
    ["preset", { agentPreset: "other-composition" }],
    ["retired policy field", { sandboxMode: "read-only" }],
  ])("rejects %s", (_label, override) => {
    expect(() => validate(raw([], header(override)))).toThrow(/incompatible|unsupported/iu);
  });

  it.each([
    ["invalid UTF8", Buffer.from([0xff, 0x0a])],
    ["truncated final record", raw().subarray(0, raw().length - 1)],
    ["empty row", Buffer.concat([raw(), Buffer.from("\n")])],
    ["malformed JSON", Buffer.from("{bad}\n")],
    ["wrong sequence", raw([opaque({}, 100_000_000)])],
    ["unknown required event", raw([{ type: "future/required", seq: 0, time: now, data: {} }])],
  ])("rejects %s with safe diagnostics", (_label, payload) => {
    expect(() => validate(payload)).toThrow(/Session checkpoint/u);
  });

  it("rejects duplicates, prototypes and unsafe numeric JSON before decoding", () => {
    expect(() =>
      validate(
        Buffer.from(
          raw([]).toString() +
            '{"type":"test/plugin-record","seq":0,"time":1,"data":{"a":1,"a":2},"ignorable":true}\n',
        ),
      ),
    ).toThrow(/duplicate JSON keys/u);
    expect(() =>
      validate(raw([opaque(JSON.parse('{"__proto__":{"polluted":true}}') as unknown)])),
    ).toThrow(/unsafe JSON property/u);
    expect(() => validate(raw([opaque({ value: Number.MAX_SAFE_INTEGER + 1 })]))).toThrow(
      /unsafe JSON number/u,
    );
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
  });

  it("bounds total bytes, row bytes, records, nested depth, arrays and decoded references", () => {
    expect(() => validate(Buffer.alloc(SESSION_CHECKPOINT_LIMITS.payloadBytes + 1))).toThrow(
      /4 MiB/u,
    );
    expect(() =>
      validate(raw([opaque({ text: "x".repeat(SESSION_CHECKPOINT_LIMITS.rowBytes) })])),
    ).toThrow(/oversized JSONL/u);
    expect(() => validate(Buffer.from("{}\n".repeat(SESSION_CHECKPOINT_LIMITS.rows + 1)))).toThrow(
      /record count/u,
    );
    const nested =
      "[".repeat(SESSION_CHECKPOINT_LIMITS.depth + 1) +
      "0" +
      "]".repeat(SESSION_CHECKPOINT_LIMITS.depth + 1);
    expect(() => validate(Buffer.from(raw([]).toString() + nested + "\n"))).toThrow(/depth limit/u);
    expect(() =>
      validate(
        raw([
          opaque({
            items: Array.from({ length: SESSION_CHECKPOINT_LIMITS.arrayItems + 1 }, () => null),
          }),
        ]),
      ),
    ).toThrow(/array limit/u);
    const references = [{ ...opaque({}, 0), sourceEventSeqs: [[0, Number.MAX_SAFE_INTEGER]] }];
    expect(() => validate(raw(references))).toThrow(/reference ranges/u);
  });

  it("bounds cumulative JSON complexity", () => {
    const events = Array.from({ length: 700 }, (_, index) =>
      opaque({ values: Array.from({ length: 300 }, () => 0) }, index),
    );
    expect(() => validate(raw(events))).toThrow(/complexity limit/u);
  });

  it("bounds cumulative compact sequence expansion before the released decoder allocates it", () => {
    const events = Array.from({ length: 650 }, (_, index) => ({
      ...opaque({}, index),
      sourceEventSeqs: index === 0 ? [] : [[0, index - 1]],
    }));
    expect(raw(events).byteLength).toBeLessThan(128 * 1024);
    expect(() => validate(raw(events))).toThrow(/expanded event reference limit/u);
  });
});

describe("portable text Session admission", () => {
  it.each(
    contentSlots.flatMap((slot) => (["image", "file"] as const).map((type) => ({ slot, type }))),
  )(
    "refuses released typed $type references in the $slot content slot without echoing reference data",
    ({ slot, type }) => {
      const block = attachment(type);
      const payload = contentFixture(slot, block);
      assertPublicCodecAccepts(payload);
      let diagnostic = "";
      try {
        validate(payload);
      } catch (error: unknown) {
        diagnostic = error instanceof Error ? error.message : "";
      }
      expect(diagnostic).toContain("nonportable image or file attachment content");
      expect(diagnostic).not.toContain(block.attachment.attachmentId);
      expect(diagnostic).not.toContain("document.pdf");
    },
  );

  it.each(["image", "file"] as const)(
    "refuses settled native tool %s references on collection, export and import without rewriting history",
    async (type) => {
      const payload = contentFixture("tool", attachment(type));
      assertPublicCodecAccepts(payload);
      const fixture = await stored(payload);
      await expect(
        inspectStoredSession({
          persistenceRoot: fixture.root,
          sessionId,
          workspacePath,
          knownSecrets: [],
        }),
      ).rejects.toThrow(/nonportable image or file/u);
      await expect(
        exportSessionCheckpoint({
          persistenceRoot: fixture.root,
          manifest,
          workspacePath,
          knownSecrets: [],
          now,
        }),
      ).rejects.toThrow(/nonportable image or file/u);
      const destination = await directory();
      await expect(
        importSessionCheckpoint({
          persistenceRoot: destination,
          checkpoint: checkpoint(payload),
          binding,
          source,
          workspacePath,
          knownSecrets: [],
          now,
        }),
      ).rejects.toThrow(/nonportable image or file/u);
      expect(await readFile(fixture.log)).toEqual(payload);
    },
  );

  it.each(["image", "file"] as const)(
    "preserves %s-shaped ordinary JSON text, tool business metadata and opaque events",
    (type) => {
      const block = attachment(type);
      expect(
        validate(contentFixture("user", { type: "text", text: JSON.stringify(block) })).eventCount,
      ).toBe(3);
      const payload = contentFixture("tool", {
        type: "text",
        text: "document.pdf is a plain filename",
      });
      const rows = payload
        .toString("utf8")
        .trimEnd()
        .split("\n")
        .map((line: string) => z.record(z.string(), z.unknown()).parse(JSON.parse(line)));
      const result = rows.find((row) => row.type === "tool/result");
      if (result === undefined) throw new Error("Fixture must contain a tool result");
      const data = z.record(z.string(), z.unknown()).parse(result.data);
      result.data = { ...data, meta: { content: [block], business: block } };
      const withMetadata = Buffer.from(rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
      expect(validate(withMetadata).eventCount).toBe(9);
      expect(validate(raw([opaque({ content: [block], business: block })])).eventCount).toBe(1);
    },
  );
});

describe("credential export refusal", () => {
  const secret = "controller-key-never-export-1234";
  it.each([
    ["Controller", secret],
    ["extension", "actual-extension-secret-1234"],
    ["worker proxy", "worker-ephemeral-proxy-1234"],
  ])("refuses known %s credentials without echoing them", (_label, value) => {
    let message = "";
    try {
      validate(raw([opaque({ arbitrary: value })]), [
        secret,
        "actual-extension-secret-1234",
        "worker-ephemeral-proxy-1234",
      ]);
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : "";
    }
    expect(message).toMatch(/credential material/u);
    expect(message).not.toContain(value);
  });

  it("detects JSON escapes and common encoding of known credentials", () => {
    const encoded = raw([opaque({ arbitrary: secret })])
      .toString()
      .replace(
        secret,
        secret
          .split("")
          .map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)
          .join(""),
      );
    expect(() => validate(Buffer.from(encoded), [secret])).toThrow(/credential material/u);
    expect(() =>
      validate(raw([opaque({ arbitrary: Buffer.from(secret).toString("base64") })]), [secret]),
    ).toThrow(/credential material/u);
  });

  it("refuses Base64 and URL encodings of short known credentials in opaque events", () => {
    const short = "abc";
    const encoded = Buffer.from(short, "utf8").toString("base64");
    expect(encoded).toBe("YWJj");
    const payload = raw([opaque({ arbitrary: encoded })]);
    expect(payload.toString("utf8")).not.toContain(short);
    expect(() => validate(payload, [short])).toThrow(/credential material/u);
    expect(() =>
      validate(raw([opaque({ arbitrary: encodeURIComponent("a/b") })]), ["a/b"]),
    ).toThrow(/credential material/u);
  });

  it.each([
    { api_key: "unrecognized-but-present" },
    { token: "unknown-short-value" },
    { authToken: "unknown-short-value" },
    { GITHUB_TOKEN: "unknown-short-value" },
    { Authorization: "short-secret" },
    { nested: JSON.stringify({ password: "unrecognized-but-present" }) },
    { arbitrary: `ghp_${"a".repeat(36)}` },
    { arbitrary: `github_pat_${"a".repeat(60)}` },
    { arbitrary: `sk-${"a".repeat(32)}` },
    { arbitrary: "-----BEGIN RSA PRIVATE KEY-----\nprivate\n-----END RSA PRIVATE KEY-----" },
  ])("refuses credential fields and recognized credential formats", (data) => {
    expect(() => validate(raw([opaque(data)]))).toThrow(/credential/u);
  });

  it("does not mistake credential parameter schemas or permission events for credentials", () => {
    expect(
      validate(
        raw([
          opaque({
            properties: { api_key: { type: "string", description: "credential parameter" } },
          }),
        ]),
      ).eventCount,
    ).toBe(1);
  });
});

describe("settled Session admission", () => {
  it("refuses unfinished turns and requests", () => {
    expect(() => validate(raw(settledEvents().slice(0, 2)))).toThrow(/not settled/u);
    expect(() =>
      validate(
        raw([
          settledEvents()[0],
          { type: "step/start", seq: 1, time: now, data: { turn: 1, step: 1 } },
          {
            type: "request/header",
            seq: 2,
            time: now,
            data: {
              header: { config: { provider: "fixture", model: "fixture" } },
              reason: "initial",
            },
          },
        ]),
      ),
    ).toThrow(/not settled/u);
  });

  it.each(["next-turn", "next-step"])(
    "refuses pending %s input and accepts explicitly emptied inbox",
    (target) => {
      const pending = {
        type: "agent/inbox/spliced",
        seq: 0,
        time: now,
        data: { target, start: 0, inserted: [message("pending")] },
      };
      expect(() => validate(raw([pending]))).toThrow(/not settled/u);
      const cleared = {
        type: "agent/inbox/spliced",
        seq: 1,
        time: now,
        data: { target, start: 0, removedCount: 1, inserted: [], outcome: "canceled" },
      };
      expect(validate(raw([pending, cleared])).eventCount).toBe(2);
    },
  );

  it("refuses malformed and duplicate persisted inbox entries", () => {
    const row = {
      type: "agent/inbox/spliced",
      seq: 0,
      time: now,
      data: { target: "next-turn", start: 0, inserted: [message(), message()] },
    };
    expect(() => validate(raw([row]))).toThrow(/duplicate pending/u);
    row.data.start = 2;
    expect(() => validate(raw([row]))).toThrow(/inbox bounds/u);
  });

  it("refuses unsettled out-of-turn compaction and approval", () => {
    expect(() =>
      validate(
        raw([
          {
            type: "compaction/start",
            seq: 0,
            time: now,
            data: { compactionId: "compaction-1", turn: null },
          },
        ]),
      ),
    ).toThrow(/not settled/u);
    expect(() =>
      validate(
        raw([
          {
            type: "approval/asked",
            seq: 0,
            time: now,
            data: { id: "approval-1", toolName: "fixture" },
          },
        ]),
      ),
    ).toThrow(/not settled/u);
  });
});

describe("dedicated physical storage and provenance", () => {
  it.each(["controlled", "native"] as const)(
    "losslessly exports/imports %s to a fresh storage root",
    async (mode) => {
      const fixture = await stored();
      await writeFile(join(fixture.session, "session.lock"), "");
      const current = { ...manifest, runtime: { ...manifest.runtime, mode } };
      const exported = await exportSessionCheckpoint({
        persistenceRoot: fixture.root,
        manifest: current,
        workspacePath,
        knownSecrets: [],
        now,
      });
      expect(Buffer.from(exported.payload)).toEqual(raw());
      const destination = await directory();
      const inspected = await importSessionCheckpoint({
        persistenceRoot: destination,
        checkpoint: exported,
        binding: { ...binding, runtime: current.runtime },
        source,
        workspacePath,
        knownSecrets: [],
        now,
      });
      expect(inspected.eventCount).toBe(3);
      expect(
        await readFile(join(destination, "--workspace--", sessionId, SESSION_LOG_FILE)),
      ).toEqual(raw());
      expect(
        await inspectStoredSession({
          persistenceRoot: destination,
          sessionId,
          workspacePath,
          knownSecrets: [],
        }),
      ).toEqual(inspected);
      expect(await readFile(join(fixture.session, "session.lock"), "utf8")).toBe("");
    },
  );

  it.each([
    "session.v3.jsonl",
    "session.v999.jsonl",
    "session.v4.jsonl.zstd",
    "private.env",
    "session.v4.jsonl.tmp",
  ])("refuses unexpected or multiple generation filename %s", async (filename) => {
    const fixture = await stored();
    await writeFile(join(fixture.session, filename), "unexpected");
    await expect(
      inspectStoredSession({
        persistenceRoot: fixture.root,
        sessionId,
        workspacePath,
        knownSecrets: [],
      }),
    ).rejects.toThrow(/additional|incompatible/u);
  });

  it("refuses missing logs, additional sessions/projects and nonempty leases", async () => {
    const missing = await stored();
    await rm(missing.log);
    await expect(
      inspectStoredSession({
        persistenceRoot: missing.root,
        sessionId,
        workspacePath,
        knownSecrets: [],
      }),
    ).rejects.toThrow(/missing/u);
    const extra = await stored();
    await mkdir(join(extra.root, "--workspace--", "other-session"));
    await expect(
      inspectStoredSession({
        persistenceRoot: extra.root,
        sessionId,
        workspacePath,
        knownSecrets: [],
      }),
    ).rejects.toThrow(/additional/u);
    const lease = await stored();
    await writeFile(join(lease.session, "session.lock"), "unexpected");
    await expect(
      inspectStoredSession({
        persistenceRoot: lease.root,
        sessionId,
        workspacePath,
        knownSecrets: [],
      }),
    ).rejects.toThrow(/lease/u);
  });

  it("refuses redirected directory components and hardlinked raw logs", async () => {
    const fixture = await stored();
    const parent = await directory();
    const redirected = join(parent, "redirected");
    await symlink(fixture.root, redirected, process.platform === "win32" ? "junction" : "dir");
    await expect(
      inspectStoredSession({
        persistenceRoot: redirected,
        sessionId,
        workspacePath,
        knownSecrets: [],
      }),
    ).rejects.toThrow(/regular directory|redirected/u);
    await link(fixture.log, join(parent, "hardlink.jsonl"));
    await expect(
      inspectStoredSession({
        persistenceRoot: fixture.root,
        sessionId,
        workspacePath,
        knownSecrets: [],
      }),
    ).rejects.toThrow(/regular file/u);
  });

  it.each(["../outside", "x/y", "x\\y", ".", "..", "NUL", "session."])(
    "refuses unsafe identifier %s before filesystem access",
    async (unsafe) => {
      await expect(
        inspectStoredSession({
          persistenceRoot: "does-not-exist",
          sessionId: unsafe,
          workspacePath,
          knownSecrets: [],
        }),
      ).rejects.toThrow(/unsafe Session identifier/u);
    },
  );

  it("verifies corruption and refuses overwriting initialized storage", async () => {
    const destination = await directory();
    const changed = checkpoint();
    const damaged = { ...changed, payload: raw([opaque({ changed: true })]) };
    await expect(
      importSessionCheckpoint({
        persistenceRoot: destination,
        checkpoint: damaged,
        binding,
        source,
        workspacePath,
        knownSecrets: [],
        now,
      }),
    ).rejects.toThrow(/integrity/u);
    await writeFile(join(destination, "marker"), "preserved");
    await expect(
      importSessionCheckpoint({
        persistenceRoot: destination,
        checkpoint: changed,
        binding,
        source,
        workspacePath,
        knownSecrets: [],
        now,
      }),
    ).rejects.toThrow(/additional/u);
    expect(await readFile(join(destination, "marker"), "utf8")).toBe("preserved");
  });

  it("revalidates expiry, generation and repository/task/source/runtime binding before writing", async () => {
    const destination = await directory();
    const initial = checkpoint();
    const importOptions = {
      persistenceRoot: destination,
      checkpoint: initial,
      binding,
      source,
      workspacePath,
      knownSecrets: [],
      now,
    };
    await expect(
      importSessionCheckpoint({ ...importOptions, now: now + 3 * 24 * 60 * 60 * 1000 }),
    ).rejects.toThrow(/expired/u);
    await expect(
      importSessionCheckpoint({
        ...importOptions,
        checkpoint: {
          ...initial,
          manifest: {
            ...initial.manifest,
            session: { ...initial.manifest.session, generation: 0 },
          },
        },
      }),
    ).rejects.toThrow(/malformed/u);
    await expect(
      importSessionCheckpoint({
        ...importOptions,
        binding: { ...binding, repository: { ...binding.repository, id: 2 } },
      }),
    ).rejects.toThrow(/binding/u);
    await expect(
      importSessionCheckpoint({
        ...importOptions,
        binding: { ...binding, task: { ...binding.task, identity: "issue:18" } },
      }),
    ).rejects.toThrow(/binding/u);
    await expect(
      importSessionCheckpoint({ ...importOptions, source: { ...source, runId: 99 } }),
    ).rejects.toThrow(/binding/u);
    await expect(
      importSessionCheckpoint({
        ...importOptions,
        binding: { ...binding, runtime: { ...binding.runtime, extensionDigest: "e".repeat(64) } },
      }),
    ).rejects.toThrow(/binding/u);
  });

  it("scans manifest labels for actual credentials too", async () => {
    const fixture = await stored();
    const value = "maintainer-label-credential-1234";
    await expect(
      exportSessionCheckpoint({
        persistenceRoot: fixture.root,
        manifest: { ...manifest, workflow: { ...manifest.workflow, jobName: value } },
        workspacePath,
        knownSecrets: [value],
        now,
      }),
    ).rejects.toThrow(/credential/u);
  });
});
