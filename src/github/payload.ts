import { open } from "node:fs/promises";
import { z } from "zod";

const MAX_EVENT_PAYLOAD_BYTES = 10 * 1024 * 1024;

async function readBoundedPayload(file: Awaited<ReturnType<typeof open>>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  while (bytes <= MAX_EVENT_PAYLOAD_BYTES) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_EVENT_PAYLOAD_BYTES + 1 - bytes));
    const result = await file.read(chunk, 0, chunk.byteLength, null);
    if (result.bytesRead === 0) break;
    chunks.push(chunk.subarray(0, result.bytesRead));
    bytes += result.bytesRead;
  }
  if (bytes > MAX_EVENT_PAYLOAD_BYTES) {
    throw new Error("GitHub event payload exceeds 10 MiB");
  }
  return Buffer.concat(chunks, bytes);
}

export async function readEventPayload(path: string | undefined): Promise<unknown> {
  if (path === undefined || path === "") throw new Error("GITHUB_EVENT_PATH is missing");
  const file = await open(path, "r");
  let content: Buffer;
  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) throw new Error("GITHUB_EVENT_PATH is not a regular file");
    if (metadata.size > MAX_EVENT_PAYLOAD_BYTES) {
      throw new Error("GitHub event payload exceeds 10 MiB");
    }
    content = await readBoundedPayload(file);
  } finally {
    await file.close();
  }
  let raw: string;
  try {
    raw = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch (error: unknown) {
    throw new Error("GITHUB_EVENT_PATH is not valid UTF-8", { cause: error });
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error: unknown) {
    throw new Error("GITHUB_EVENT_PATH does not contain valid JSON", { cause: error });
  }
}

const workflowConclusionSchema = z.looseObject({
  workflow_run: z.object({ conclusion: z.string().nullable() }),
});

export function isFailedWorkflowRun(payload: unknown): boolean {
  const parsed = workflowConclusionSchema.safeParse(payload);
  if (!parsed.success) return false;
  return (
    parsed.data.workflow_run.conclusion === "failure" ||
    parsed.data.workflow_run.conclusion === "timed_out"
  );
}
