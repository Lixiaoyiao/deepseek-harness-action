import { describe, expect, it } from "vitest";

import {
  buildControllerToolPolicyAudit,
  buildDshToolPolicyAudit,
  buildPermissionAudit,
  STANDARD_PERMISSION_TOOLS,
  STRICT_PERMISSION_TOOLS,
  resolvePermissionRequest,
} from "../src/permissions/profile.js";
import type { AllowedToolId } from "../src/tools/schema.js";

function sorted(values: readonly AllowedToolId[]): AllowedToolId[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

describe("permission profile presets", () => {
  it("preserves the v0.4 workspace preset in strict without adding autonomy tools", () => {
    const resolution = resolvePermissionRequest("strict", [], []);

    expect(resolution).toEqual({
      profile: "strict",
      requestedTools: sorted(STRICT_PERMISSION_TOOLS),
      disallowedTools: [],
      deniedTools: [],
    });
    expect(resolution.requestedTools.some((id) => id.startsWith("native."))).toBe(false);
  });

  it("adds the audited coding conveniences in standard", () => {
    const resolution = resolvePermissionRequest("standard", [], []);

    expect(resolution.requestedTools).toEqual(sorted(STANDARD_PERMISSION_TOOLS));
    expect(resolution.requestedTools).toEqual(
      expect.arrayContaining(["native.bash", "native.web-search", "native.subagent"]),
    );
  });

  it("keeps custom exact and does not inject workspace defaults", () => {
    const resolution = resolvePermissionRequest("custom", ["native.bash", "workspace.read"], []);

    expect(resolution.requestedTools).toEqual(["native.bash", "workspace.read"]);
    expect(resolution.requestedTools).not.toContain("workspace.edit");
  });

  it("rejects autonomy additions under strict", () => {
    expect(() => resolvePermissionRequest("strict", ["native.subagent"], [])).toThrow(
      /permission-profile strict does not expose native\.subagent/u,
    );
  });

  it("applies explicit deny after preset expansion and records the reason", () => {
    const resolution = resolvePermissionRequest(
      "standard",
      ["command.check"],
      ["native.bash", "command.check"],
    );

    expect(resolution.requestedTools).toEqual(
      expect.arrayContaining(["native.bash", "command.check"]),
    );
    expect(resolution.disallowedTools).toEqual(["command.check", "native.bash"]);
    expect(resolution.deniedTools).toEqual([
      {
        id: "command.check",
        reason: "Explicit disallowed-tools entry; deny always wins",
      },
      {
        id: "native.bash",
        reason: "Explicit disallowed-tools entry; deny always wins",
      },
    ]);
  });

  it("separates Controller-requested, effective, and denied tool policy semantics", () => {
    const resolution = resolvePermissionRequest(
      "custom",
      ["workspace.read", "native.bash", "native.web-search"],
      ["native.bash"],
    );
    const permission = buildPermissionAudit({
      resolution,
      manifests: [
        {
          id: "workspace.read",
          description: "Read workspace files",
          provider: "builtin",
          permissions: ["read"],
          inputSchema: {},
        },
      ],
      additionalDenials: [
        {
          id: "native.web-search",
          reason: "Web search requires a trusted same-repository actor and Docker",
        },
      ],
    });

    expect(permission.digest).toBe(
      "30861de79313e93a4ca8ee3c12240babeb562323365fc89031024f4b70b63693",
    );
    expect(buildControllerToolPolicyAudit(permission, "controller")).toEqual({
      schemaVersion: 1,
      policyOwner: "controller",
      requestedTools: ["native.bash", "native.web-search", "workspace.read"],
      effectiveTools: ["workspace.read"],
      deniedTools: [
        {
          id: "native.bash",
          reason: "Explicit disallowed-tools entry; deny always wins",
        },
        {
          id: "native.web-search",
          reason: "Web search requires a trusted same-repository actor and Docker",
        },
      ],
    });
    expect(buildControllerToolPolicyAudit(permission, "controller")).not.toHaveProperty(
      "observedTools",
    );
    expect(() => buildControllerToolPolicyAudit(permission, "dsh")).toThrow(
      /must report observed tools/u,
    );
  });

  it("builds a DSH-owned observed inventory without Controller policy claims", () => {
    const audit = buildDshToolPolicyAudit(["read", "grep", "glob", "read"]);

    expect(audit).toEqual({
      schemaVersion: 1,
      policyOwner: "dsh",
      observedTools: ["glob", "grep", "read"],
    });
    expect(audit).not.toHaveProperty("requestedTools");
    expect(audit).not.toHaveProperty("deniedTools");
    expect(audit).not.toHaveProperty("effectiveTools");
    expect(() => buildDshToolPolicyAudit([])).toThrow(/requires observed runtime tool names/u);
    expect(() => buildDshToolPolicyAudit(["workspace.read"])).toThrow(
      /requires observed runtime tool names/u,
    );
  });

  it("reports the physical host-gateway path instead of claiming zero worker networking", () => {
    const resolution = resolvePermissionRequest("strict", [], []);
    const baseline = buildPermissionAudit({
      resolution,
      manifests: [
        {
          id: "workspace.read",
          description: "Read workspace files",
          provider: "builtin",
          permissions: ["read"],
          inputSchema: {},
        },
      ],
    });
    const withWeb = buildPermissionAudit({
      resolution,
      manifests: [
        {
          id: "native.web-search",
          description: "Search the web through the Controller",
          provider: "builtin",
          permissions: ["read", "network"],
          inputSchema: {},
        },
      ],
    });

    expect(baseline.network).toBe("host-gateway");
    expect(withWeb.network).toBe("mediated-web");
  });
});
