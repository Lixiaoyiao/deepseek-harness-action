import { DshConfigurationError } from "./errors.js";

/** Parse a Controller-owned upstream URL without allowing plaintext remote traffic or userinfo. */
export function validatedControllerBaseUrl(raw: string, label: string): URL {
  let base: URL;
  try {
    base = new URL(raw);
  } catch (error: unknown) {
    throw new DshConfigurationError(`${label} is invalid`, { cause: error });
  }
  const loopbackHttp =
    base.protocol === "http:" &&
    (base.hostname === "127.0.0.1" || base.hostname === "::1" || base.hostname === "localhost");
  if (base.protocol !== "https:" && !loopbackHttp) {
    throw new DshConfigurationError(`${label} must use HTTPS (except loopback tests)`);
  }
  if (base.username !== "" || base.password !== "") {
    throw new DshConfigurationError(`${label} must not contain credentials`);
  }
  return base;
}
