import { appendFile, readFile, stat, writeFile } from "node:fs/promises";

const evidencePath = process.env.MCP_EVIDENCE;
if (!evidencePath) throw new Error("MCP_EVIDENCE is required");
const outcome = (value) =>
  ["success", "failure", "cancelled", "skipped"].includes(value) ? value : "not-run";
const conclusion = (value) =>
  ["success", "failure", "neutral"].includes(value) ? value : "unavailable";
const errorCode = (value) =>
  !value || value === "none"
    ? "none"
    : typeof value === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(value)
      ? value
      : "invalid-code";
const count = (value, limit) =>
  Number.isSafeInteger(value) && value >= 0 && value <= limit ? value : null;

async function boundedFile(path, limit) {
  if (!path || (await stat(path)).size > limit)
    throw new Error("Evidence file is absent or oversized");
  return await readFile(path, "utf8");
}

if (process.argv[2] === "capture") {
  let result;
  let expected;
  let calls;
  try {
    result = JSON.parse(process.env.RESULT_JSON ?? "");
  } catch {
    /* Missing Action output remains unknown. */
  }
  try {
    expected = JSON.parse(await boundedFile(process.env.MCP_ENDPOINT, 4_096)).expectedProof;
  } catch {
    /* Missing fixture identity cannot pass. */
  }
  try {
    const audit = await boundedFile(process.env.MCP_AUDIT, 64 * 1024);
    calls =
      audit.trim() === ""
        ? []
        : audit
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
    if (calls.length > 100 || calls.some((call) => !["echo", "hidden"].includes(call?.tool)))
      calls = undefined;
  } catch {
    /* Missing or invalid audit is distinct from zero calls. */
  }
  const receipts = result?.loop?.dshToolReceipts;
  const evidence = {
    actionOutcome: outcome(process.env.MCP_ACTION_OUTCOME),
    conclusion: conclusion(result?.conclusion),
    errorCode: errorCode(result?.error?.code),
    receiptCount:
      result === undefined ? null : Array.isArray(receipts) ? Math.min(receipts.length, 10_000) : 0,
    echoCalls: calls?.filter((call) => call.tool === "echo").length ?? null,
    hiddenCalls: calls?.filter((call) => call.tool === "hidden").length ?? null,
    proofMatches:
      typeof expected === "string" &&
      /^[0-9a-f]{48}$/.test(expected) &&
      result?.taskOutput?.proof === expected,
  };
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
} else if (process.argv[2] === "report") {
  let evidence;
  try {
    evidence = JSON.parse(await boundedFile(evidencePath, 4_096));
  } catch {
    evidence = {
      actionOutcome: outcome(process.env.MCP_ACTION_OUTCOME),
      conclusion: "unavailable",
      errorCode: errorCode(process.env.MCP_ERROR_CODE),
      receiptCount: null,
      echoCalls: null,
      hiddenCalls: null,
      proofMatches: false,
    };
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
  }
  evidence = {
    actionOutcome: outcome(evidence?.actionOutcome),
    conclusion: conclusion(evidence?.conclusion),
    errorCode: errorCode(evidence?.errorCode),
    receiptCount: count(evidence?.receiptCount, 10_000),
    echoCalls: count(evidence?.echoCalls, 100),
    hiddenCalls: count(evidence?.hiddenCalls, 100),
    proofMatches: evidence?.proofMatches === true,
  };
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
  const text = JSON.stringify(evidence);
  process.stdout.write(text + "\n");
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `### MCP execution evidence\n\n\`\`\`json\n${text}\n\`\`\`\n`,
    );
} else throw new Error("Expected capture or report");
