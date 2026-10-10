import { z } from "zod";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const fixtureKey = "dsh-e2e-integrity-fixture-key";
const callId = "integrity-bash-once";
const prompt = { role: "user", content: "DSH_E2E_INTEGRITY_FIXTURE" };

async function fixture(protocol: "chat" | "messages" = "chat") {
  const root = await mkdtemp(join(tmpdir(), "dsh-integrity-fixture-"));
  const audit = join(root, "audit.jsonl");
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../.github/e2e/integrity-llm.mjs", import.meta.url))],
    {
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        DSH_E2E_INTEGRITY_AUDIT: audit,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const close = async () => {
    child.kill();
    await closed;
    await rm(root, { recursive: true, force: true });
  };
  try {
    const line = await new Promise<string>((resolve, reject) => {
      // Match the Docker fixture budget; cold Windows process startup can be
      // delayed by endpoint scanning while the full suite runs concurrently.
      const timer = setTimeout(() => reject(new Error("Fixture startup timed out")), 20_000);
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes("\n")) {
          clearTimeout(timer);
          resolve(output.split("\n")[0] ?? "");
        }
      });
      child.once("error", reject);
      child.once("close", () => {
        clearTimeout(timer);
        reject(new Error("Fixture exited before its endpoint was available"));
      });
    });
    const { baseUrl } = z.looseObject({ baseUrl: z.string() }).parse(JSON.parse(line));
    const request = (body: unknown, key = fixtureKey) =>
      fetch(`${baseUrl}/${protocol === "messages" ? "v1/messages" : "chat/completions"}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          ...(protocol === "messages" ? { "x-api-key": key } : {}),
        },
        body: JSON.stringify(body),
      });
    return { request, audit, close };
  } catch (error) {
    await close();
    throw error;
  }
}

describe("deterministic integrity model fixture", () => {
  it("issues exactly one Bash call and requires its matching completion before a final result", async () => {
    const server = await fixture();
    try {
      const first = await server.request({
        messages: [prompt],
        tools: [{ function: { name: "bash" } }],
      });
      const result = z
        .looseObject({
          choices: z.array(
            z.looseObject({
              finish_reason: z.string(),
              message: z.looseObject({
                tool_calls: z.array(
                  z.looseObject({
                    id: z.string(),
                    function: z.looseObject({ name: z.string(), arguments: z.string() }),
                  }),
                ),
              }),
            }),
          ),
        })
        .parse(await first.json());
      expect(first.status).toBe(200);
      expect(result.choices[0]?.finish_reason).toBe("tool_calls");
      expect(result.choices[0]?.message.tool_calls).toHaveLength(1);
      const tool = result.choices[0]?.message.tool_calls[0];
      expect(tool).toMatchObject({ id: callId, function: { name: "bash" } });
      expect(JSON.parse(tool?.function.arguments ?? "null")).toEqual({
        command:
          "printf 'process.exit(0);\\n' > scripts/verify-dsh-config.mjs && printf 'DSH_E2E_INTEGRITY_WEAKENED\\n'",
        description: "Weaken only the disposable validation fixture entrypoint",
        timeoutMs: 10_000,
      });
      const second = await server.request({
        messages: [
          prompt,
          { role: "tool", tool_call_id: callId, content: "DSH_E2E_INTEGRITY_WEAKENED\n" },
        ],
      });
      const final = z
        .looseObject({
          choices: z.array(
            z.looseObject({
              finish_reason: z.string(),
              message: z.looseObject({ content: z.string() }),
            }),
          ),
        })
        .parse(await second.json());
      expect(second.status).toBe(200);
      expect(final.choices[0]?.finish_reason).toBe("stop");
      expect(JSON.parse(final.choices[0]?.message.content ?? "null")).toMatchObject({
        protocolVersion: 1,
        operation: "task",
        state: "final",
        findings: [],
      });
      expect(await readFile(server.audit, "utf8")).toBe(
        ["bash-issued", "bash-observed"]
          .map((phase) => JSON.stringify({ phase, tool: "bash", callId }) + "\n")
          .join(""),
      );
      expect((await server.request({ messages: [prompt] })).status).toBe(422);
    } finally {
      await server.close();
    }
  });

  it("rejects other credentials and missing task/tool identity without consuming the Bash step", async () => {
    const server = await fixture();
    try {
      expect((await server.request({}, "must-not-send-a-real-key")).status).toBe(403);
      expect(
        (await server.request({ messages: [{ role: "user", content: "other task" }] })).status,
      ).toBe(422);
      expect((await server.request({ messages: [prompt], tools: [] })).status).toBe(422);
      const issued = await server.request({
        messages: [prompt],
        tools: [{ function: { name: "bash" } }],
      });
      expect(issued.status).toBe(200);
      await issued.arrayBuffer();
      expect(
        (
          await server.request({
            messages: [prompt, { role: "tool", tool_call_id: callId, content: "command failed" }],
          })
        ).status,
      ).toBe(422);
      const repeated = {
        role: "tool",
        tool_call_id: callId,
        content: "DSH_E2E_INTEGRITY_WEAKENED",
      };
      expect((await server.request({ messages: [prompt, repeated, repeated] })).status).toBe(422);
      expect(
        (
          await server.request({
            messages: [
              prompt,
              { role: "tool", tool_call_id: "other-call", content: "DSH_E2E_INTEGRITY_WEAKENED" },
            ],
          })
        ).status,
      ).toBe(422);
      expect(await readFile(server.audit, "utf8")).toBe(
        JSON.stringify({ phase: "bash-issued", tool: "bash", callId }) + "\n",
      );
    } finally {
      await server.close();
    }
  });

  it("streams the tool call using the real DSH completion transport", async () => {
    const server = await fixture();
    try {
      const response = await server.request({
        messages: [prompt],
        tools: [{ function: { name: "bash" } }],
        stream: true,
      });
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      const events = (await response.text()).trim().split("\n\n");
      expect(events).toHaveLength(3);
      expect(events[0]).toContain('"id":"integrity-bash-once"');
      expect(events[0]).toContain('"name":"bash"');
      expect(events[1]).toContain('"finish_reason":"tool_calls"');
      expect(events[2]).toBe("data: [DONE]");
    } finally {
      await server.close();
    }
  });

  it.each([false, true])(
    "preserves one Bash call and matching Messages feedback (stream=%s)",
    async (stream) => {
      const server = await fixture("messages");
      const messagesPrompt = { role: "user", content: [{ type: "text", text: prompt.content }] };
      const readMessage = async (response: Response) => {
        expect(response.status).toBe(200);
        if (!stream)
          return z
            .looseObject({
              content: z.array(
                z.looseObject({
                  type: z.string(),
                  id: z.string().optional(),
                  name: z.string().optional(),
                  input: z.unknown().optional(),
                  text: z.string().optional(),
                }),
              ),
              stop_reason: z.string(),
            })
            .parse(await response.json());
        expect(response.headers.get("content-type")).toBe("text/event-stream");
        const frames = (await response.text()).trim().split("\n\n");
        const events = frames.map((frame) => {
          const [name, data] = frame.split("\n");
          const event = z
            .looseObject({
              type: z.string(),
              content_block: z
                .looseObject({
                  type: z.string(),
                  id: z.string().optional(),
                  name: z.string().optional(),
                })
                .optional(),
              delta: z
                .looseObject({
                  partial_json: z.string().optional(),
                  text: z.string().optional(),
                  stop_reason: z.string().optional(),
                })
                .optional(),
            })
            .parse(JSON.parse(data?.slice("data: ".length) ?? "null"));
          expect(name).toBe(`event: ${event.type}`);
          return event;
        });
        expect(events.map((event) => event.type)).toEqual([
          "message_start",
          "content_block_start",
          "content_block_delta",
          "content_block_stop",
          "message_delta",
          "message_stop",
        ]);
        const block = events[1]?.content_block;
        const delta = events[2]?.delta;
        return {
          content: [
            {
              ...block,
              type: block?.type ?? "",
              ...(block?.type === "tool_use"
                ? { input: JSON.parse(delta?.partial_json ?? "null") as unknown }
                : { text: delta?.text }),
            },
          ],
          stop_reason: events[4]?.delta?.stop_reason,
        };
      };
      try {
        expect((await server.request({}, "different-key")).status).toBe(403);
        expect(
          (await server.request({ messages: [messagesPrompt], system: fixtureKey })).status,
        ).toBe(422);
        expect(
          (
            await server.request({
              messages: [messagesPrompt],
              tools: [{ function: { name: "bash" } }],
            })
          ).status,
        ).toBe(422);
        const issued = await readMessage(
          await server.request({
            messages: [messagesPrompt],
            tools: [{ name: "bash", input_schema: { type: "object" } }],
            stream,
          }),
        );
        expect(issued.stop_reason).toBe("tool_use");
        expect(issued.content).toHaveLength(1);
        expect(issued.content[0]).toMatchObject({ type: "tool_use", id: callId, name: "bash" });
        const assistant = { role: "assistant", content: issued.content };
        const feedback = {
          type: "tool_result",
          tool_use_id: callId,
          content: [{ type: "text", text: "DSH_E2E_INTEGRITY_WEAKENED\n" }],
        };
        for (const invalidHistory of [
          [messagesPrompt, { role: "user", content: [feedback] }],
          [messagesPrompt, assistant, { role: "user", content: [feedback, feedback] }],
          [
            messagesPrompt,
            assistant,
            { role: "user", content: [{ ...feedback, tool_use_id: "wrong-call" }] },
          ],
          [
            messagesPrompt,
            assistant,
            { role: "user", content: [{ ...feedback, content: "command failed" }] },
          ],
        ]) {
          expect((await server.request({ messages: invalidHistory, stream })).status).toBe(422);
        }
        const final = await readMessage(
          await server.request({
            messages: [messagesPrompt, assistant, { role: "user", content: [feedback] }],
            stream,
          }),
        );
        expect(final.stop_reason).toBe("end_turn");
        const finalBlock = final.content[0];
        expect(
          JSON.parse(finalBlock && "text" in finalBlock ? (finalBlock.text ?? "null") : "null"),
        ).toMatchObject({
          protocolVersion: 1,
          operation: "task",
          state: "final",
          findings: [],
        });
        expect(await readFile(server.audit, "utf8")).toBe(
          ["bash-issued", "bash-observed"]
            .map((phase) => JSON.stringify({ phase, tool: "bash", callId }) + "\n")
            .join(""),
        );
        expect((await server.request({ messages: [messagesPrompt], stream })).status).toBe(422);
      } finally {
        await server.close();
      }
    },
  );
});
