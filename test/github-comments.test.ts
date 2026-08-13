import { describe, expect, it, vi } from "vitest";

import { upsertTrackingComment } from "../src/github/comments.js";
import { createTrackingMarker } from "../src/review/tracking.js";

function client(comments: unknown[]) {
  const updateComment = vi.fn(() => Promise.resolve({ data: { id: 10 } }));
  const createComment = vi.fn(() => Promise.resolve({ data: { id: 11 } }));
  return {
    value: {
      paginate: vi.fn(() => Promise.resolve(comments)),
      rest: { issues: { listComments: vi.fn(), updateComment, createComment } },
    },
    updateComment,
    createComment,
  };
}

describe("tracking comment ownership", () => {
  it("updates only a marker comment owned by the expected numeric bot id", async () => {
    const fake = client([
      { id: 1, user: { id: 999 }, body: createTrackingMarker({ kind: "summary" }) },
      { id: 10, user: { id: 41898282 }, body: createTrackingMarker({ kind: "summary" }) },
    ]);
    await upsertTrackingComment(
      fake.value as never,
      { owner: "o", repo: "r", issueNumber: 1 },
      41898282,
      "summary",
      "new body",
    );
    expect(fake.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 10, body: "new body" }),
    );
    expect(fake.createComment).not.toHaveBeenCalled();
  });

  it("creates a new comment when only an attacker-spoofed marker exists", async () => {
    const fake = client([
      { id: 1, user: { id: 999 }, body: createTrackingMarker({ kind: "summary" }) },
    ]);
    await upsertTrackingComment(
      fake.value as never,
      { owner: "o", repo: "r", issueNumber: 1 },
      41898282,
      "summary",
      "new body",
    );
    expect(fake.updateComment).not.toHaveBeenCalled();
    expect(fake.createComment).toHaveBeenCalledOnce();
  });

  it("reconciles an ambiguous create success without creating a duplicate", async () => {
    const marker = createTrackingMarker({ kind: "summary" });
    const fake = client([]);
    fake.value.paginate = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 12, user: { id: 41898282 }, body: marker }]);
    fake.createComment.mockRejectedValueOnce(new Error("connection reset"));
    await expect(
      upsertTrackingComment(
        fake.value as never,
        { owner: "o", repo: "r", issueNumber: 1 },
        41898282,
        "summary",
        marker,
      ),
    ).resolves.toBe(12);
    expect(fake.createComment).toHaveBeenCalledOnce();
  });
});
