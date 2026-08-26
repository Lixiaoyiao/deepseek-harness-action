import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

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
const countToken = (source, token) => source.split(token).length - 1;

const [
  manifestText,
  lockText,
  action,
  ci,
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
  installerBuild,
  installerRuntime,
  installerReview,
  installerCommands,
] = await Promise.all([
  read("package.json"),
  read("package-lock.json"),
  read("action.yml"),
  read(".github/workflows/ci.yml"),
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
  read("packages/create-deepseek-harness-action/scripts/build.mjs"),
  read("packages/create-deepseek-harness-action/src/installer.mjs"),
  read("packages/create-deepseek-harness-action/src/templates/dsh-review.yml"),
  read("packages/create-deepseek-harness-action/src/templates/dsh-commands.yml"),
]);
const manifest = JSON.parse(manifestText);
const lock = JSON.parse(lockText);
const installerManifest = JSON.parse(installerManifestText);
const installerLock = JSON.parse(installerLockText);
const installerVersion = "0.2.0";
const installerActionTag = "v0.8.0";
const installerActionReleaseSha = "86fff4c4527694c7eefdc65c6cf7a633b5ea8cb1";
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

assert.ok(
  action.includes(`The Action accepts only the audited ${DSH_VERSION} runtime.`),
  "action.yml DSH compatibility description drifted from src/release.ts",
);
assert.ok(
  action.includes(`default: "${DSH_VERSION}"`),
  "action.yml dsh-version default drifted from src/release.ts",
);
assert.ok(
  ci.includes(`const expectedVersion = "${DSH_VERSION}";`),
  "CI runtime smoke drifted from the audited DSH version",
);
assert.ok(ci.includes("locked DSH rc.2"), "CI runtime smoke label must identify rc.2");

for (const expected of [
  `name: ${ACTION_TAG} release canary`,
  `RELEASE_TAG: ${ACTION_TAG}`,
  `vars.${RELEASE_CANARY_VARIABLE}`,
  "group: dsh-release-canary",
  "Checkout the fixed release action",
  `releases/tags/$RELEASE_TAG`,
  `git/ref/tags/$RELEASE_TAG`,
  ".draft == false and .prerelease == false",
  'object_sha" != "$RELEASE_SHA',
  'git -C release-action rev-parse HEAD)" = "$RELEASE_SHA',
]) {
  assert.ok(canary.includes(expected), `release canary is missing contract token: ${expected}`);
}

const controlledCanaryStart = canary.indexOf(
  "      - name: Controlled default strict read-only smoke",
);
const nativeCanaryStart = canary.indexOf("      - name: Native read-only smoke");
assert.ok(controlledCanaryStart >= 0, "release canary must run the controlled default smoke");
assert.ok(
  nativeCanaryStart > controlledCanaryStart,
  "release canary must run the native smoke after the controlled smoke",
);
const controlledCanary = canary.slice(controlledCanaryStart, nativeCanaryStart);
const nativeCanary = canary.slice(nativeCanaryStart);
assert.doesNotMatch(
  controlledCanary,
  /^\s+dsh-mode:/mu,
  "controlled release canary must exercise the default dsh-mode",
);
assert.match(nativeCanary, /^\s+dsh-mode: native$/mu, "native release canary must opt in");
assert.equal(
  countToken(canary, "uses: ./release-action"),
  2,
  "release canary must invoke the immutable action exactly twice",
);
assert.equal(
  countToken(canary, "persist-credentials: false"),
  1,
  "release checkout must disable credential persistence exactly once",
);
assert.equal(
  countToken(canary, "dsh-mode: native"),
  1,
  "release canary must contain exactly one native opt-in",
);
assert.ok(
  canary.includes("git -C release-action config --local --get-regexp"),
  "release canary must recheck the checkout's local credential configuration",
);
assert.ok(
  controlledCanary.includes('.toolPolicy.policyOwner == "controller"') &&
    controlledCanary.includes('.dsh.mode == "controlled"') &&
    controlledCanary.includes('.dsh.composition == "github-action-controlled"') &&
    controlledCanary.includes(
      '.permissions.effectiveTools == ["workspace.read","workspace.search"]',
    ),
  "controlled release canary must assert its schema ownership and composition",
);
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
  assert.ok(nativeCanary.includes(expected), `native release canary is missing: ${expected}`);
}

assert.equal(
  installerManifest.name,
  "create-deepseek-harness-action",
  "installer npm package name drifted",
);
assert.equal(installerManifest.version, installerVersion, "installer version drifted");
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
  installerRuntime.includes(`/blob/${installerActionTag}/docs/setup.md`),
  `installer documentation must bind to the ${installerActionTag} release`,
);
assert.ok(
  installerReadme.includes(`Version \`${installerVersion}\``) &&
    installerReadme.includes(installerActionTag) &&
    installerReadme.includes(installerActionReleaseSha),
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
      document.includes(installerActionReleaseSha),
    `${name} must identify the installer version and immutable Action binding`,
  );
}
assert.ok(
  maintainerReleaseGuide.includes('repository="Lixiaoyiao/deepseek-harness-action"') &&
    !maintainerReleaseGuide.includes("$GITHUB_REPOSITORY"),
  "installer publish guide must use an explicit repository identity",
);
assert.ok(
  installerRuntime.includes("--dsh-mode controlled|native") &&
    installerRuntime.includes(
      "const DEFAULT_DSH_MODE = INSTALLER_ACTION_INPUTS.dshMode.defaultValue",
    ),
  "installer CLI must expose native as an opt-in and keep controlled as the default",
);
for (const expected of ["dsh-review-native.yml", "dsh-commands-native.yml"]) {
  assert.ok(installerRuntime.includes(expected), `installer runtime is missing: ${expected}`);
}

const installerReleaseToken = "__DSH_ACTION_RELEASE_SHA__";
const installerDshModeToken = "__DSH_MODE_INPUT__";
assert.ok(
  installerBuild.includes("DSH_ACTION_RELEASE_SHA"),
  "installer build must require an explicit release SHA",
);
assert.ok(
  installerBuild.includes("^[0-9a-f]{40}$"),
  "installer build must accept only a lowercase full commit SHA",
);
assert.ok(
  installerBuild.includes(installerDshModeToken) &&
    installerBuild.includes('renderTemplate(source, file, "controlled")') &&
    installerBuild.includes('renderTemplate(source, file, "native")'),
  "installer build must deterministically render controlled and native templates",
);
assert.ok(
  !installerBuild.includes(installerActionReleaseSha),
  "installer source build must receive the formal Action SHA only through DSH_ACTION_RELEASE_SHA",
);
for (const [name, template] of [
  ["review", installerReview],
  ["commands", installerCommands],
]) {
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
