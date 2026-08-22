# Contributing

Thank you for improving DeepSeek Harness for GitHub.

## Local development

Use Node.js 24, then install from the committed lockfile and run the complete check:

```bash
npm ci
npm run check
```

Add regression coverage for behavior changes. Keep changes focused and preserve the Controller/worker security boundary described in [SECURITY.md](SECURITY.md).

## Pull requests

1. Create a branch from the latest `main`.
2. Make the smallest coherent change and update tests or documentation as needed.
3. Run `npm run check` and review the full diff.
4. Commit and push the branch, then open a PR to `main` with the change, risk, and verification clearly described.
5. Fix failures and revalidate the latest PR head; results from an older SHA do not qualify a newer commit.

Do not edit `dist/` by hand. Runtime changes must regenerate the committed bundle through the normal build and include the reviewed generated diff.

Any DSH version bump requires a fresh compatibility and security audit of the exact package family, lockfile, Profile/Bundle/Plugin and MCP paths, native tools, ToolRuntime, receipts, Docker/network/path/timeout behavior, and `dist` packaging. Do not use version ranges, mixed DSH versions, floating refs, or dependency-resolution bypass flags.

For release-specific steps, see [docs/maintainer-release.md](docs/maintainer-release.md). Report security vulnerabilities through GitHub private vulnerability reporting as described in [SECURITY.md](SECURITY.md#reporting-a-vulnerability).
