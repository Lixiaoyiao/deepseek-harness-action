import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { parseDocument } from "yaml";

import {
  ACTION_TAG,
  ACTION_VERSION,
  DIRECT_DSH_PACKAGES,
  DSH_VERSION,
  RELEASE_CANARY_VARIABLE,
} from "../src/release.ts";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const dshPackage = (name) => name === "@deepseek-ai/dsh" || name.startsWith("@deepseek-ai/dsh-");
function yaml(source, name) {
  const document = parseDocument(source, { strict: true, uniqueKeys: true });
  assert.deepEqual(document.errors, [], `${name} must be valid YAML`);
  return document.toJS({ maxAliasCount: 0 });
}

const [
  manifestText,
  lockText,
  action,
  canary,
  installerManifestText,
  installerLockText,
  installerReadme,
  rootReadme,
  rootReadmeZh,
  setupGuide,
  setupGuideZh,
  changelog,
  maintainerReleaseGuide,
  installerRuntime,
  installerReview,
  installerCommands,
  installerSession,
] = await Promise.all([
  read("package.json"),
  read("package-lock.json"),
  read("action.yml"),
  read(".github/workflows/release-canary.yml"),
  read("packages/create-deepseek-harness-action/package.json"),
  read("packages/create-deepseek-harness-action/package-lock.json"),
  read("packages/create-deepseek-harness-action/README.md"),
  read("README.md"),
  read("README.zh-CN.md"),
  read("docs/setup.md"),
  read("docs/setup.zh-CN.md"),
  read("CHANGELOG.md"),
  read("docs/maintainer-release.md"),
  read("packages/create-deepseek-harness-action/src/installer.mjs"),
  read("packages/create-deepseek-harness-action/src/templates/dsh-review.yml"),
  read("packages/create-deepseek-harness-action/src/templates/dsh-commands.yml"),
  read("packages/create-deepseek-harness-action/src/templates/dsh-session.yml"),
]);
const manifest = JSON.parse(manifestText);
const lock = JSON.parse(lockText);
const installerManifest = JSON.parse(installerManifestText);
const installerLock = JSON.parse(installerLockText);
const installerVersion = installerManifest.version;
const installerActionTag = "v0.10.3";
const installerSourceTag = `create-deepseek-harness-action-v${installerVersion}`;
const installerReleaseBinding = "DSH_ACTION_RELEASE_SHA";
const directDependencies = {
  ...(manifest.dependencies ?? {}),
  ...(manifest.devDependencies ?? {}),
};

assert.equal(manifest.version, ACTION_VERSION, "package.json version drifted from src/release.ts");
assert.equal(lock.version, ACTION_VERSION, "package-lock.json version drifted from src/release.ts");
assert.equal(
  lock.packages?.[""]?.version,
  ACTION_VERSION,
  "package-lock.json root package version drifted from src/release.ts",
);
assert.equal(
  manifest.scripts?.["test:release-contract"],
  "node scripts/verify-release-contract.mjs",
  "package.json must expose the release contract verifier",
);
assert.match(
  manifest.scripts?.check ?? "",
  /(?:^|&&\s*)npm run test:release-contract(?:\s*&&|$)/u,
  "the full local check must run the release contract verifier",
);

assert.deepEqual(
  Object.keys(directDependencies).filter(dshPackage).sort(),
  [...DIRECT_DSH_PACKAGES].sort(),
  "direct DSH package inventory drifted from src/release.ts",
);
for (const packageName of DIRECT_DSH_PACKAGES) {
  assert.equal(
    directDependencies[packageName],
    DSH_VERSION,
    `${packageName} must use the exact audited DSH version`,
  );
  assert.equal(
    lock.packages?.[""]?.dependencies?.[packageName] ??
      lock.packages?.[""]?.devDependencies?.[packageName],
    DSH_VERSION,
    `${packageName} root lock entry must use the exact audited DSH version`,
  );
}

let lockedDshPackageCount = 0;
for (const [packagePath, entry] of Object.entries(lock.packages ?? {})) {
  if (!/(?:^|\/)node_modules\/@deepseek-ai\/dsh(?:-[^/]+)?$/u.test(packagePath)) continue;
  lockedDshPackageCount += 1;
  assert.equal(entry.version, DSH_VERSION, `${packagePath} drifted from the audited DSH version`);
}
assert.ok(lockedDshPackageCount > 0, "package-lock.json contains no installed DSH packages");

assert.equal(
  yaml(action, "action.yml").inputs["dsh-version"].default,
  DSH_VERSION,
  "Action runtime default must use the exact DSH pin",
);
const releaseCanary = yaml(canary, "release canary");
assert.equal(releaseCanary.name, `${ACTION_TAG} release canary`);
assert.equal(releaseCanary.concurrency.group, "dsh-release-canary");
assert.deepEqual(releaseCanary.jobs.smoke.env, {
  RELEASE_TAG: ACTION_TAG,
  RELEASE_SHA: `\${{ vars.${RELEASE_CANARY_VARIABLE} }}`,
});
const canarySteps = releaseCanary.jobs.smoke.steps;
const canaryActions = canarySteps.filter((step) => step.uses === "./release-action");
assert.deepEqual(
  canaryActions.map((step) => step.id),
  ["controlled", "native"],
);
assert.equal(canaryActions[0].with["dsh-mode"], undefined);
assert.equal(canaryActions[1].with["dsh-mode"], "native");
const releaseCheckout = canarySteps.find((step) => step.with?.path === "release-action");
assert.equal(releaseCheckout?.with.ref, "${{ env.RELEASE_SHA }}");
assert.equal(releaseCheckout?.with["persist-credentials"], false);

// These shell guards still bind the published tag and checkout. The independent
// diagnostic gate is executed by release-canary.test.ts, not inspected as text.
for (const expected of [
  "releases/tags/$RELEASE_TAG",
  "git/ref/tags/$RELEASE_TAG",
  ".draft == false and .prerelease == false",
  'object_sha" != "$RELEASE_SHA',
  'git -C release-action rev-parse HEAD)" = "$RELEASE_SHA',
  "git -C release-action config --local --get-regexp",
]) {
  assert.ok(canary.includes(expected), `release canary is missing a binding guard: ${expected}`);
}
const controlledAssertion = canarySteps.find((step) => step.id === "controlled_assert")?.run ?? "";
const nativeAssertion = canarySteps.find((step) => step.id === "native_assert")?.run ?? "";
for (const expected of [
  '.toolPolicy.policyOwner == "controller"',
  '.dsh.mode == "controlled"',
  '.dsh.composition == "github-action-controlled"',
  '.permissions.effectiveTools == ["workspace.read","workspace.search"]',
]) {
  assert.ok(controlledAssertion.includes(expected), `controlled canary is missing: ${expected}`);
}
for (const expected of [
  '.toolPolicy.policyOwner == "dsh"',
  '.dsh.mode == "native"',
  '.dsh.composition == "dsh-native-headless"',
  '.isolation.workspaceAccess == "read-only"',
  '(.toolPolicy.observedTools | index("read") != null)',
  '(.toolPolicy | has("effectiveTools") | not)',
  '(.toolPolicy | has("requestedTools") | not)',
  '(.toolPolicy | has("deniedTools") | not)',
]) {
  assert.ok(nativeAssertion.includes(expected), `native canary is missing: ${expected}`);
}

assert.equal(
  installerManifest.name,
  "create-deepseek-harness-action",
  "installer npm package name drifted",
);
assert.equal(installerManifest.private, false, "installer must remain publishable");
assert.equal(
  installerManifest.bin?.["create-deepseek-harness-action"],
  "./dist/cli.mjs",
  "installer bin entry drifted",
);
assert.deepEqual(installerManifest.files, ["dist/"], "installer package files must be allowlisted");
assert.equal(
  installerManifest.scripts?.prepack,
  "npm run build",
  "installer pack must build its release-bound dist",
);
assert.deepEqual(
  installerManifest.publishConfig,
  { access: "public", registry: "https://registry.npmjs.org/" },
  "installer must publish publicly through the official npm registry",
);
assert.equal(installerLock.version, installerVersion, "installer lock version drifted");
assert.equal(
  installerLock.packages?.[""]?.version,
  installerVersion,
  "installer root lock version drifted",
);
assert.ok(
  installerRuntime.includes(`/blob/${installerSourceTag}/docs/setup.md`),
  `installer documentation must bind to the ${installerSourceTag} source tag`,
);
assert.ok(
  installerReadme.includes(installerVersion) &&
    installerReadme.includes(installerActionTag) &&
    installerReadme.includes(installerReleaseBinding),
  "installer README must identify its version and immutable Action binding",
);
for (const [name, document] of [
  ["README.md", rootReadme],
  ["README.zh-CN.md", rootReadmeZh],
  ["docs/setup.md", setupGuide],
  ["docs/setup.zh-CN.md", setupGuideZh],
  ["CHANGELOG.md", changelog],
  ["docs/maintainer-release.md", maintainerReleaseGuide],
]) {
  assert.ok(
    document.includes(installerVersion) &&
      document.includes(installerActionTag) &&
      document.includes(installerReleaseBinding),
    `${name} must identify the installer version and immutable Action binding`,
  );
}
assert.ok(
  maintainerReleaseGuide.includes('repository="Lixiaoyiao/deepseek-harness-action"') &&
    !maintainerReleaseGuide.includes("$GITHUB_REPOSITORY"),
  "installer publish guide must use an explicit repository identity",
);
// Installer CLI behavior, archive contents, invalid release bindings, and
// deterministic controlled/native rendering are tested through the real build
// and packed package in installer.test.ts and installer-guided.test.ts.
const installerReleaseToken = "__DSH_ACTION_RELEASE_SHA__";
const installerDshModeToken = "__DSH_MODE_INPUT__";
for (const [name, template] of [
  ["review", installerReview],
  ["commands", installerCommands],
  ["session", installerSession],
]) {
  const workflow = yaml(template, `${name} installer template`);
  const actionSteps = Object.values(workflow.jobs ?? {})
    .flatMap((job) => job.steps ?? [])
    .filter(
      (step) =>
        typeof step.uses === "string" &&
        step.uses.startsWith("Lixiaoyiao/deepseek-harness-action@"),
    );
  assert.equal(actionSteps.length, 1, `${name} installer template must contain one Action step`);
  assert.equal(
    actionSteps[0]?.with?.["dsh-version"],
    DSH_VERSION,
    `${name} installer template must select the audited exact DSH pin`,
  );
  assert.equal(
    template.split(installerReleaseToken).length - 1,
    1,
    `${name} installer template must contain exactly one controlled release token`,
  );
  assert.equal(
    template.split(installerDshModeToken).length - 1,
    1,
    `${name} installer template must contain exactly one DSH mode build anchor`,
  );
  assert.doesNotMatch(
    template,
    /^\s*dsh-mode:/mu,
    `${name} source template must leave controlled mode implicit`,
  );
  assert.ok(
    template.includes(`Lixiaoyiao/deepseek-harness-action@${installerReleaseToken}`),
    `${name} installer template must bind only through the controlled release token`,
  );
  assert.ok(
    !/deepseek-harness-action@(?:main|latest|v\d)/u.test(template),
    `${name} installer template must not use a floating Action reference`,
  );
  assert.ok(
    template.includes("persist-credentials: false"),
    `${name} installer template must disable checkout credentials`,
  );
  assert.ok(
    !/^\s+env:\s*$/mu.test(template) && !template.includes("github-token:"),
    `${name} installer template must not expose Controller credentials`,
  );
}
for (const expected of [
  "run-name: dsh-session-${{ inputs.session_key }}",
  "group: dsh-session-${{ inputs.session_key }}",
  "cancel-in-progress: false",
  "queue: max",
  "session-mode: auto",
  "session-key: ${{ inputs.session_key }}",
  "actions: read",
  'allow-write: "false"',
]) {
  assert.ok(installerSession.includes(expected), `installer Session is missing: ${expected}`);
}
assert.ok(
  !installerSession.includes("session-source-run-id:"),
  "installer Session must discover its own source",
);
for (const expected of [
  "pull_request_target:",
  "ref: ${{ github.event.pull_request.base.sha }}",
  "contents: read",
  "pull-requests: write",
  'allow-write: "false"',
]) {
  assert.ok(installerReview.includes(expected), `installer review is missing: ${expected}`);
}
for (const expected of [
  "ref: ${{ github.event.repository.default_branch }}",
  "actions: read",
  "checks: read",
  "contents: write",
  "issues: write",
  "pull-requests: write",
  'allow-write: "true"',
  'run-tests: "true"',
  "validation-integrity: strict",
  "REQUIRED: Replace this fail-closed placeholder",
  "@sha256:",
]) {
  assert.ok(installerCommands.includes(expected), `installer commands is missing: ${expected}`);
}
assert.ok(
  !/\b(?:npm|pnpm|yarn)\b/u.test(installerCommands),
  "installer coding validation must not assume a JavaScript package manager",
);

process.stdout.write(
  `release contract ok: ${ACTION_TAG}, installer ${installerManifest.name}@${installerManifest.version}, DSH ${DSH_VERSION}, ${String(lockedDshPackageCount)} locked DSH packages\n`,
);
