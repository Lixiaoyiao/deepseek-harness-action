# Contributing

Thank you for improving DeepSeek Harness for GitHub.

## Local development

Use Node.js 24, then install from the committed lockfile and run the complete check:

```bash
npm ci
npm run check
```

Windows runs the same suite with two Vitest workers because the integration
tests start real DSH and Git processes with fixed startup deadlines. Linux
keeps the default parallelism. Test assertions and execution deadlines remain
the same on both platforms.

Add regression coverage for behavior changes. Keep changes focused and preserve the Controller/worker security boundary described in [SECURITY.md](SECURITY.md).

Design modules around a small interface that hides real ordering and ownership
rules. Keep changes local to their owner; share an abstraction only when two
real paths need it. Review the complete lifecycle before adding a local branch
or callback. The current ownership map and agreed behavior-test interfaces are
in [ARCHITECTURE.md](ARCHITECTURE.md#module-design-and-lifecycle).

Test behavior through those interfaces with real internal policy, validation
and state transitions. Replace external GitHub, model, Docker or process
transports; avoid mocking every internal collaborator. Type assertions are
checked by default. Any narrow external-library exemption must explain the
actual contract mismatch at the assertion, rather than suppressing a whole
module. Resource budgets and their tradeoffs are in
[docs/resource-limits.md](docs/resource-limits.md); runtime host requirements are
in [docs/dsh-runtime.md](docs/dsh-runtime.md).

Public Action input metadata is defined in `src/action-contract.ts`. After an
input metadata change, run `npm run generate:action-contract` and review the
generated `action.yml`, configuration tables, and installer subset. The full
check fails if those artifacts drift.

## Pull requests

1. Create a branch from the latest `main`.
2. Make the smallest coherent change and update tests or documentation as needed.
3. Run `npm run check` and review the full diff.
4. Commit and push the branch, then open a PR to `main` with the change, risk, and verification clearly described.
5. Fix failures and revalidate the latest PR head; results from an older SHA do not qualify a newer commit.

Do not edit `dist/` by hand. Runtime changes must regenerate the committed bundle through the normal build and include the reviewed generated diff.

Any DSH version bump requires a fresh compatibility and security audit of the exact package family, lockfile, Profile/Bundle/Plugin and MCP paths, native tools, ToolRuntime, receipts, Docker/network/path/timeout behavior, and `dist` packaging. Do not use version ranges, mixed DSH versions, floating refs, or dependency-resolution bypass flags.

For release-specific steps, see [docs/maintainer-release.md](docs/maintainer-release.md). Report security vulnerabilities through GitHub private vulnerability reporting as described in [SECURITY.md](SECURITY.md#reporting-a-vulnerability).
