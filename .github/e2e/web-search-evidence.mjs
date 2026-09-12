import { appendFile, writeFile } from "node:fs/promises";
import { URL } from "node:url";

const evidencePath = process.env.WEB_EVIDENCE;
if (!evidencePath) throw new Error("WEB_EVIDENCE is required");
const outcome = (value) =>
  ["success", "failure", "cancelled", "skipped"].includes(value) ? value : "not-run";
const conclusion = (value) =>
  ["success", "failure", "neutral"].includes(value) ? value : "unavailable";
const errorCode = (value) =>
  !value
    ? "none"
    : typeof value === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(value)
      ? value
      : "invalid-code";

function sourceReported(output) {
  if (
    typeof output?.title !== "string" ||
    output.title.trim() === "" ||
    output.title.length > 512 ||
    typeof output.url !== "string" ||
    output.url.length > 2048
  )
    return false;
  try {
    const url = new URL(output.url);
    return ["http:", "https:"].includes(url.protocol) && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

let result;
try {
  const parsed = JSON.parse(process.env.RESULT_JSON ?? "");
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) result = parsed;
} catch {
  /* Missing results stay unknown. */
}
const receipts = Array.isArray(result?.loop?.dshToolReceipts) ? result.loop.dshToolReceipts : [];
const evidence = {
  actionOutcome: outcome(process.env.WEB_ACTION_OUTCOME),
  conclusion: conclusion(result?.conclusion),
  errorCode: errorCode(result?.error?.code),
  receiptCount: result === undefined ? null : Math.min(receipts.length, 10_000),
  completedWebSearchCount:
    result === undefined
      ? null
      : Math.min(
          receipts.filter(
            (receipt) =>
              receipt?.id === "native.web-search" &&
              receipt.completed === true &&
              receipt.ok === true,
          ).length,
          10_000,
        ),
  // This is presence/shape evidence, not independent verification of the URL
  // or title against upstream content. The mandatory receipt proves execution.
  sourceReported: sourceReported(result?.taskOutput),
};
const text = JSON.stringify(evidence);
await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
process.stdout.write(text + "\n");
if (process.env.GITHUB_STEP_SUMMARY)
  await appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    `### Web Search execution evidence\n\n\`\`\`json\n${text}\n\`\`\`\n`,
  );
