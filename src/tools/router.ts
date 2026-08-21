import type {
  AgentToolCall,
  AgentToolManifest,
  AgentToolResult,
  ToolInvocationContext,
  ToolProvider,
} from "../agent/contracts.js";

const PROVIDER_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}(?:\.[a-z][a-z0-9-]{0,63})*$/u;
const TOOL_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}(?:\.[a-z][a-z0-9-]{0,63})+$/u;

/** Exact-ID router for Controller-hosted providers such as fixed-argv commands. */
export class ToolRouter implements ToolProvider {
  public readonly id = "router";
  private readonly routes: ReadonlyMap<string, ToolProvider>;
  private readonly manifests: readonly AgentToolManifest[];

  public constructor(private readonly providers: readonly ToolProvider[]) {
    const routes = new Map<string, ToolProvider>();
    const manifests: AgentToolManifest[] = [];
    for (const provider of providers) {
      if (!PROVIDER_ID_PATTERN.test(provider.id)) {
        throw new Error(`Invalid agent tool provider id: ${provider.id}`);
      }
      for (const manifest of provider.manifest()) {
        if (!TOOL_ID_PATTERN.test(manifest.id)) {
          throw new Error(`Invalid agent tool id: ${manifest.id}`);
        }
        if (manifest.provider !== "command") {
          throw new Error(
            `Controller provider ${provider.id} cannot claim ${manifest.provider} tools; native, MCP, and plugin tools must run through the official DSH ToolRuntime`,
          );
        }
        if (
          manifest.provider !== provider.id.split(".")[0] ||
          !manifest.id.startsWith(`${provider.id}.`)
        ) {
          throw new Error(`Tool id ${manifest.id} is outside provider namespace ${provider.id}`);
        }
        if (routes.has(manifest.id)) {
          throw new Error(`Duplicate agent tool id: ${manifest.id}`);
        }
        routes.set(manifest.id, provider);
        manifests.push(manifest);
      }
    }
    this.routes = routes;
    this.manifests = manifests;
  }

  public manifest(): readonly AgentToolManifest[] {
    return this.manifests;
  }

  public async invoke(
    call: AgentToolCall,
    context: ToolInvocationContext,
  ): Promise<AgentToolResult> {
    const provider = this.routes.get(call.id);
    if (provider === undefined) throw new Error(`Unknown or unauthorized tool: ${call.id}`);
    const result = await provider.invoke(call, context);
    if (result.id !== call.id || result.callId !== call.callId) {
      throw new Error(`Tool provider returned a mismatched result for ${call.id}`);
    }
    return result;
  }

  public async dispose(): Promise<void> {
    await Promise.all(this.providers.map(async (provider) => provider.dispose?.()));
  }
}
