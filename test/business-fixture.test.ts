import { z } from "zod";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseDshOutput } from "../src/dsh/schema.js";
import { inspectValidationIntegrity } from "../src/write/validation-integrity.js";
import { createWorkspaceSnapshot, inspectWorkspaceChanges } from "../src/write/workspace.js";

const moduleUrl = new URL("../.github/e2e/business-fixture.mjs", import.meta.url).href;
const settings = {
  fixturePath: ".github/dsh-e2e-fixtures/checks-10-1.txt",
  implementationPath: "dsh-e2e-implementation-10-1.txt",
  suffix: "10/1",
};

function invoke(route: string, index: number, body: unknown, configuration = settings) {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { readFileSync } from "node:fs";
    const { businessReply } = await import(process.argv[1]);
    const args = JSON.parse(readFileSync(0,"utf8"));
    try { process.stdout.write(JSON.stringify({value: businessReply(...args)})); }
    catch (error) { process.stdout.write(JSON.stringify({error: error.message})); }
  `,
      moduleUrl,
    ],
    { input: JSON.stringify([route, index, body, configuration]), encoding: "utf8" },
  );
  expect(result.status).toBe(0);
  return z
    .looseObject({
      error: z.string().optional(),
      value: z
        .looseObject({
          phase: z.string(),
          message: z.looseObject({
            role: z.string(),
            content: z.string().optional(),
            tool_calls: z
              .array(
                z.looseObject({
                  id: z.string(),
                  type: z.string(),
                  function: z.looseObject({ name: z.string(), arguments: z.string() }),
                }),
              )
              .optional(),
          }),
        })
        .optional(),
    })
    .parse(JSON.parse(result.stdout));
}

describe("trusted business fixture requires actual tool feedback", () => {
  it.each(["chat", "messages"])(
    "accepts the %s review final at the production boundary",
    (protocol) => {
      const value = invoke("review", 1, {
        messages: [
          {
            role: "user",
            content:
              protocol === "chat"
                ? "Review the fixture"
                : [{ type: "text", text: "Review the fixture" }],
          },
        ],
      }).value;
      expect(value?.phase).toBe("final");
      expect(parseDshOutput(value?.message.content ?? "", "review")).toMatchObject({
        operation: "review",
        state: "final",
        findings: [
          {
            path: settings.fixturePath,
            line: 1,
            side: "RIGHT",
            confidence: 1,
          },
        ],
      });
    },
  );

  it.each(["fix", "implement"] as const)(
    "requires a single %s Bash call for either provider protocol",
    (route) => {
      const prompt = { role: "user", content: "DSH_E2E_CI_FAILURE_10/1" };
      for (const protocol of ["chat", "messages"]) {
        const first = invoke(route, 1, {
          messages: [prompt],
          tools:
            protocol === "chat"
              ? [{ function: { name: "bash" } }]
              : [{ name: "bash", input_schema: { type: "object" } }],
        }).value;
        expect(first?.phase).toBe("bash-issued");
        expect(first?.message.tool_calls).toHaveLength(1);
        const call = first?.message.tool_calls?.[0];
        expect(call?.function.name).toBe("bash");
        const argumentsValue = z
          .looseObject({ command: z.string() })
          .parse(JSON.parse(call?.function.arguments ?? "null"));
        expect(argumentsValue.command).toContain(
          route === "fix" ? settings.fixturePath : settings.implementationPath,
        );
        const assistant =
          protocol === "chat"
            ? first?.message
            : {
                role: "assistant",
                content: [{ type: "tool_use", id: call?.id, name: "bash", input: argumentsValue }],
              };
        const marker = `DSH_E2E_${route.toUpperCase()}_TOOL_COMPLETED`;
        const feedback =
          protocol === "chat"
            ? { role: "tool", tool_call_id: call?.id, content: marker }
            : {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: call?.id,
                    content: [{ type: "text", text: marker }],
                  },
                ],
              };
        const second = invoke(route, 2, { messages: [prompt, assistant, feedback] }).value;
        expect(second?.phase).toBe("bash-observed");
        // Consume the actual final with the Controller's strict public schema,
        // rather than validating a second copy of the fixture's own shape.
        expect(parseDshOutput(second?.message.content ?? "", route)).toMatchObject({
          operation: route,
          state: "final",
          changePlan: [
            { path: route === "fix" ? settings.fixturePath : settings.implementationPath },
          ],
        });
        if (protocol === "messages") {
          const failedFeedback = {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: call?.id,
                is_error: true,
                content: [{ type: "text", text: marker }],
              },
            ],
          };
          expect(
            invoke(route, 2, { messages: [prompt, assistant, failedFeedback] }).error,
          ).toContain("one matching completed");
        }
        expect(invoke(route, 2, { messages: [prompt, feedback] }).error).toContain(
          "one matching completed",
        );
        expect(
          invoke(route, 2, { messages: [prompt, assistant, feedback, feedback] }).error,
        ).toContain("one matching completed");
        expect(invoke(route, 3, { messages: [prompt, assistant, feedback] }).error).toContain(
          "one matching completed",
        );
      }
    },
  );

  it("rejects missing CI evidence, unavailable Bash and invalid shell-bound fixture identities", () => {
    expect(invoke("fix", 1, { messages: [], tools: [{ name: "bash" }] }).error).toContain(
      "failed-check evidence",
    );
    expect(invoke("implement", 1, { messages: [], tools: [] }).error).toContain("actual DSH Bash");
    expect(
      invoke("review", 1, {}, { ...settings, fixturePath: "file'; touch anything" }).error,
    ).toContain("identity is invalid");
  });

  it.each(["fix", "implement"] as const)(
    "accepts the %s fixture write with the workflow's real validation argv and integrity guard",
    async (route) => {
      const root = await mkdtemp(join(tmpdir(), "dsh-business-validation-"));
      try {
        const source = join(root, "source");
        const sourceFile = join(source, settings.fixturePath);
        const validatorPath = ".github/dsh-e2e-fixtures/validate-business-file.mjs";
        await mkdir(dirname(sourceFile), { recursive: true });
        await writeFile(
          sourceFile,
          `DSH E2E checks ${route === "fix" ? "head" : "base"} ${settings.suffix}`,
        );
        await writeFile(
          join(source, validatorPath),
          await readFile(new URL("../.github/e2e/validate-business-file.mjs", import.meta.url)),
        );
        const snapshot = await createWorkspaceSnapshot(
          { kind: "materialized-tree", root: source },
          join(root, "worker"),
        );
        const path = route === "fix" ? settings.fixturePath : settings.implementationPath;
        const content = `DSH E2E ${route === "fix" ? "fixed" : "implemented"} ${settings.suffix}`;
        const workflow = await readFile(
          new URL("../.github/workflows/e2e.yml", import.meta.url),
          "utf8",
        );
        // Read the actual jq argv templates so changes to either workflow
        // validation command are consumed by the production integrity guard.
        const templates = [...workflow.matchAll(/\[\["node","[^"\r\n]+",\$path,\$content\]\]/gu)];
        expect(templates).toHaveLength(2);
        const template = templates[route === "fix" ? 0 : 1]?.[0];
        if (template === undefined) throw new Error("Missing business validation argv");
        const commands = z
          .array(z.array(z.string()))
          .parse(
            JSON.parse(
              template
                .replace("$path", JSON.stringify(path))
                .replace("$content", JSON.stringify(content)),
            ),
          );
        const argv = commands[0];
        if (argv === undefined) throw new Error("Missing business validation command");
        expect(argv.slice(0, 2)).toEqual(["node", validatorPath]);
        const validate = () =>
          spawnSync(process.execPath, argv.slice(1), {
            cwd: snapshot.workerRoot,
            encoding: "utf8",
          });
        expect(validate().status).not.toBe(0);
        await writeFile(join(snapshot.workerRoot, path), `${content}\n`);
        const validated = validate();
        expect(validated.error).toBeUndefined();
        expect(validated.stderr).toBe("");
        expect(validated.status).toBe(0);
        const changes = await inspectWorkspaceChanges(snapshot);
        expect(changes).toEqual({
          all: [path],
          added: route === "implement" ? [path] : [],
          modified: route === "fix" ? [path] : [],
          deleted: [],
        });
        expect(
          await inspectValidationIntegrity({ snapshot, changes, commands, mode: "strict" }),
        ).toMatchObject({
          mode: "strict",
          status: "clean",
          changeCount: 0,
          dangerousChangeCount: 0,
          controlPlaneChangeCount: 0,
          changes: [],
        });
        await writeFile(join(snapshot.workerRoot, validatorPath), "process.exit(0);\n");
        const weakenedChanges = await inspectWorkspaceChanges(snapshot);
        expect(
          await inspectValidationIntegrity({
            snapshot,
            changes: weakenedChanges,
            commands,
            mode: "strict",
          }),
        ).toMatchObject({
          status: "blocked",
          dangerousChangeCount: 1,
          controlPlaneChangeCount: 1,
          changes: [
            expect.objectContaining({
              path: validatorPath,
              category: "entrypoint",
              risk: "dangerous",
            }),
          ],
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
