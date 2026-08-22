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

const [manifestText, lockText, action, ci, canary] = await Promise.all([
  read("package.json"),
  read("package-lock.json"),
  read("action.yml"),
  read(".github/workflows/ci.yml"),
  read(".github/workflows/release-canary.yml"),
]);
const manifest = JSON.parse(manifestText);
const lock = JSON.parse(lockText);
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

process.stdout.write(
  `release contract ok: ${ACTION_TAG}, DSH ${DSH_VERSION}, ${String(lockedDshPackageCount)} locked DSH packages\n`,
);
