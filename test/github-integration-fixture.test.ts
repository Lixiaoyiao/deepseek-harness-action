import { z } from "zod";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const fixtureKey = "dsh-github-fixture-test-key";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dsh-github-fixture-"));
  const audit = join(root, "audit.jsonl");
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../.github/e2e/github-integration-llm.mjs", import.meta.url))],
    {
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        DSH_E2E_GITHUB_AUDIT: audit,
        DSH_E2E_FIXTURE_KEY: fixtureKey,
        DSH_E2E_ISSUE_LABEL: "fixture-label",
        DSH_E2E_ISSUE_ASSIGNEE: "fixture-assignee",
        DSH_E2E_PULL_TITLE: "fixture pull title",
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
    const endpoint = await new Promise<string>((resolve, reject) => {
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
    return { ...z.looseObject({ origin: z.string() }).parse(JSON.parse(endpoint)), audit, close };
  } catch (error) {
    await close();
    throw error;
  }
}

describe("trusted GitHub integration provider fixture", () => {
  it.each(["chat/completions", "v1/messages"])(
    "preserves typed routes and the title-call boundary with %s",
    async (endpoint) => {
      const server = await fixture();
      const messagesProtocol = endpoint === "v1/messages";
      try {
        const request = async (route: string, title = false) => {
          const response = await fetch(`${server.origin}/${route}/${endpoint}`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${fixtureKey}`,
              "content-type": "application/json",
              ...(messagesProtocol ? { "x-api-key": fixtureKey } : {}),
            },
            body: JSON.stringify({
              system: [{ type: "text", text: "Trusted fixture system marker" }],
              messages: [
                {
                  role: "user",
                  content: title
                    ? "Generate the session title"
                    : [{ type: "text", text: "Bound fixture task" }],
                },
              ],
              stream: true,
            }),
          });
          expect(response.status).toBe(200);
          const frames = (await response.text()).trim().split("\n\n");
          if (!messagesProtocol) {
            expect(frames).toHaveLength(3);
            expect(frames[2]).toBe("data: [DONE]");
            const first = z
              .looseObject({
                choices: z.array(z.looseObject({ delta: z.looseObject({ content: z.string() }) })),
              })
              .parse(JSON.parse(frames[0]?.slice("data: ".length) ?? "null"));
            return z
              .union([z.string(), z.record(z.string(), z.unknown())])
              .parse(JSON.parse(first.choices[0]?.delta.content ?? "null"));
          }
          const events = frames.map((frame) => {
            const [name, data] = frame.split("\n");
            const event = z
              .looseObject({
                type: z.string(),
                delta: z
                  .looseObject({ text: z.string().optional(), stop_reason: z.string().optional() })
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
          expect(events[4]?.delta?.stop_reason).toBe("end_turn");
          return z
            .union([z.string(), z.record(z.string(), z.unknown())])
            .parse(JSON.parse(events[2]?.delta?.text ?? "null"));
        };
        for (const route of ["label", "assignee"]) {
          expect(await request(route)).toMatchObject({
            protocolVersion: 1,
            operation: "task",
            state: "final",
            taskOutput: { route, accepted: true },
          });
        }
        for (const id of [
          "github.issue.labels.set",
          "github.issue.assignees.set",
          "github.comment.create",
          "github.issue.state.update",
        ]) {
          expect(await request("github")).toMatchObject({
            state: "needs_tool",
            toolRequest: { id },
          });
        }
        expect(await request("github")).toMatchObject({ state: "final" });
        expect(await request("metadata")).toMatchObject({
          state: "needs_tool",
          toolRequest: {
            id: "github.pull.metadata.update",
            input: { title: "fixture pull title" },
          },
        });
        expect(await request("metadata")).toMatchObject({ state: "final" });
        expect(await request("native-checks", true)).toBe("Native qualification");
        for (const route of ["checks", "native-checks"]) {
          expect(await request(route)).toMatchObject({
            operation: "diagnose",
            state: "needs_tool",
            toolRequest: { id: "github.checks.read" },
          });
          expect(await request(route)).toMatchObject({ operation: "diagnose", state: "final" });
        }
        expect(await request("native-write")).toMatchObject({ operation: "task", state: "final" });
        const audit = (await readFile(server.audit, "utf8"))
          .trim()
          .split("\n")
          .map((line) =>
            z
              .looseObject({
                authorizationMatches: z.boolean(),
                prompt: z.string(),
                route: z.string(),
                kind: z.string(),
                index: z.number(),
              })
              .parse(JSON.parse(line)),
          );
        expect(audit).toHaveLength(15);
        expect(audit.every((entry) => entry.authorizationMatches)).toBe(true);
        expect(audit.every((entry) => entry.prompt.includes("Trusted fixture system marker"))).toBe(
          true,
        );
        expect(audit.some((entry) => entry.prompt.includes(fixtureKey))).toBe(false);
        expect(
          audit
            .filter((entry) => entry.route === "native-checks")
            .map((entry) => [entry.kind, entry.index]),
        ).toEqual([
          ["title", 0],
          ["agent", 1],
          ["agent", 2],
        ]);
      } finally {
        await server.close();
      }
    },
  );
});
