# DSH 0.2.1-rc.2 migration notes

These notes identify the upstream changes relevant to Action v0.10.3. They are
source research, not a claim that the Action's build, integration tests, or CI
have passed. The implementation and its test results remain authoritative.

The comparison uses the existing local `0.2.0-rc.2` source snapshot and the
official `dsh-v0.2.1-rc.2` source archive. The new release was published on
2026-10-17 and resolves to
`687f282e8625c6b8d11ff58211a90524be2e4317`.
[Release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.2),
[commit](https://github.com/deepseek-ai/deepseek-harness/commit/687f282e8625c6b8d11ff58211a90524be2e4317).

## Changes that affect this Action

| Area                 | Upstream contract                                                                                                                             | Action consequence                                                                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Headless credentials | The headless bundle disables the interactive credentials, authorization, and account rows. Adapters fall back to the launch environment.      | Keep the Controller-created environment snapshot and proxy token. Do not copy a user's interactive credentials store.                                    |
| Subagent             | `toolFilter` and `persona` are rejected; `enableRunInBackground` and `backgroundMode` are removed. Delegation uses managed child activations. | Remove obsolete tool configuration, preserve the Action's per-Agent restrictions, and exercise actual child execution.                                   |
| Base tool inventory  | The base adds `working_directory`.                                                                                                            | Controlled mode must disable its row because its workspace is fixed and this tool has no Controller grant. Native mode retains its own tool composition. |
| Search/Fetch         | A new provider package sends direct API requests to `/v1/tools/search` and `/v1/tools/fetch`.                                                 | Select it explicitly and mediate its two exact endpoints through the Controller credential proxy.                                                        |
| Flash                | The current catalog ID is `deepseek-flash`, displayed as `DeepSeek-V4.1-Flash`.                                                               | Use the API model ID in defaults/examples, while retaining explicit user-selected model IDs.                                                             |
| Session              | Logical format remains v4; headless now waits for child work before final output.                                                             | Keep current checkpoint admission and test continuation with the new runtime.                                                                            |

Sources: [headless patch](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/bundle/headless/cordis.patch.yml),
[Subagent tool](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/subagent/tool-subagent/src/index.ts),
[base patch](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/bundle/base/cordis.patch.yml),
[model catalog](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm-deepseek/src/models.ts),
[Session types](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/session/src/types.ts).

## Local plugin discovery and import

DSH's home is an explicit configured path, otherwise a nonblank `DSH_HOME`,
otherwise `path.join(os.homedir(), ".dsh")`. The resolver expands `~`, `~/`,
and `~\`. Profiles live under `<home>/profiles/<profile-name>/`.
[Home paths](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/util/home-paths/src/index.ts),
[profile paths](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/boot/app-boot/src/profile.ts).

The plugin manager uses ordinary Profile package state:

- `package.json` → `dependencies`: package-manager keys and requested sources.
- `node_modules/<dependency-key>/package.json`: installed name and exact version.
- Installed `package.json` → `dsh.bundle.patch`: a Bundle's patch file or ordered
  patch-file list.
- Profile `package.json` → `dsh.profile.bundles`: enabled Bundle layers.
- `cordis.patch.yml`: Profile-specific row configuration and overrides.

There is no separate `.dsh/plugins` inventory in this path. The manager's
`.plugin-manager/run.json` and `.plugin-manager/logs/` record package-manager
operations, not installed plugin selections. Its remembered installation
registry is a process-local map; it is not a portable registry manifest.
[Inventory reader](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/boot/app-boot/src/profile-plugins.ts),
[plugin manager](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/boot/plugin-manager/src/index.ts),
[package operations](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/boot/plugin-manager/src/operations.ts).

A DSH Bundle and a direct Cordis plugin are different import cases. A Bundle
declares `dsh.bundle.patch` and activates through `dsh.profile.bundles`. A direct
Cordis plugin needs an explicit loader row and configuration. A plain npm
dependency without either activation contract is not automatically a plugin.
The official inventory can report installed but disabled Bundles, and missing
installed metadata must not be presented as a verified installed version.
[Bundle reconciliation](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/boot/app-boot/src/profile-plugins.ts),
[CLI plugin command](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/apps/cli/src/plugin.ts).

The official compatibility check evaluates `engines.dsh` when present;
otherwise it evaluates every `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*` peer.
It uses `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`.
For peers only, `workspace:^`, `workspace:~`, and `workspace:*` resolve to the
current runtime. Missing compatibility declarations mean that no incompatibility
was declared; they are not independent evidence of runtime compatibility.
Exact-version overrides live in `<profile>/compatibility.json`, separate from
the package manifest. The installer should not migrate those overrides.
[Compatibility evaluator](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/boot/app-boot/src/plugin-compatibility.ts),
[compatibility file](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/boot/app-boot/src/profile-compatibility.ts).

For this Action, the smallest portable import is an explicitly selected npm
package at its installed exact version, expressed through the existing Bundle
or Plugin inputs. Read JSON metadata without importing plugin modules. Do not
copy `.env`, `.credentials.yaml`, local patch configuration, npm authentication,
or local compatibility overrides. Show a short reason for local-path packages,
unavailable package metadata, or incompatible versions. Native can use its
existing definition-only extension plan; Controlled still needs the existing
tool declarations and grants. Metadata discovery must not invent those grants.
These are Action integration decisions derived from the upstream layout and
the existing [extension contract](extension-contracts.md).

## Launcher and Headless

`loadProfile`, `createRuntimeResolution`, and `PluginPackages` remain exported
from `@deepseek-ai/dsh-app-boot`. `PluginPackages` still accepts
`new PluginPackages(ctx, { resolution })`, also usable through
`ctx.plugin(PluginPackages, { resolution })`. `boot` retains its first four
arguments and adds an optional fifth `bareModuleBaseUrl`. It now audits required
startup entries after Loader settlement. Keep the Action's explicit admitted
extension activation check, because upstream treats some optional entry
failures as warnings.
[Boot](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/boot/app-boot/src/index.ts),
[package-resolution service](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/boot/app-boot/src/profile-resolution/service.ts).

The official headless template remains `[dsh-base, dsh-headless]`. Its CLI
continues to accept the literal task, `--json`, and `--session-id`. The runner
now alternates parent-idle and `subagents.waitForChildren(parent)` until child
work has settled. It also retains an `agent/error` unless a later durable
`turn/end` supersedes it. JSON-stream decoding still requires the Action's
strict final-result validation.
[Profile templates](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/boot/app-boot/src/profile.ts),
[headless runner](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/bundle/headless/src/index.ts).

The interactive credential provider gives its managed store precedence over
environment fallbacks. Headless disables that provider, authorization, and
DeepSeek account services; API-key adapters use the launch environment when
the credential service is absent. This matches the Action's separate runtime
home and Controller-provided proxy credential.
[Credential precedence](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/credentials/credentials-local/src/index.ts),
[headless patch](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/bundle/headless/cordis.patch.yml).

## Subagent and Session

`@deepseek-ai/dsh-subagent-in-process-driver` and `@deepseek-ai/dsh-invariants`
are absent from the new source tree. The spawn provider now prepares managed
local children instead of calling `startInProcessRun`. `tool-subagent` rejects
`persona` and `toolFilter` explicitly; its replacement composition options are
`agentPreset` and `allowedAgentPresets`. Omitted preset selection inherits the
parent composition. The Action already applies restrictions and guards to each
created Agent, so preserving that mechanism is preferable to adding a new
preset layer just to replace the removed duplicate filter.
[Spawn provider](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/subagent/subagent-spawn-in-process/src/index.ts),
[tool configuration](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/subagent/tool-subagent/src/index.ts),
[child composition](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/subagent/subagent/src/child-agent.ts).

The Session logical format remains `4`; the compared format-catalog source is
unchanged. Core adds experimental ignorable `plugin:` records, and JSONL
persistence has recovery/lease changes. Those are reasons to run the existing
real persistence and continuation tests, not to loosen the Action checkpoint
schema or replay historical authorization. The Action's text-only checkpoint
admission and current-run permission refresh remain necessary.
[Session implementation](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/session/src/index.ts),
[catalog](https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317/packages/session/session-format-catalog/src),
[JSONL persistence](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/session/session-persistence-jsonl/src/index.ts).

## DeepSeek Flash and Search/Fetch

`deepseek-flash` is the new catalog ID. The catalog marks it as accepting text
and images, with `systemPromptUpdate: "in-history"` and
`toolUpdate: "addition-only"`. This does not itself add image/checkpoint support
to the Action. The release's `DeepSeek-V4.1-Flash-1017` product name is not the
API model ID.
[Official catalog](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm-deepseek/src/models.ts).

`@deepseek-ai/dsh-web-deepseek-api` registers `deepseek-search-api` and
`deepseek-fetch-api`. Configure `web.searchProvider` and `web.fetchProvider`
to select them, and configure `web-deepseek-api.baseURL` to the worker proxy's
fixed tools base. The new provider does not read `DEEPSEEK_SEARCH_BASE_URL`;
that variable belongs to the retained older auxiliary-model search provider.
The official base still selects `deepseek-official` search and `http` fetch by
default, so installing the new version alone does not switch APIs.
[Provider configuration](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/web/web-deepseek-api/src/index.ts),
[base composition](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/bundle/base/cordis.patch.yml),
[older search provider](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/web/web-search-deepseek/src/index.ts).

The direct API defaults to `https://api.deepseek.com/v1/tools`:

| Operation | Request                                                                | Response consumed by DSH                                        |
| --------- | ---------------------------------------------------------------------- | --------------------------------------------------------------- |
| Search    | `POST /search`, `{ query, count, need_content: false, ori_question? }` | `results[]` with `url`, `title`, `snippet`, and nullable `date` |
| Fetch     | `POST /fetch`, `{ url }`                                               | `{ content: string }`, interpreted as retrieved page text       |

Both use `Authorization: Bearer <key>`, reject redirects, and have no auxiliary
model request. Search count defaults to 10; the configured limit is 1–50.
The optional original question is bounded to 128 characters. Existing
Controller request/response limits and explicit tool authorization should
continue to govern these calls. A search-only grant must not implicitly grant
Fetch; Native retains DSH tool ownership.
[Search transport](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/web/web-deepseek-api/src/search.ts),
[Fetch transport](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/web/web-deepseek-api/src/fetch.ts),
[authentication and HTTP handling](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/web/web-deepseek-api/src/transport.ts).

## Implementation and validation

The Action pins all 295 locked DSH package entries to `0.2.1-rc.2` and updates
Cordis to `4.0.5` with plugin-group `1.0.5`. The removed invariants and
in-process-driver packages are no longer declared. Headless startup continues
to use only the run-scoped proxy credential. Controlled disables the new
working-directory tool and uses its existing per-Agent tool restrictions for
managed Subagents.

On 2026-10-17, live local runs through both production launchers completed model
requests, Search and Fetch through the Controller proxy, with HTTP 200 for each
upstream request and valid final JSON. A separate Controlled Subagent run
completed a managed child; every model request exposed only the admitted
`subagent` tool. These are local runtime checks; Docker and workflow execution
are checked independently by CI.

Real Session creation/restoration, current-permission downgrade, rejected
historical input, and successful/error tool-result pruning pass the existing
worker admission suite on the new runtime. Local plugin-import tests cover
Native configuration, explicitly named Controlled tools, declined confirmation
and incompatible-package rejection. The installer reads package metadata only.

The official npm audit reports 8 moderate affected package entries, all from
the upstream Office chain's nested `fflate@0.8.2`; there are no high or critical
entries. The root decoder uses `fflate@0.8.3`. This upgrade does not add Office
attachment transport or override upstream dependency pins.

Custom `web-search-base-url` values preserve their existing Messages protocol; the default selects the new Search API. A Fetch-only Controlled grant starts without requiring a Search route. Both cases are covered through the proxy and runner interfaces.
