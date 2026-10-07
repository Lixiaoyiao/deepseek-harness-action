import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

interface Plan {
  schemaVersion: 1;
  bindingDigest: string;
  permissionMode: "read-only" | "workspace-write";
  workingDirectory: string;
  sessionId?: string;
  checkpointEventCount?: number;
}
interface Agent {
  session: {
    id: string;
    seq: number;
    firstLiveSeq: number;
    header: { cwd: string; origin?: "subagent"; parentSession?: string };
  };
  inbox: { nextTurn: readonly unknown[]; nextStep: readonly unknown[] };
}
interface Plugin {
  validateSessionPlan(value: unknown): Plan;
  readSessionPlan(path: string, home: string): Plan;
  sessionHeadlessPatch(
    value: unknown,
    task: string,
  ): {
    id: "headless-runner";
    config: { task: string; json: true; sessionId?: string };
  };
  installSessionAdmission(context: unknown, plan: unknown, options?: { auditPath?: string }): void;
}
type Created = (payload: { agent: Agent; source: string }) => void;
type Requested = (payload: { agent: Agent }, next: () => Promise<unknown>) => Promise<unknown>;
type Guard = (execution: { agent?: Agent }) => string | undefined;

const SESSION_ID = "session-11111111-1111-4111-8111-111111111111";
const workspace = resolve("session-test-workspace");
const directories: string[] = [];
let plugin: Plugin;

beforeAll(async () => {
  plugin = (await import(pathToFileURL(resolve("assets/dsh/action-session.mjs")).href)) as Plugin;
});
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function plan(extra: Partial<Plan> = {}): Plan {
  return {
    schemaVersion: 1,
    bindingDigest: "a".repeat(64),
    permissionMode: "read-only",
    workingDirectory: workspace,
    sessionId: SESSION_ID,
    checkpointEventCount: 21,
    ...extra,
  };
}
function subject(): Agent {
  return {
    session: { id: SESSION_ID, seq: 22, firstLiveSeq: 21, header: { cwd: workspace } },
    inbox: { nextTurn: [], nextStep: [] },
  };
}
function fixture(options: { defaultMode?: string; approval?: string } = {}) {
  const listeners = new Map<string, unknown>();
  let guard: Guard | undefined;
  const knobs = { mode: "workspace-write", approval: "ask", preset: "workspace-write" };
  const writes: string[] = [];
  const service = {
    sandboxPolicy: {
      defaultMode: options.defaultMode ?? "read-only",
      resolve: () => ({ mode: knobs.mode }),
    },
    approval: { effectivePolicy: () => knobs.approval },
    permissionPresets: {
      resolve: (name: string) => ({ sandbox: name, approval: options.approval ?? "never" }),
      current: () => knobs.preset,
      set: (session: Agent["session"], name: string) => {
        writes.push("permission/preset", "sandbox/mode", "approval/policy");
        knobs.preset = name;
        knobs.mode = name;
        knobs.approval = "never";
        session.seq += 3;
      },
    },
  };
  const context = {
    on: (event: string, callback: unknown, registration?: { prepend?: boolean }) => {
      if (event === "agent/created") expect(registration?.prepend).toBe(true);
      listeners.set(event, callback);
    },
    get: (name: string) => service[name as keyof typeof service],
    inject: (
      _names: string[],
      setup: (scope: { tools: { guard(callback: Guard): void } }) => void,
    ) => {
      setup({
        tools: {
          guard: (callback) => {
            guard = callback;
          },
        },
      });
    },
  };
  return {
    context,
    knobs,
    writes,
    created: (agent: Agent, source = "resume") =>
      (listeners.get("agent/created") as Created)({ agent, source }),
    request: (agent: Agent, next: () => Promise<unknown>) =>
      (listeners.get("agent/request") as Requested)({ agent }, next),
    guard: (agent?: Agent) => guard?.({ ...(agent === undefined ? {} : { agent }) }),
  };
}

describe("published worker Session admission", () => {
  it("retains current task and Controller-bound identity in the final wholesale Headless config", () => {
    const task = "literal --session-id task text";
    expect(plugin.sessionHeadlessPatch(plan(), task)).toEqual({
      id: "headless-runner",
      config: { task, json: true, sessionId: SESSION_ID },
    });
    const fresh = plan();
    delete fresh.sessionId;
    delete fresh.checkpointEventCount;
    expect(plugin.sessionHeadlessPatch(fresh, task)).toEqual({
      id: "headless-runner",
      config: { task, json: true },
    });
    expect(() => plugin.sessionHeadlessPatch(plan(), " ")).toThrow(
      "a current headless task is required",
    );
  });
  it("resets historical sandbox, approval and preset before requests or tools", async () => {
    const runtime = fixture();
    const agent = subject();
    plugin.installSessionAdmission(runtime.context, plan());
    expect(runtime.guard(agent)).toContain("admission is required");
    await expect(runtime.request(agent, () => Promise.resolve("unreachable"))).rejects.toThrow(
      "not admitted",
    );
    runtime.created(agent);
    expect(runtime.writes).toEqual(["permission/preset", "sandbox/mode", "approval/policy"]);
    expect(runtime.knobs).toEqual({ mode: "read-only", approval: "never", preset: "read-only" });
    expect(runtime.guard(agent)).toBeUndefined();
    await expect(runtime.request(agent, () => Promise.resolve("fresh-config"))).resolves.toBe(
      "fresh-config",
    );
  });

  it.each(["identity", "cwd", "event-count", "pending-turn", "pending-step", "source"])(
    "rejects %s before changing policy or accepting queued work",
    (problem) => {
      const runtime = fixture();
      const agent = subject();
      if (problem === "identity") agent.session.id = SESSION_ID.replace("11111111", "22222222");
      if (problem === "cwd") agent.session.header.cwd = resolve("another-workspace");
      if (problem === "event-count") agent.session.firstLiveSeq += 2;
      if (problem === "pending-turn") agent.inbox.nextTurn = [{ text: "old write" }];
      if (problem === "pending-step") agent.inbox.nextStep = [{ text: "old request" }];
      plugin.installSessionAdmission(runtime.context, plan());
      expect(() => runtime.created(agent, problem === "source" ? "startup" : "resume")).toThrow();
      expect(runtime.writes).toEqual([]);
      expect(runtime.guard(agent)).toContain("admission is required");
    },
  );

  it.each([{ defaultMode: "workspace-write" }, { approval: "ask" }])(
    "refuses a plan inconsistent with current composition %j",
    (options) => {
      const runtime = fixture(options);
      plugin.installSessionAdmission(runtime.context, plan());
      expect(() => runtime.created(subject())).toThrow("current composition policy");
      expect(runtime.writes).toEqual([]);
    },
  );

  it("blocks policy drift before and after configuration preparation and at the tool boundary", async () => {
    const runtime = fixture();
    const agent = subject();
    plugin.installSessionAdmission(runtime.context, plan());
    runtime.created(agent);
    await expect(
      runtime.request(agent, () => {
        runtime.knobs.mode = "workspace-write";
        return Promise.resolve("configuration must not reach the provider");
      }),
    ).rejects.toThrow("drifted");
    expect(runtime.guard(agent)).toContain("admission is required");
    let prepared = false;
    await expect(
      runtime.request(agent, () => {
        prepared = true;
        return Promise.resolve();
      }),
    ).rejects.toThrow("drifted");
    expect(prepared).toBe(false);
  });

  it("creates a new identity only under startup and applies current policy to child agents", () => {
    const runtime = fixture();
    const freshPlan = plan();
    delete freshPlan.sessionId;
    delete freshPlan.checkpointEventCount;
    plugin.installSessionAdmission(runtime.context, freshPlan);
    const root = subject();
    runtime.created(root, "startup");
    const child = subject();
    child.session.id = "subagent-current";
    child.session.header.origin = "subagent";
    child.session.header.parentSession = root.session.id;
    runtime.created(child, "startup");
    expect(runtime.guard(child)).toBeUndefined();
    const unrelated = subject();
    unrelated.session.id = SESSION_ID.replace("11111111", "33333333");
    expect(() => runtime.created(unrelated, "startup")).toThrow("identity is not bound");
  });

  it.each([
    { permissionMode: "danger-full-access" },
    { bindingDigest: "not-bound" },
    { sessionId: "../elsewhere" },
    { checkpointEventCount: undefined },
    { checkpointEventCount: -1 },
    { credential: "must-not-echo" },
    { workingDirectory: "relative" },
  ])("rejects invalid worker plan %j without echoing unknown values", (extra) => {
    expect(() => plugin.validateSessionPlan({ ...plan(), ...extra })).toThrow(
      "invalid Controller session plan",
    );
  });

  it("reads only the fixed bounded regular UTF-8 plan and refuses a linked parent", async () => {
    const home = await mkdtemp(join(tmpdir(), "dsh-session-plan-test-"));
    directories.push(home);
    const state = join(home, "action-state");
    await mkdir(state);
    const path = join(state, "session-plan.json");
    await writeFile(path, JSON.stringify(plan()));
    expect(plugin.readSessionPlan(path, home)).toEqual(plan());
    expect(() => plugin.readSessionPlan(join(home, "outside.json"), home)).toThrow(
      "fixed Controller",
    );
    await writeFile(path, Buffer.from([0xff]));
    expect(() => plugin.readSessionPlan(path, home)).toThrow("strict UTF-8 JSON");
    await writeFile(path, " ".repeat(8193));
    expect(() => plugin.readSessionPlan(path, home)).toThrow("bounded regular file");
    const linkedHome = await mkdtemp(join(tmpdir(), "dsh-session-plan-link-"));
    directories.push(linkedHome);
    await writeFile(path, JSON.stringify(plan()));
    await symlink(
      state,
      join(linkedHome, "action-state"),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(() =>
      plugin.readSessionPlan(join(linkedHome, "action-state", "session-plan.json"), linkedHome),
    ).toThrow("symbolic link");
  });

  it("uses actual fresh official workers to restore history, downgrade permission and avoid old tool replay in both modes", async () => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["scripts/probe-session-admission.mjs"],
      {
        cwd: process.cwd(),
        timeout: 110_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
    );
    const report = JSON.parse(stdout) as {
      runtimeVersion: string;
      checks: {
        mode: string;
        passed: boolean;
        oldToolReplayed: boolean;
        forbiddenWriteOccurred: boolean;
        currentSystemPromptOnly: boolean;
        currentToolGraph: boolean;
      }[];
    };
    expect(report.runtimeVersion).toBe("0.2.0-rc.2");
    expect(report.checks.map(({ mode }) => mode)).toEqual(["controlled", "native"]);
    for (const check of report.checks)
      expect(check).toMatchObject({
        passed: true,
        oldToolReplayed: false,
        forbiddenWriteOccurred: false,
        currentSystemPromptOnly: true,
        currentToolGraph: true,
      });
  }, 120_000);

  it.each([
    { outcome: "successful", flag: "--pruner-pressure", errorResult: false },
    { outcome: "error", flag: "--pruner-error-result", errorResult: true },
  ])(
    "prunes a real $outcome read-tool result and strictly restores production logs without old tool replay",
    async ({ flag, errorResult }) => {
      const directory = await mkdtemp(join(tmpdir(), "dsh-session-production-report-"));
      directories.push(directory);
      const evidence = join(directory, "evidence.json");
      await promisify(execFile)(
        process.execPath,
        ["scripts/probe-session-production-launchers.mjs", evidence, flag],
        { cwd: process.cwd(), timeout: 130_000, maxBuffer: 1024 * 1024, windowsHide: true },
      );
      const report = JSON.parse(await readFile(evidence, "utf8")) as {
        runtimeVersion: string;
        remoteModelCalls: number;
        githubWrites: number;
        titleDisabledByProbe: boolean;
        checks: { mode: string; saveTitleRequests: number }[];
      };
      expect(report).toMatchObject({
        runtimeVersion: "0.2.0-rc.2",
        remoteModelCalls: 0,
        githubWrites: 0,
        titleDisabledByProbe: false,
      });
      expect(report.checks.map(({ mode }) => mode)).toEqual(["controlled", "native"]);
      for (const check of report.checks)
        expect(check).toMatchObject({
          productionProfile: true,
          originalLauncher: true,
          newWorker: true,
          sameSession: true,
          currentPermission: "read-only/never",
          historyRestored: true,
          oldToolsReplayed: false,
          extraSession: false,
          mainRequests: 1,
          prunerEvents: 1,
          strictSaveDecode: true,
          malformedPruneRejected: true,
          strictRestoredDecode: true,
          pruneEvidence: [{ errorResult }],
        });
      expect(report.checks[0]?.saveTitleRequests).toBe(0);
      expect(report.checks[1]?.saveTitleRequests).toBeGreaterThanOrEqual(1);
    },
    140_000,
  );
});
