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

const [
  manifestText,
  lockText,
  action,
  ci,
  canary,
  installerManifestText,
  installerLockText,
  installerBuild,
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
  read("packages/create-deepseek-harness-action/scripts/build.mjs"),
  read("packages/create-deepseek-harness-action/src/templates/dsh-review.yml"),
  read("packages/create-deepseek-harness-action/src/templates/dsh-commands.yml"),
]);
const manifest = JSON.parse(manifestText);
const lock = JSON.parse(lockText);
const installerManifest = JSON.parse(installerManifestText);
const installerLock = JSON.parse(installerLockText);
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
  action.includes(`v${ACTION_VERSION} accepts only the audited ${DSH_VERSION} runtime.`),
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

assert.equal(
  installerManifest.name,
  "create-deepseek-harness-action",
  "installer npm package name drifted",
);
assert.equal(installerManifest.version, "0.1.0", "installer version must start at 0.1.0");
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
assert.equal(installerLock.version, "0.1.0", "installer lock version drifted");
assert.equal(installerLock.packages?.[""]?.version, "0.1.0", "installer root lock version drifted");

const installerReleaseToken = "__DSH_ACTION_RELEASE_SHA__";
assert.ok(
  installerBuild.includes("DSH_ACTION_RELEASE_SHA"),
  "installer build must require an explicit release SHA",
);
assert.ok(
  installerBuild.includes("^[0-9a-f]{40}$"),
  "installer build must accept only a lowercase full commit SHA",
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
