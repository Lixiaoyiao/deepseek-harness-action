import { z } from "zod";

import type { AgentToolManifest } from "../agent/contracts.js";
import {
  createToolDenial,
  type ToolDenial,
  type ToolDenialReasonCode,
} from "../permissions/profile.js";
import type { SecurityPolicy } from "../security/policy.js";
import { githubToolSchema, type GitHubToolId } from "./schema.js";

export const MAX_COMMENT_BYTES = 32 * 1024;
export const MAX_PULL_BODY_BYTES = 64 * 1024;
export const COMMENT_MARKER_PREFIX = "<!-- dsh-action:github-tool-call=";
export const RESERVED_MARKER_PATTERN = /<!--\s*dsh-action\s*:/iu;
const COMMENT_MARKER_BYTES = Buffer.byteLength(
  `${COMMENT_MARKER_PREFIX}${"0".repeat(64)} -->`,
  "utf8",
);
const COMMENT_SUFFIX_BYTES = Buffer.byteLength("\n\n", "utf8") + COMMENT_MARKER_BYTES;
export const MAX_COMMENT_INPUT_BYTES = MAX_COMMENT_BYTES - COMMENT_SUFFIX_BYTES;

export const boundedString = (maximumCharacters: number, maximumBytes: number) =>
  z
    .string()
    .max(maximumCharacters)
    .superRefine((value, context) => {
      if (Buffer.byteLength(value, "utf8") > maximumBytes) {
        context.addIssue({
          code: "custom",
          message: `must be at most ${String(maximumBytes)} bytes`,
        });
      }
    });

export const labelSchema = boundedString(50, 200).trim().min(1);
export const loginSchema = z
  .string()
  .trim()
  .min(1)
  .max(39)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u, "invalid GitHub login");

function uniqueCaseInsensitive(values: readonly string[]): boolean {
  return new Set(values.map((value) => value.toLowerCase())).size === values.length;
}

export const labelsInputSchema = z
  .strictObject({ labels: z.array(labelSchema).max(20) })
  .superRefine(({ labels }, context) => {
    if (!uniqueCaseInsensitive(labels)) {
      context.addIssue({ code: "custom", path: ["labels"], message: "labels must be unique" });
    }
  });

export const assigneesInputSchema = z
  .strictObject({ assignees: z.array(loginSchema).max(10) })
  .superRefine(({ assignees }, context) => {
    if (!uniqueCaseInsensitive(assignees)) {
      context.addIssue({
        code: "custom",
        path: ["assignees"],
        message: "assignees must be unique",
      });
    }
  });

export const issueStateInputSchema = z
  .strictObject({
    state: z.enum(["open", "closed"]),
    stateReason: z.enum(["completed", "not_planned", "reopened"]).optional(),
  })
  .superRefine(({ state, stateReason }, context) => {
    if (state === "open" && stateReason !== undefined && stateReason !== "reopened") {
      context.addIssue({
        code: "custom",
        path: ["stateReason"],
        message: "an open issue may use only the reopened reason",
      });
    }
    if (state === "closed" && stateReason === "reopened") {
      context.addIssue({
        code: "custom",
        path: ["stateReason"],
        message: "a closed issue cannot use the reopened reason",
      });
    }
  });

export const commentInputSchema = z
  .strictObject({
    body: boundedString(MAX_COMMENT_INPUT_BYTES, MAX_COMMENT_INPUT_BYTES).trim().min(1),
  })
  .superRefine(({ body }, context) => {
    if (RESERVED_MARKER_PATTERN.test(body)) {
      context.addIssue({
        code: "custom",
        path: ["body"],
        message: "comment body contains a reserved Controller marker",
      });
    }
  });

export const pullMetadataInputSchema = z
  .strictObject({
    title: boundedString(256, 1024).trim().min(1).optional(),
    body: boundedString(MAX_PULL_BODY_BYTES, MAX_PULL_BODY_BYTES).optional(),
    state: z.enum(["open", "closed"]).optional(),
    maintainerCanModify: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "at least one metadata field is required")
  .superRefine(({ title, body }, context) => {
    if (title !== undefined && RESERVED_MARKER_PATTERN.test(title)) {
      context.addIssue({
        code: "custom",
        path: ["title"],
        message: "pull request title contains a reserved Controller marker",
      });
    }
    if (body !== undefined && RESERVED_MARKER_PATTERN.test(body)) {
      context.addIssue({
        code: "custom",
        path: ["body"],
        message: "pull request body contains a reserved Controller marker",
      });
    }
  });

export const checksInputSchema = z.strictObject({});

export const githubToolInputSchemas = {
  "github.issue.labels.set": labelsInputSchema,
  "github.issue.assignees.set": assigneesInputSchema,
  "github.issue.state.update": issueStateInputSchema,
  "github.comment.create": commentInputSchema,
  "github.pull.metadata.update": pullMetadataInputSchema,
  "github.checks.read": checksInputSchema,
} as const satisfies Readonly<Record<GitHubToolId, z.ZodType>>;

const inputJsonSchemas: Readonly<Record<GitHubToolId, Readonly<Record<string, unknown>>>> = {
  "github.issue.labels.set": {
    type: "object",
    additionalProperties: false,
    required: ["labels"],
    properties: {
      labels: { type: "array", maxItems: 20, uniqueItems: true, items: { type: "string" } },
    },
  },
  "github.issue.assignees.set": {
    type: "object",
    additionalProperties: false,
    required: ["assignees"],
    properties: {
      assignees: {
        type: "array",
        maxItems: 10,
        uniqueItems: true,
        items: { type: "string" },
      },
    },
  },
  "github.issue.state.update": {
    type: "object",
    additionalProperties: false,
    required: ["state"],
    properties: {
      state: { type: "string", enum: ["open", "closed"] },
      stateReason: { type: "string", enum: ["completed", "not_planned", "reopened"] },
    },
  },
  "github.comment.create": {
    type: "object",
    additionalProperties: false,
    required: ["body"],
    properties: { body: { type: "string", minLength: 1, maxLength: MAX_COMMENT_INPUT_BYTES } },
  },
  "github.pull.metadata.update": {
    type: "object",
    additionalProperties: false,
    minProperties: 1,
    properties: {
      title: { type: "string", minLength: 1, maxLength: 256 },
      body: { type: "string", maxLength: MAX_PULL_BODY_BYTES },
      state: { type: "string", enum: ["open", "closed"] },
      maintainerCanModify: { type: "boolean" },
    },
  },
  "github.checks.read": { type: "object", additionalProperties: false },
};

const descriptions: Readonly<Record<GitHubToolId, string>> = {
  "github.issue.labels.set": "Replace labels on the current issue or pull request.",
  "github.issue.assignees.set": "Replace assignees on the current issue or pull request.",
  "github.issue.state.update": "Update the state of the current issue.",
  "github.comment.create": "Create one idempotent comment on the current issue or pull request.",
  "github.pull.metadata.update": "Update bounded metadata on the current pull request.",
  "github.checks.read": "Read bounded checks and commit statuses for the immutable bound head SHA.",
};

export const githubToolMaxCalls: Readonly<Record<GitHubToolId, number>> = {
  "github.issue.labels.set": 3,
  "github.issue.assignees.set": 3,
  "github.issue.state.update": 2,
  "github.comment.create": 3,
  "github.pull.metadata.update": 3,
  "github.checks.read": 3,
};

export type GitHubToolBinding =
  | {
      readonly repositoryId: number;
      readonly owner: string;
      readonly repo: string;
      readonly target: "issue";
      readonly entityNumber: number;
      readonly state: string;
      readonly updatedAt: string;
      readonly contentFingerprint: string;
    }
  | {
      readonly repositoryId: number;
      readonly owner: string;
      readonly repo: string;
      readonly target: "pull_request";
      readonly entityNumber: number;
      readonly headSha: string;
      readonly headRef: string;
      readonly headRepositoryId: number;
      readonly baseSha: string;
      readonly baseRef: string;
      readonly baseRepositoryId: number;
    }
  | {
      readonly repositoryId: number;
      readonly owner: string;
      readonly repo: string;
      readonly target: "workflow_run";
      readonly headSha: string;
    };

export function githubToolManifest(id: GitHubToolId): AgentToolManifest {
  return {
    id,
    description: descriptions[id],
    provider: "github",
    permissions: id === "github.checks.read" ? ["github-read"] : ["github-write"],
    inputSchema: inputJsonSchemas[id],
  };
}

export function resolveGitHubTools(
  requested: ReadonlySet<GitHubToolId>,
  disallowed: ReadonlySet<GitHubToolId>,
  policy: SecurityPolicy,
  binding: GitHubToolBinding | undefined,
  allowWrite: boolean,
): {
  readonly ids: readonly GitHubToolId[];
  readonly denials: readonly ToolDenial[];
} {
  const ids: GitHubToolId[] = [];
  const denials: ToolDenial[] = [];
  for (const id of githubToolSchema.options) {
    if (!requested.has(id) || disallowed.has(id)) continue;
    let allowed = false;
    let reason: string;
    const reasonCodes: ToolDenialReasonCode[] = [];
    if (id === "github.checks.read") {
      allowed =
        binding !== undefined &&
        binding.target !== "issue" &&
        policy.allowed &&
        policy.trust !== "untrusted" &&
        policy.capabilities.readCi;
      reason = "Checks require a trusted PR/workflow head and the readCi capability";
      if (!policy.allowed || policy.trust === "untrusted") reasonCodes.push("TRUST_REQUIRED");
      if (!policy.capabilities.readCi) reasonCodes.push("CAPABILITY_NOT_GRANTED");
      if (binding === undefined || binding.target === "issue") {
        reasonCodes.push("BINDING_UNAVAILABLE");
      }
    } else {
      const writeGate = policy.allowed && policy.trust === "trusted-write" && allowWrite;
      const entityBinding = binding !== undefined && binding.target !== "workflow_run";
      const compatibleBinding =
        entityBinding &&
        (id === "github.issue.state.update"
          ? binding.target === "issue"
          : id === "github.pull.metadata.update"
            ? binding.target === "pull_request"
            : true);
      const capabilityGranted =
        id === "github.issue.labels.set"
          ? policy.capabilities.manageIssueLabels
          : id === "github.issue.assignees.set"
            ? policy.capabilities.manageIssueAssignees
            : id === "github.issue.state.update"
              ? policy.capabilities.updateIssueState
              : id === "github.pull.metadata.update"
                ? policy.capabilities.updatePullRequestMetadata
                : policy.capabilities.publishComments;
      if (!policy.allowed || policy.trust !== "trusted-write") {
        reasonCodes.push("TRUST_REQUIRED");
      }
      if (!allowWrite) reasonCodes.push("CAPABILITY_NOT_GRANTED");
      if (!capabilityGranted) reasonCodes.push("CAPABILITY_NOT_GRANTED");
      if (!compatibleBinding) reasonCodes.push("BINDING_UNAVAILABLE");
      if (!writeGate) {
        reason = "GitHub mutation tools require trusted-write policy and allow-write=true";
      } else if (binding === undefined || binding.target === "workflow_run") {
        reason = "This GitHub mutation requires a current issue or pull request entity";
      } else if (id === "github.issue.labels.set") {
        allowed = policy.capabilities.manageIssueLabels;
        reason = "The Controller policy denies issue/PR label mutation";
      } else if (id === "github.issue.assignees.set") {
        allowed = policy.capabilities.manageIssueAssignees;
        reason = "The Controller policy denies issue/PR assignee mutation";
      } else if (id === "github.issue.state.update") {
        allowed = binding.target === "issue" && policy.capabilities.updateIssueState;
        reason = "Issue state update requires the current entity to be an issue and its capability";
      } else if (id === "github.comment.create") {
        allowed = policy.capabilities.publishComments;
        reason = "The Controller policy denies comment publication";
      } else {
        allowed =
          binding.target === "pull_request" && policy.capabilities.updatePullRequestMetadata;
        reason =
          "Pull metadata update requires the current entity to be a pull request and its capability";
      }
    }
    if (allowed) ids.push(id);
    else denials.push(createToolDenial(id, reason, reasonCodes));
  }
  return { ids, denials };
}
