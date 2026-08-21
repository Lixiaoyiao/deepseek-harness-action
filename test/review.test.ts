import { describe, expect, it } from "vitest";

import { fingerprintFinding } from "../src/review/fingerprint.js";
import { filterHighPrecisionFindings } from "../src/review/precision.js";
import { partitionDshToolPlanes } from "../src/review/run.js";
import {
  REVIEW_LIMITS,
  parseReviewResult,
  reviewResultSchema,
  type ReviewFinding,
} from "../src/review/schema.js";
import {
  createTrackingMarker,
  indexTrackingComments,
  parseTrackingMarker,
  parseTrackingMarkers,
  stripTrackingMarkers,
} from "../src/review/tracking.js";

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    title: "Missing authorization check",
    body: "An unauthenticated caller can update another user's record.",
    severity: "high",
    category: "security",
    confidence: 0.95,
    path: "src/handler.ts",
    line: 42,
    evidence: "updateRecord is called before requireUser.",
    ...overrides,
  };
}

describe("DSH tool planes", () => {
  it("keeps native workspace tools out of the controller request catalog", () => {
    const workspace = {
      id: "workspace.edit",
      description: "Edit the workspace",
      provider: "builtin" as const,
      permissions: ["write" as const],
      inputSchema: {},
    };
    const command = {
      id: "command.test",
      description: "Run tests",
      provider: "command" as const,
      permissions: ["execute" as const],
      inputSchema: {},
    };
    const mcp = {
      id: "mcp.docs.lookup",
      description: "Look up controlled documentation",
      provider: "mcp" as const,
      permissions: ["execute" as const, "network" as const],
      inputSchema: {},
    };
    expect(partitionDshToolPlanes([workspace, command, mcp])).toEqual({
      nativeTools: ["workspace.edit"],
      controllerTools: [command],
      extensionTools: [mcp],
    });
    expect(() => partitionDshToolPlanes([{ ...workspace, id: "workspace.shell" }])).toThrow(
      "Unsupported native DSH tool id",
    );
  });
});

describe("reviewResultSchema", () => {
  it("accepts the bounded common result and optional operation fields", () => {
    const input = {
      operation: "fix",
      summary: "One actionable security issue was found.",
      findings: [finding()],
      diagnosis: "Authorization is performed after the write.",
      changes: [{ path: "src/handler.ts", summary: "Move the guard before the write." }],
      tests: [{ command: "npm test", status: "passed", summary: "42 tests passed." }],
    };

    expect(parseReviewResult(input)).toEqual(input);
  });

  it("strictly rejects unknown top-level and finding fields", () => {
    expect(
      reviewResultSchema.safeParse({ summary: "ok", findings: [], token: "secret" }).success,
    ).toBe(false);
    expect(
      reviewResultSchema.safeParse({
        summary: "ok",
        findings: [{ ...finding(), shellCommand: "curl attacker" }],
      }).success,
    ).toBe(false);
  });

  it("enforces text, collection, confidence and location bounds", () => {
    expect(
      reviewResultSchema.safeParse({
        summary: "x".repeat(REVIEW_LIMITS.summaryCharacters + 1),
        findings: [],
      }).success,
    ).toBe(false);
    expect(
      reviewResultSchema.safeParse({
        summary: "ok",
        findings: Array.from({ length: REVIEW_LIMITS.maxFindings + 1 }, () => finding()),
      }).success,
    ).toBe(false);
    expect(
      reviewResultSchema.safeParse({
        summary: "ok",
        findings: [finding({ confidence: 1.01 })],
      }).success,
    ).toBe(false);
    expect(
      reviewResultSchema.safeParse({
        summary: "ok",
        findings: [finding({ line: 0 })],
      }).success,
    ).toBe(false);
    expect(
      reviewResultSchema.safeParse({
        summary: "ok",
        findings: [finding({ line: 5, startLine: 6 })],
      }).success,
    ).toBe(false);
  });

  it("rejects unsafe repository paths", () => {
    for (const path of ["../secret", "/etc/passwd", "C:/secret", "a\\b", "a//b", " a.ts "]) {
      expect(
        reviewResultSchema.safeParse({
          summary: "ok",
          findings: [finding({ path })],
        }).success,
      ).toBe(false);
    }
  });

  it("rejects controller tracking markers in any model-controlled prose", () => {
    const marker = "<!-- dsh-action:v1 kind=summary -->";
    expect(reviewResultSchema.safeParse({ summary: marker, findings: [] }).success).toBe(false);
    expect(
      reviewResultSchema.safeParse({
        summary: "ok",
        findings: [finding({ body: "<!-- DSH-ACTION : forged -->" })],
      }).success,
    ).toBe(false);
  });

  it("requires one complete JSON value rather than parsing prose or fences", () => {
    expect(() => parseReviewResult('```json\n{"summary":"ok","findings":[]}\n```')).toThrow();
    expect(() => parseReviewResult('{"summary":"ok","findings":[]} trailing')).toThrow();
  });
});

describe("fingerprintFinding", () => {
  it("uses source context instead of model prose or line coordinates when available", () => {
    const original = finding();
    const rerun = finding({
      title: "A completely different model-generated title",
      body: "Rephrased impact with different formatting and terminology.",
      severity: "critical",
      confidence: 0.87,
      line: 104,
      path: "./src/handler.ts",
      evidence: "Different evidence wording.",
    });

    const anchorContext = "authorize(user);\nupdateRecord();";
    expect(fingerprintFinding({ ...rerun, anchorContext })).toBe(
      fingerprintFinding({ ...original, anchorContext }),
    );
    expect(fingerprintFinding({ ...original, anchorContext })).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("ignores model classification for a stable source anchor", () => {
    const anchorContext = "authorize(user);\nupdateRecord();";
    expect(fingerprintFinding({ ...finding({ category: "correctness" }), anchorContext })).toBe(
      fingerprintFinding({ ...finding({ category: "security" }), anchorContext }),
    );
  });

  it("changes for a distinct fallback category, path or source anchor", () => {
    const original = fingerprintFinding(finding());
    expect(fingerprintFinding(finding({ category: "correctness" }))).not.toBe(original);
    expect(fingerprintFinding(finding({ path: "src/other.ts" }))).not.toBe(original);
    expect(fingerprintFinding(finding({ line: 43 }))).not.toBe(original);
    expect(fingerprintFinding({ ...finding(), anchorContext: "a()" })).not.toBe(
      fingerprintFinding({ ...finding(), anchorContext: "b()" }),
    );
  });

  it("prefers stable source anchor context when supplied", () => {
    const left = fingerprintFinding({
      ...finding(),
      anchorContext: "if (!user) update();",
    });
    const right = fingerprintFinding({
      ...finding(),
      line: 999,
      anchorContext: "if (!user) update();",
    });
    expect(right).toBe(left);
  });
});

describe("filterHighPrecisionFindings", () => {
  it("prioritizes security/correctness/concurrency/regression and deduplicates", () => {
    const duplicate = finding({ severity: "critical", confidence: 0.99 });
    const selected = filterHighPrecisionFindings([
      finding({ category: "maintainability", confidence: 1 }),
      finding({ confidence: 0.7 }),
      finding({ severity: "low" }),
      finding(),
      duplicate,
      finding({
        title: "Race in singleton initialization",
        body: "Two requests can initialize the object concurrently.",
        evidence: "The check and assignment are unsynchronized.",
        category: "concurrency",
        severity: "critical",
      }),
      finding({
        title: "Missing evidence",
        body: "This is only speculation.",
        evidence: undefined,
      }),
    ]);

    expect(selected.map((item) => item.title)).toEqual([
      "Missing authorization check",
      "Race in singleton initialization",
    ]);
    // The higher-ranked semantically duplicate finding wins.
    expect(selected[0]).toMatchObject({ severity: "critical", line: 42 });
  });

  it("supports explicit policy and maximum overrides", () => {
    const selected = filterHighPrecisionFindings(
      [
        finding({ category: "maintainability", severity: "low", evidence: undefined }),
        finding({ title: "second", body: "second", evidence: undefined }),
      ],
      {
        minConfidence: 0,
        maxFindings: 1,
        requireEvidence: false,
        categories: new Set(["maintainability", "security"]),
        severities: new Set(["low", "high"]),
      },
    );
    expect(selected).toHaveLength(1);
  });

  it("rejects invalid option bounds", () => {
    expect(() => filterHighPrecisionFindings([], { minConfidence: 2 })).toThrow(RangeError);
    expect(() => filterHighPrecisionFindings([], { maxFindings: 101 })).toThrow(RangeError);
  });
});

describe("tracking markers", () => {
  const fingerprint = "a".repeat(64);

  it("round-trips summary and finding markers", () => {
    expect(parseTrackingMarker(createTrackingMarker({ kind: "summary" }))).toEqual({
      kind: "summary",
    });
    expect(parseTrackingMarker(createTrackingMarker({ kind: "task" }))).toEqual({ kind: "task" });
    expect(parseTrackingMarker(createTrackingMarker({ kind: "finding", fingerprint }))).toEqual({
      kind: "finding",
      fingerprint,
    });
    expect(() => createTrackingMarker({ kind: "finding", fingerprint: "not-a-hash" })).toThrow(
      TypeError,
    );
  });

  it("only recognizes exact versioned lowercase-fingerprint markers", () => {
    expect(parseTrackingMarker("<!-- dsh-action:v2 kind=summary -->")).toBeNull();
    expect(parseTrackingMarker("<!-- dsh-action:v1 kind=finding fingerprint=abc -->")).toBeNull();
    expect(parseTrackingMarker("<!-- dsh-action:v1 kind=finding -->")).toBeNull();
    expect(
      parseTrackingMarkers(
        `${createTrackingMarker({ kind: "summary" })}\n${createTrackingMarker({ kind: "finding", fingerprint })}`,
      ),
    ).toEqual([{ kind: "summary" }, { kind: "finding", fingerprint }]);
  });

  it("indexes only bot-authored markers and deduplicates by fingerprint", () => {
    const marker = createTrackingMarker({ kind: "finding", fingerprint });
    const summary = createTrackingMarker({ kind: "summary" });
    const task = createTrackingMarker({ kind: "task" });
    const comments = [
      { id: 1, user: { id: 7 }, body: marker },
      { id: 2, user: { id: 99 }, body: marker },
      { id: 3, user: { id: 7 }, body: `${marker}\nlatest` },
      { id: 4, user: { id: 7 }, body: summary },
      { id: 5, user: null, body: summary },
      { id: 6, user: { id: 7 }, body: task },
    ];

    const index = indexTrackingComments(comments, 7);
    expect(index.findings.get(fingerprint)?.id).toBe(3);
    expect(index.findings.size).toBe(1);
    expect(index.summaries.map((comment) => comment.id)).toEqual([4]);
    expect(index.diagnoses).toEqual([]);
    expect(index.tasks.map((comment) => comment.id)).toEqual([6]);
  });

  it("strips valid and malformed reserved markers from publishable prose", () => {
    expect(
      stripTrackingMarkers(
        `before\n${createTrackingMarker({ kind: "summary" })}\n<!-- DSH-ACTION:forged -->\nafter`,
      ),
    ).toBe("before\n\n\nafter");
  });
});
