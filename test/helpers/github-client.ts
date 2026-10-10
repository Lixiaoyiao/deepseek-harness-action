import { getOctokit } from "@actions/github";
import { vi } from "vitest";

import type { GitHubClient } from "../../src/github/client.js";
import { record } from "../../src/security/record.js";

interface GitHubTransportFixture {
  readonly rest?: Readonly<Record<string, Readonly<Record<string, (...args: never[]) => unknown>>>>;
  readonly paginate?: (...args: never[]) => unknown;
  readonly request?: (...args: never[]) => unknown;
}

/** A real Octokit client with only external REST/pagination transport replaced.
 * Fixture responses may intentionally be incomplete or malformed. Unconfigured
 * endpoints fail locally so a test can never fall through to the GitHub network.
 */
export function githubClientFixture(fixture: GitHubTransportFixture = {}): GitHubClient {
  const client = getOctokit("test-fixture-token");
  client.hook.wrap("request", () => {
    throw new Error("Unexpected real GitHub transport in a test fixture");
  });
  const resources = record(client.rest);
  for (const [resource, methods] of Object.entries(fixture.rest ?? {})) {
    const target = record(resources[resource]);
    for (const [method, handler] of Object.entries(methods)) {
      if (typeof target[method] !== "function") {
        throw new Error(`Unknown Octokit fixture endpoint: ${resource}.${method}`);
      }
      Object.defineProperty(target, method, { value: handler, configurable: true, writable: true });
    }
  }
  if (fixture.paginate !== undefined) {
    Object.defineProperty(client, "paginate", {
      value: fixture.paginate,
      configurable: true,
      writable: true,
    });
  }
  if (fixture.request !== undefined) {
    Object.defineProperty(client, "request", {
      value: fixture.request,
      configurable: true,
      writable: true,
    });
  }
  return client;
}

/** Narrow only decorated external transport mocks; real SDK methods are rejected. */
export function githubTransportMock(value: unknown) {
  if (!vi.isMockFunction(value)) throw new Error("Expected a GitHub transport fixture mock");
  return value;
}
