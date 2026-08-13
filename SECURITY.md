# Security policy

## Reporting a vulnerability

Please use GitHub private vulnerability reporting rather than opening a public
issue. Include the affected version, event type, trust boundary and a minimal
reproduction. Do not include live credentials.

## Trust model

The GitHub controller and workflow configuration are trusted. Repository files,
diffs, CI logs, README, AGENTS.md, CLAUDE.md, issues, pull requests and comments
are untrusted data.

- `allow-write` defaults to `false`.
- Forks and `pull_request_target` are review-only. The fork workflow must check
  out only the immutable base SHA and must use `persist-credentials: false`.
- A write requires `allow-write=true`, a same-repository target, a human actor
  with write/maintain/admin permission, an unchanged bound SHA, and a container
  image referenced by its full `name@sha256:<64 lowercase hex>` digest.
- Interactive `@dsh` commands require trusted write permission even for
  review/diagnose, preventing untrusted commenters from spending model quota.
  Automatic fork review remains available but has no repository tools.
- The controller alone calls GitHub. The GitHub token is not added to DSH,
  validation, git argv, remote URLs or checkout credentials.
- DSH receives an ephemeral proxy token. A controller-side proxy injects the
  DeepSeek key only while forwarding the fixed chat-completions endpoint.
- Untrusted DSH runs disable filesystem, shell, web, skills, repository agent
  instructions, subagents and code runtime. Trusted writes enable only
  read/search/edit in a `.git`-less copy; shell remains disabled, and the
  controller validates the actual resulting files.
- Agent JSON is strict-schema validated. Paths, refs, SHAs, diff anchors,
  output sizes and comment ownership are revalidated by the controller.
- Validation commands run only after all trusted-write gates, in a disposable
  credential-free container. Network access is available for dependency
  installation, so use immutable lockfiles and pin registries/images.

## Known boundary

Version 0.1 uses Docker bridge networking so the worker can reach the local
credential proxy. The real API key and GitHub token remain outside the worker,
but destination-level worker egress is not yet enforced. Use a dedicated
self-hosted runner/network policy when source confidentiality requires hard
egress control, and pin `container-image` by digest.

The stock DSH `read-only` policy is not a read-containment boundary. This action
does not rely on it for fork isolation.

`@deepseek-ai/dsh` is installed at the exact configured version inside an
ephemeral container that has no repository mount and no credentials. Its
audited native dependency requires install scripts on Linux, and its transitive
npm dependency graph is resolved at run time in v0.1. Production users should
mirror the package in a trusted registry or prebuild and pin a reviewed
container image when supply-chain reproducibility is required.
