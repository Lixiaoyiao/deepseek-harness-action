type Utf8Value = string | Uint8Array;

function isLoneSurrogate(character: string): boolean {
  if (character.length !== 1) return false;
  const codeUnit = character.charCodeAt(0);
  return codeUnit >= 0xd800 && codeUnit <= 0xdfff;
}

function byteLimit(byteCap: number, byteLength: number): number {
  if (Number.isNaN(byteCap) || byteCap <= 0) return 0;
  return Math.min(byteLength, Math.floor(byteCap));
}

function decodePrefix(raw: Uint8Array, limit: number): string {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = limit; end >= Math.max(0, limit - 3); end -= 1) {
    try {
      return decoder.decode(raw.subarray(0, end));
    } catch {
      // A UTF-8 code point is at most four bytes, so at most three trailing
      // bytes can belong to a code point crossing the boundary.
    }
  }
  return "";
}

function decodeSuffix(raw: Uint8Array, limit: number): string {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const initial = raw.byteLength - limit;
  for (let start = initial; start <= Math.min(raw.byteLength, initial + 3); start += 1) {
    try {
      return decoder.decode(raw.subarray(start));
    } catch {
      // Skip at most the three continuation bytes that can cross the boundary.
    }
  }
  return "";
}

/** Return the longest complete-code-point prefix within a UTF-8 byte cap. */
export function utf8Prefix(value: Utf8Value, byteCap: number): string {
  if (typeof value !== "string") {
    return decodePrefix(value, byteLimit(byteCap, value.byteLength));
  }

  const limit = byteLimit(byteCap, Buffer.byteLength(value, "utf8"));
  let bytes = 0;
  let end = 0;
  for (const character of value) {
    if (isLoneSurrogate(character)) break;
    const width = Buffer.byteLength(character, "utf8");
    if (bytes + width > limit) break;
    bytes += width;
    end += character.length;
  }
  return value.slice(0, end);
}

/** Return the longest complete-code-point suffix within a UTF-8 byte cap. */
export function utf8Suffix(value: Utf8Value, byteCap: number): string {
  if (typeof value !== "string") {
    return decodeSuffix(value, byteLimit(byteCap, value.byteLength));
  }

  const limit = byteLimit(byteCap, Buffer.byteLength(value, "utf8"));
  let bytes = 0;
  let start = value.length;
  while (start > 0) {
    let characterStart = start - 1;
    const lastCodeUnit = value.charCodeAt(characterStart);
    if (
      lastCodeUnit >= 0xdc00 &&
      lastCodeUnit <= 0xdfff &&
      characterStart > 0 &&
      value.charCodeAt(characterStart - 1) >= 0xd800 &&
      value.charCodeAt(characterStart - 1) <= 0xdbff
    ) {
      characterStart -= 1;
    }
    const character = value.slice(characterStart, start);
    if (isLoneSurrogate(character)) break;
    const width = Buffer.byteLength(character, "utf8");
    if (bytes + width > limit) break;
    bytes += width;
    start = characterStart;
  }
  return value.slice(start);
}
