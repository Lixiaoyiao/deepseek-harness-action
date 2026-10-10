import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, afterEach, expect, it, vi } from "vitest";
import type {
  DshComposition,
  PreparedDockerDshComposition,
  RunDshCompositionPreparation,
} from "../src/dsh/composition.js";
import { createDshRuntime, disposeDshRuntime, runDsh } from "../src/dsh/runner.js";
import type { DshProcessSpec } from "../src/dsh/runner.js";
import {
  CONTAINER_PACKAGE_ROOT,
  fakeProxy,
  networkInspectResult,
  request,
  createDshFixtureManager,
} from "./helpers/dsh-runner-fixtures.js";

const fixtureManager = createDshFixtureManager();
const { fixtures } = fixtureManager;
afterEach(fixtureManager.dispose);

describe("runDsh composition", () => {
  it("uses the DshComposition boundary for launch artifacts and runtime identity", async () => {
    const fixture = await fixtures();
    const runtime = await createDshRuntime(fixture.root);
    const proxy = fakeProxy();
    const customPatchPath = join(fixture.root, "composition.patch.yml");
    const customToolPolicyPath = join(fixture.root, "composition-tool-policy.patch.yml");
    await writeFile(customPatchPath, "[]\n");
    await writeFile(customToolPolicyPath, "[]\n");
    const prepare = vi.fn(() =>
      Promise.resolve({
        isolation: "none" as const,
        launchPlan: {
          command: process.execPath,
          args: ["--custom-composition", customPatchPath, customToolPolicyPath],
          cwd: fixture.workspace,
        },
      }),
    );
    const runtimeToolNames = vi.fn(() => ["read"]);
    const composition = {
      id: "test-composition",
      toolPolicyOwner: "controller",
      profileSchemaVersion: 7,
      actionManagedExtensionProfile: true,
      extensionPlanProfile: "github-action",
      assertCompatible: vi.fn(),
      promptToolPolicy: vi.fn(() => ({ policyOwner: "controller" as const, nativeTools: [] })),
      runtimeToolNames,
      requiresWebSearchProxy: vi.fn(() => false),
      isolationMetadata: vi.fn(() => ({
        repoToolsEnabled: false,
        extensionProfile: "none" as const,
        limitations: [],
      })),
      prepare,
    } satisfies DshComposition;
    let captured: DshProcessSpec | undefined;

    try {
      await runDsh(
        request({ workspacePath: fixture.workspace, dshExecutable: fixture.executable }),
        {
          assetsDirectory: fixture.assets,
          environment: { PATH: process.env.PATH },
          runtime,
          composition,
          startProxy: () => Promise.resolve(proxy),
          executeProcess: (spec) => {
            captured = spec;
            return Promise.resolve({
              stdout: JSON.stringify({
                protocolVersion: 1,
                operation: "review",
                state: "final",
                summary: "Composed.",
                findings: [],
              }),
              stderr: "",
              exitCode: 0,
              signal: null,
            });
          },
        },
      );

      expect(prepare).toHaveBeenCalledWith(
        expect.objectContaining({
          isolation: "none",
          assetsDirectory: fixture.assets,
          runtime,
          nativeTools: [],
        }),
      );
      expect(captured?.args).toContain(customPatchPath);
      expect(captured?.args).toContain(customToolPolicyPath);
      expect(runtimeToolNames).toHaveBeenCalledWith([]);
      expect(runtime.binding?.binding).toMatchObject({
        compositionId: "test-composition",
        profileSchemaVersion: 7,
        nativeRuntimeTools: ["read"],
      });
    } finally {
      await disposeDshRuntime(runtime);
    }
  });

  it("uses prepared Docker composition paths and its post-install finalizer", async () => {
    const fixture = await fixtures();
    const runtime = await createDshRuntime(fixture.root);
    const proxy = fakeProxy();
    const customPolicyPath = join(fixture.root, "custom-policy.mjs");
    const customWorkspacePath = join(fixture.root, "custom-workspace.mjs");
    const customLauncherSource = join(fixture.root, "custom-entry.mjs");
    await Promise.all([
      writeFile(customPolicyPath, "export default class CustomPolicy {}\n"),
      writeFile(customWorkspacePath, "export default class CustomWorkspace {}\n"),
      writeFile(customLauncherSource, "export default async function customEntry() {}\n"),
    ]);
    const postInstallPreparation = vi.fn();
    const finalizeAfterInstall = vi.fn(
      (runPreparation: RunDshCompositionPreparation): Promise<PreparedDockerDshComposition> =>
        runPreparation(() => {
          postInstallPreparation();
          return Promise.resolve(prepared);
        }),
    );
    const prepared: PreparedDockerDshComposition = {
      isolation: "docker",
      launchPlan: {
        command: "node",
        args: ["/opt/custom/custom-entry.mjs"],
        workdir: "/workspace",
        mounts: [
          {
            sourcePath: customLauncherSource,
            destinationPath: "/opt/custom/custom-entry.mjs",
            readOnly: true,
          },
          {
            sourcePath: customPolicyPath,
            destinationPath: "/opt/dsh-action/action-policy.mjs",
            readOnly: true,
          },
          {
            sourcePath: customWorkspacePath,
            destinationPath: "/opt/dsh-action/action-workspace.mjs",
            readOnly: true,
          },
        ],
      },
      finalizeAfterInstall,
    };
    const prepare = vi.fn(() => Promise.resolve(prepared));
    const composition = {
      id: "test-docker-composition",
      toolPolicyOwner: "controller",
      profileSchemaVersion: 9,
      actionManagedExtensionProfile: true,
      extensionPlanProfile: "github-action",
      assertCompatible: vi.fn(),
      promptToolPolicy: vi.fn(() => ({
        policyOwner: "controller" as const,
        nativeTools: ["workspace.read", "workspace.search"] as const,
      })),
      runtimeToolNames: vi.fn(() => ["glob", "grep", "read", "read_image"]),
      requiresWebSearchProxy: vi.fn(() => false),
      isolationMetadata: vi.fn(() => ({
        repoToolsEnabled: true,
        extensionProfile: "github-action" as const,
        limitations: [],
      })),
      prepare,
    } satisfies DshComposition;
    let captured: DshProcessSpec | undefined;

    try {
      await runDsh(request({ isolation: "docker", workspacePath: fixture.workspace }), {
        assetsDirectory: fixture.assets,
        environment: { PATH: process.env.PATH },
        runtime,
        composition,
        startProxy: () => Promise.resolve(proxy),
        executeProcess: (spec) => {
          const inspect = networkInspectResult(spec);
          if (inspect !== undefined) return Promise.resolve(inspect);
          const isDsh = spec.args.includes("/opt/custom/custom-entry.mjs");
          if (isDsh) captured = spec;
          return Promise.resolve({
            stdout: isDsh
              ? JSON.stringify({
                  protocolVersion: 1,
                  operation: "review",
                  state: "final",
                  summary: "Docker composition used.",
                  findings: [],
                })
              : "",
            stderr: "",
            exitCode: 0,
            signal: null,
          });
        },
      });

      expect(prepare).toHaveBeenCalledWith(
        expect.objectContaining({
          isolation: "docker",
          assetsDirectory: fixture.assets,
          runtime,
          nativeTools: ["workspace.read", "workspace.search"],
        }),
      );
      expect(finalizeAfterInstall).toHaveBeenCalledOnce();
      expect(postInstallPreparation).toHaveBeenCalledOnce();
      expect(captured?.args).toContain(`${runtime.packageRoot}:${CONTAINER_PACKAGE_ROOT}:ro`);
      expect(captured?.args).toContain(`${customPolicyPath}:/opt/dsh-action/action-policy.mjs:ro`);
      expect(captured?.args).toContain(
        `${customWorkspacePath}:/opt/dsh-action/action-workspace.mjs:ro`,
      );
      expect(captured?.args).toContain(`${customLauncherSource}:/opt/custom/custom-entry.mjs:ro`);
      expect(captured?.args).toContain("/opt/custom/custom-entry.mjs");
    } finally {
      await disposeDshRuntime(runtime);
    }
  });
});
