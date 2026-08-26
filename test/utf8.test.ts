import { describe, expect, it } from "vitest";

import { boundedText } from "../src/orchestration/context.js";
import { utf8Prefix, utf8Suffix } from "../src/security/utf8.js";

const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");

describe("UTF-8 byte bounds", () => {
  it("returns complete prefix and suffix code points for every small cap", () => {
    const value = "A路径🙂e\u0301Z";
    const raw = Buffer.from(value, "utf8");
    for (let cap = 0; cap <= raw.byteLength + 1; cap += 1) {
      for (const candidate of [
        utf8Prefix(value, cap),
        utf8Suffix(value, cap),
        utf8Prefix(raw, cap),
        utf8Suffix(raw, cap),
      ]) {
        expect(byteLength(candidate)).toBeLessThanOrEqual(cap);
        expect(candidate).not.toContain("\uFFFD");
      }
      expect(value.startsWith(utf8Prefix(value, cap))).toBe(true);
      expect(value.endsWith(utf8Suffix(value, cap))).toBe(true);
    }
  });

  it("drops incomplete UTF-8 boundary bytes instead of decoding replacement characters", () => {
    const emoji = Buffer.from("🙂", "utf8");
    expect(utf8Prefix(emoji.subarray(0, 3), 3)).toBe("");
    expect(utf8Suffix(emoji.subarray(1), 3)).toBe("");
    expect(utf8Prefix(Buffer.from([0xff]), 1)).toBe("");
    expect(utf8Suffix(Buffer.from([0xff]), 1)).toBe("");
  });

  it("stops at ill-formed UTF-16 instead of encoding lone surrogates as replacement characters", () => {
    expect(utf8Prefix(`ok\ud800tail`, 64)).toBe("ok");
    expect(utf8Prefix(`\ud800tail`, 64)).toBe("");
    expect(utf8Suffix(`head\udc00ok`, 64)).toBe("ok");
    expect(utf8Suffix(`head\udc00`, 64)).toBe("");
    for (const value of [utf8Prefix(`ok\ud800tail`, 64), utf8Suffix(`head\udc00ok`, 64)]) {
      expect(Buffer.from(value, "utf8").toString("utf8")).not.toContain("\uFFFD");
    }
  });

  it("keeps marker truncation within zero, one-byte, and marker-minus-one caps", () => {
    const marker = "\n[truncated by dsh-action]";
    for (const cap of [0, 1, byteLength(marker) - 1]) {
      const result = boundedText("路径🙂".repeat(100), cap);
      expect(byteLength(result)).toBeLessThanOrEqual(cap);
      expect(result).not.toContain("\uFFFD");
      expect(marker.startsWith(result)).toBe(true);
    }
  });
});
