import { describe, expect, it, vi } from "vitest";

import { upsertTrackingComment } from "../src/github/comments.js";
import { createTrackingMarker } from "../src/review/tracking.js";
import { githubClientFixture } from "./helpers/github-client.js";

function client(comments: unknown[]) {
  const updateComment = vi.fn(() => Promise.resolve({ data: { id: 10 } }));
  const createComment = vi.fn(() => Promise.resolve({ data: { id: 11 } }));
  const paginate = vi.fn<(...args: unknown[]) => Promise<unknown[]>>(() =>
    Promise.resolve(comments),
  );
  return {
    value: githubClientFixture({
      paginate,
      rest: { issues: { listComments: vi.fn(), updateComment, createComment } },
    }),
    paginate,
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
      fake.value,
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

  it("forwards one controller-owned signal through list and update requests", async () => {
    const fake = client([
      { id: 10, user: { id: 41898282 }, body: createTrackingMarker({ kind: "summary" }) },
    ]);
    const controller = new AbortController();

    await upsertTrackingComment(
      fake.value,
      { owner: "o", repo: "r", issueNumber: 1 },
      41898282,
      "summary",
      "new body",
      { signal: controller.signal },
    );

    expect(fake.paginate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ request: { signal: controller.signal } }),
    );
    expect(fake.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({ request: { signal: controller.signal } }),
    );
  });

  it("creates a new comment when only an attacker-spoofed marker exists", async () => {
    const fake = client([
      { id: 1, user: { id: 999 }, body: createTrackingMarker({ kind: "summary" }) },
    ]);
    await upsertTrackingComment(
      fake.value,
      { owner: "o", repo: "r", issueNumber: 1 },
      41898282,
      "summary",
      "new body",
    );
    expect(fake.updateComment).not.toHaveBeenCalled();
    expect(fake.createComment).toHaveBeenCalledOnce();
  });

  it("stops waiting for a client that ignores cancellation", async () => {
    const fake = client([]);
    fake.paginate.mockImplementation(() => new Promise<never>(() => undefined));
    const controller = new AbortController();
    const upsert = upsertTrackingComment(
      fake.value,
      { owner: "o", repo: "r", issueNumber: 1 },
      41898282,
      "summary",
      "new body",
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(fake.paginate).toHaveBeenCalledOnce());

    controller.abort(new Error("terminal publication superseded this request"));

    await expect(upsert).rejects.toThrow("terminal publication superseded this request");
    expect(fake.createComment).not.toHaveBeenCalled();
    expect(fake.updateComment).not.toHaveBeenCalled();
  });

  it("reconciles an ambiguous create success without creating a duplicate", async () => {
    const marker = createTrackingMarker({ kind: "summary" });
    const fake = client([]);
    fake.paginate
      .mockReset()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 12, user: { id: 41898282 }, body: marker }]);
    fake.createComment.mockRejectedValueOnce(new Error("connection reset"));
    await expect(
      upsertTrackingComment(
        fake.value,
        { owner: "o", repo: "r", issueNumber: 1 },
        41898282,
        "summary",
        marker,
      ),
    ).resolves.toBe(12);
    expect(fake.createComment).toHaveBeenCalledOnce();
  });

  it("forwards the signal while reconciling an ambiguous create", async () => {
    const marker = createTrackingMarker({ kind: "summary" });
    const fake = client([]);
    const controller = new AbortController();
    fake.paginate
      .mockReset()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 12, user: { id: 41898282 }, body: marker }]);
    fake.createComment.mockRejectedValueOnce(new Error("connection reset"));

    await expect(
      upsertTrackingComment(
        fake.value,
        { owner: "o", repo: "r", issueNumber: 1 },
        41898282,
        "summary",
        marker,
        { signal: controller.signal },
      ),
    ).resolves.toBe(12);

    expect(fake.paginate).toHaveBeenCalledTimes(2);
    const paginateCalls = fake.paginate.mock.calls;
    for (const call of paginateCalls) {
      expect(call[1]).toEqual(expect.objectContaining({ request: { signal: controller.signal } }));
    }
    expect(fake.createComment).toHaveBeenCalledWith(
      expect.objectContaining({ request: { signal: controller.signal } }),
    );
  });
});
