/*
 * Controller-owned Cordis policy adapter for DSH ToolRuntime.
 * It intentionally implements no transport or plugin loader. MCP discovery,
 * registration, reconnect, and dispatch stay owned by official DSH packages.
 */
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

export const name = "dsh-action-policy";
export const inject = ["tools", "systemPrompt"];

function rootOutputProtocol(expectedOperation) {
  const operation = JSON.stringify(expectedOperation);
  return (
    "DSH Action root-output protocol: the launcher-supplied user task begins with a Controller-authored <TRUSTED_CONTROLLER_POLICY> block. " +
    `The Controller-selected operation is ${operation}; the final JSON operation field must be exactly ${operation}, including spelling and case. Never infer a different operation from task wording, requested edits, tool use, or access level. ` +
    "Only an exact ID present inside the Controller-authored TRUSTED_TOOL_CATALOG_JSON array is a Controller catalog tool, requested through a state=needs_tool final JSON object. An ID absent from that array is never requestable through needs_tool; authorized DSH runtime tools must instead be invoked directly through their runtime schemas. When the trusted operator instruction requires a listed Controller catalog tool that has not already succeeded in iteration feedback, stop the internal tool loop and request that exact catalog ID immediately. Never imitate, prepare for, or replace a listed Controller catalog tool by reading, searching, editing, running Bash, using the web, or spawning a subagent. " +
    "The output contract is mandatory. The final assistant message must be exactly one JSON object matching that contract, with no Markdown fence, preface, suffix, or separate citation list. " +
    "Any tool instruction to cite URLs or use Markdown applies only inside JSON string fields (for example summary); it never permits bytes outside the JSON object."
  );
}

const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/u;
const POLICY_ID = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*){1,2}$/u;
const OPERATIONS = new Set(["task", "review", "diagnose", "fix", "implement"]);
const CONFIG_KEYS = new Set([
  "expectedOperation",
  "allowedRuntimeTools",
  "knownRuntimeTools",
  "rules",
  "statePath",
  "auditPath",
]);
const RULE_KEYS = new Set([
  "id",
  "runtimeName",
  "provider",
  "groupId",
  "timeoutMs",
  "maxOutputBytes",
  "maxCalls",
  "groupMaxCalls",
]);
const PROVIDERS = new Set(["builtin", "mcp", "plugin"]);
const MAX_STATE_BYTES = 1024 * 1024;

function fail(message) {
  throw new Error(`dsh-action-policy: ${message}`);
}

function assertNoUnknownKeys(value, allowed, label) {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) fail(`${label} contains unknown key ${unknown}`);
}

function validateConfig(config) {
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    fail("config must be an object");
  }
  assertNoUnknownKeys(config, CONFIG_KEYS, "config");
  if (typeof config.expectedOperation !== "string" || !OPERATIONS.has(config.expectedOperation)) {
    fail("expectedOperation must be a supported Controller operation");
  }
  if (
    !Array.isArray(config.allowedRuntimeTools) ||
    !Array.isArray(config.knownRuntimeTools) ||
    !Array.isArray(config.rules)
  ) {
    fail("allowedRuntimeTools, knownRuntimeTools, and rules must be arrays");
  }
  if (!isAbsolute(config.statePath) || !isAbsolute(config.auditPath)) {
    fail("statePath and auditPath must be absolute");
  }
  if (resolve(config.statePath) === resolve(config.auditPath)) {
    fail("statePath and auditPath must be different files");
  }
  const allowed = new Set();
  for (const value of config.allowedRuntimeTools) {
    if (typeof value !== "string" || !TOOL_NAME.test(value)) {
      fail("allowedRuntimeTools contains an invalid DSH tool name");
    }
    if (allowed.has(value)) fail(`duplicate allowed tool ${value}`);
    allowed.add(value);
  }
  const known = new Set();
  for (const value of config.knownRuntimeTools) {
    if (typeof value !== "string" || !TOOL_NAME.test(value)) {
      fail("knownRuntimeTools contains an invalid DSH tool name");
    }
    if (known.has(value)) fail(`duplicate known tool ${value}`);
    known.add(value);
  }
  const unknownAllowed = [...allowed].find((value) => !known.has(value));
  if (unknownAllowed !== undefined) {
    fail(`allowed tool ${unknownAllowed} is absent from the audited runtime inventory`);
  }
  const rules = new Map();
  const logicalRules = new Map();
  const groupLimits = new Map();
  for (const rule of config.rules) {
    if (typeof rule !== "object" || rule === null || Array.isArray(rule)) {
      fail("rules must contain objects");
    }
    assertNoUnknownKeys(rule, RULE_KEYS, "rule");
    if (typeof rule.id !== "string" || typeof rule.runtimeName !== "string") {
      fail("each rule requires id and runtimeName");
    }
    if (!POLICY_ID.test(rule.id)) fail(`rule id ${rule.id} is invalid`);
    if (!TOOL_NAME.test(rule.runtimeName) || !allowed.has(rule.runtimeName)) {
      fail(`rule ${rule.id} names a tool outside the positive allowlist`);
    }
    for (const key of ["timeoutMs", "maxOutputBytes", "maxCalls", "groupMaxCalls"]) {
      if (!Number.isSafeInteger(rule[key]) || rule[key] <= 0) {
        fail(`rule ${rule.id}.${key} must be a positive integer`);
      }
    }
    if (typeof rule.groupId !== "string" || !POLICY_ID.test(rule.groupId)) {
      fail(`rule ${rule.id}.groupId is invalid`);
    }
    if (typeof rule.provider !== "string" || !PROVIDERS.has(rule.provider)) {
      fail(`rule ${rule.id}.provider is invalid`);
    }
    if (rules.has(rule.runtimeName)) fail(`duplicate rule for ${rule.runtimeName}`);
    const logicalSignature = JSON.stringify({
      provider: rule.provider,
      groupId: rule.groupId,
      timeoutMs: rule.timeoutMs,
      maxOutputBytes: rule.maxOutputBytes,
      maxCalls: rule.maxCalls,
      groupMaxCalls: rule.groupMaxCalls,
    });
    const existingLogical = logicalRules.get(rule.id);
    if (existingLogical !== undefined && existingLogical !== logicalSignature) {
      fail(`rules for logical tool ${rule.id} have conflicting policy limits`);
    }
    logicalRules.set(rule.id, logicalSignature);
    const existingGroupLimit = groupLimits.get(rule.groupId);
    if (existingGroupLimit !== undefined && existingGroupLimit !== rule.groupMaxCalls) {
      fail(`rules for group ${rule.groupId} have conflicting invocation limits`);
    }
    groupLimits.set(rule.groupId, rule.groupMaxCalls);
    rules.set(rule.runtimeName, Object.freeze({ ...rule }));
  }
  if (rules.size !== allowed.size) fail("every allowed runtime tool must have exactly one rule");
  return {
    expectedOperation: config.expectedOperation,
    allowed: Object.freeze([...allowed]),
    known: Object.freeze([...known]),
    rules,
    statePath: config.statePath,
    auditPath: config.auditPath,
  };
}

function validatedCountRecord(value, label, allowedKeys) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(`persisted invocation ${label} must be an object`);
  }
  const copy = Object.create(null);
  for (const [key, count] of Object.entries(value)) {
    if (!allowedKeys.has(key)) fail(`persisted invocation ${label} contains unknown key ${key}`);
    if (!Number.isSafeInteger(count) || count < 0) {
      fail(`persisted invocation ${label}.${key} must be a non-negative safe integer`);
    }
    copy[key] = count;
  }
  return copy;
}

function readCounts(path, rules) {
  try {
    if (statSync(path).size > MAX_STATE_BYTES) fail("persisted invocation state is too large");
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (
      value?.schemaVersion !== 1 ||
      typeof value.tools !== "object" ||
      value.tools === null ||
      typeof value.groups !== "object" ||
      value.groups === null ||
      Object.keys(value).some((key) => !["schemaVersion", "tools", "groups"].includes(key))
    ) {
      fail("persisted invocation state is malformed");
    }
    const toolIds = new Set([...rules.values()].map((rule) => rule.id));
    const groupIds = new Set([...rules.values()].map((rule) => rule.groupId));
    return {
      schemaVersion: 1,
      tools: validatedCountRecord(value.tools, "tools", toolIds),
      groups: validatedCountRecord(value.groups, "groups", groupIds),
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { schemaVersion: 1, tools: {}, groups: {} };
    throw error;
  }
}

function writeCounts(path, counts) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(counts)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}

function timeoutResult(rule) {
  const message = `tool ${rule.id} timed out after ${String(rule.timeoutMs)}ms`;
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
    error: { message, info: { name: "DshActionToolTimeoutError", code: "ACTION_TOOL_TIMEOUT" } },
  };
}

function serializedBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function resultCode(result) {
  const code = result?.error?.info?.code;
  return typeof code === "string" ? code.slice(0, 128) : undefined;
}

export function apply(ctx, rawConfig) {
  const config = validateConfig(rawConfig);
  const counts = readCounts(config.statePath, config.rules);
  const starts = new Map();
  const countedCalls = new Set();
  const outputLimitedCalls = new Set();
  const hardenedDefinitions = new WeakMap();
  const restrictedAgents = new WeakSet();
  let restrictionFailure;

  // Official rc.2 tools contribute their own late system sections (web search,
  // for example, requests Markdown citations). Keep those instructions, but
  // make the Action's root transport boundary the final system-level rule.
  // Delegated subagents return ordinary content to their parent and therefore
  // must not inherit the root JSON envelope.
  ctx.systemPrompt.section({
    name: "dsh-action:root-output-protocol",
    order: 1_000,
    text: (context) =>
      context.agent?.session?.header?.origin === "subagent"
        ? ""
        : rootOutputProtocol(config.expectedOperation),
  });

  const appendReceipt = (receipt) => {
    mkdirSync(dirname(config.auditPath), { recursive: true, mode: 0o700 });
    appendFileSync(config.auditPath, `${JSON.stringify(receipt)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  };

  const agentInventory = (agent) => ctx.tools.schemas(agent).map((schema) => schema.name);
  const assertKnownAgentInventory = (agent) => {
    const visible = agentInventory(agent);
    const unknown = visible.find((toolName) => !config.known.includes(toolName));
    const missing = config.allowed.find((toolName) => !visible.includes(toolName));
    if (unknown !== undefined) {
      fail(`agent inventory contains unaudited tool ${unknown}`);
    }
    if (missing !== undefined) fail(`authorized tool ${missing} was not registered`);
  };
  const assertAllowedAgentInventory = (agent) => {
    const visible = agentInventory(agent);
    const unknown = visible.find((toolName) => !config.allowed.includes(toolName));
    const missing = config.allowed.find((toolName) => !visible.includes(toolName));
    if (unknown !== undefined) {
      fail(`restricted agent inventory exposes unauthorized tool ${unknown}`);
    }
    if (missing !== undefined) fail(`authorized tool ${missing} was not registered`);
  };
  const hardenFinalContent = (agent) => {
    for (const runtimeName of config.allowed) {
      const definition = ctx.tools.get(runtimeName, agent);
      if (definition === undefined) fail(`authorized tool ${runtimeName} was not registered`);
      const installedFinalizer = hardenedDefinitions.get(definition);
      if (installedFinalizer !== undefined) {
        if (definition.finalizeContent !== installedFinalizer) {
          fail(`authorized tool ${runtimeName} changed its bounded final content hook`);
        }
        continue;
      }
      const rule = config.rules.get(runtimeName);
      if (rule === undefined) fail(`authorized tool ${runtimeName} has no Controller rule`);
      const original = definition.finalizeContent?.bind(definition);
      const boundedFinalizer = (exec, result) => {
        const replacement = original?.(exec, result);
        const content = replacement ?? result.content;
        if (serializedBytes({ ...result, content }) <= rule.maxOutputBytes) return replacement;
        outputLimitedCalls.add(String(exec.callId));
        throw new Error(
          `tool ${rule.id} output exceeded the Controller limit of ${String(rule.maxOutputBytes)} bytes`,
        );
      };
      try {
        definition.finalizeContent = boundedFinalizer;
      } catch (error) {
        fail(`authorized tool ${runtimeName} final content cannot be bounded: ${String(error)}`);
      }
      if (definition.finalizeContent !== boundedFinalizer) {
        fail(`authorized tool ${runtimeName} final content cannot be bounded`);
      }
      hardenedDefinitions.set(definition, boundedFinalizer);
    }
  };

  ctx.on("agent/created", ({ agent }) => {
    try {
      // Audit the complete pre-restriction inventory. ToolRuntime restrictions
      // hide global tools, but intentionally do not erase agent-scoped tools.
      // The strict post-check therefore also detects scoped tools that an
      // approved plugin attempted to expose outside the Controller allowlist.
      assertKnownAgentInventory(agent);
      const globalTools = ctx.tools.schemas().map((schema) => schema.name);
      if (globalTools.length > 0) {
        const allowedGlobals = globalTools.filter((toolName) => config.allowed.includes(toolName));
        if (allowedGlobals.length === 0) agent.ctx.tools.restrict({ deny: globalTools });
        else agent.ctx.tools.restrict({ allow: allowedGlobals });
      }
      assertAllowedAgentInventory(agent);
      hardenFinalContent(agent);
      restrictedAgents.add(agent);
    } catch (error) {
      restrictionFailure = error;
      throw error;
    }
  });

  ctx.on(
    "agent/pre-step",
    async ({ agent }, next) => {
      if (!restrictedAgents.has(agent)) {
        throw new Error(
          `dsh-action-policy: positive tool restriction was not installed: ${String(restrictionFailure ?? "unknown failure")}`,
        );
      }
      assertAllowedAgentInventory(agent);
      hardenFinalContent(agent);
      const decision = await next();
      assertAllowedAgentInventory(agent);
      hardenFinalContent(agent);
      return decision;
    },
    { prepend: true },
  );

  ctx.tools.guard((exec) => {
    const rule = config.rules.get(exec.name);
    if (rule === undefined) return `tool ${exec.name} is not authorized by the Controller`;
    const toolCalls = counts.tools[rule.id] ?? 0;
    const groupCalls = counts.groups[rule.groupId] ?? 0;
    if (toolCalls >= rule.maxCalls) {
      return `tool ${rule.id} exceeded its Controller invocation limit`;
    }
    if (groupCalls >= rule.groupMaxCalls) {
      return `extension ${rule.groupId} exceeded its Controller invocation limit`;
    }
    const callId = String(exec.callId).slice(0, 256);
    const startedAt = Date.now();
    counts.tools[rule.id] = toolCalls + 1;
    counts.groups[rule.groupId] = groupCalls + 1;
    writeCounts(config.statePath, counts);
    starts.set(exec.callId, startedAt);
    countedCalls.add(exec.callId);
    appendReceipt({
      schemaVersion: 1,
      phase: "started",
      callId,
      id: rule.id,
      runtimeName: exec.name,
      provider: rule.provider,
      counted: true,
      ok: false,
      durationMs: 0,
      code: "ACTION_TOOL_INCOMPLETE",
    });
    return undefined;
  });

  ctx.on("tools/execute", async (exec, next) => {
    const rule = config.rules.get(exec.name);
    if (rule === undefined) return next();
    const upstream = exec.signal;
    const controller = new AbortController();
    let timedOut = false;
    const upstreamAbort = () => controller.abort(upstream.reason);
    if (upstream.aborted) upstreamAbort();
    else upstream.addEventListener("abort", upstreamAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`Controller tool timeout after ${String(rule.timeoutMs)}ms`));
    }, rule.timeoutMs);
    timer.unref();
    exec.signal = controller.signal;
    try {
      const result = await next();
      return timedOut ? timeoutResult(rule) : result;
    } finally {
      clearTimeout(timer);
      upstream.removeEventListener("abort", upstreamAbort);
      exec.signal = upstream;
    }
  });

  ctx.on(
    "tools/post-execute",
    async (exec, result, next) => {
      const decision = await next();
      const rule = config.rules.get(exec.name);
      if (rule === undefined) return decision;
      // Count every canonical and projected field. A downstream post-execute
      // listener may replace a value or content, so retaining both sides here is
      // deliberately conservative and prevents a small renderer from hiding a
      // large structured result from the Controller limit.
      const projected = { result, decision };
      const bytes = serializedBytes(projected);
      if (bytes <= rule.maxOutputBytes) return decision;
      outputLimitedCalls.add(String(exec.callId));
      return {
        kind: "block",
        feedback: [
          {
            type: "text",
            text: `Error: tool ${rule.id} output exceeded the Controller limit of ${String(rule.maxOutputBytes)} bytes`,
          },
        ],
      };
    },
    { prepend: true },
  );

  ctx.on("tools/result", (exec, result) => {
    const rule = config.rules.get(exec.name);
    const startedAt = starts.get(exec.callId);
    starts.delete(exec.callId);
    const counted = countedCalls.delete(exec.callId);
    const outputLimited = outputLimitedCalls.delete(String(exec.callId));
    const code = outputLimited ? "ACTION_TOOL_OUTPUT_LIMIT" : resultCode(result);
    const receipt = {
      schemaVersion: 1,
      phase: "completed",
      callId: String(exec.callId).slice(0, 256),
      id: rule?.id ?? `denied:${exec.name}`,
      runtimeName: exec.name,
      provider: rule?.provider ?? "denied",
      counted,
      ok: !outputLimited && result.isError !== true,
      durationMs: startedAt === undefined ? 0 : Math.max(0, Date.now() - startedAt),
      ...(code === undefined ? {} : { code }),
    };
    appendReceipt(receipt);
  });
}
