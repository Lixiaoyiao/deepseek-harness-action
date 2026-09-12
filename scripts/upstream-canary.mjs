import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { appendFile, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const registry = "https://registry.npmjs.org/";
const dshName = "@deepseek-ai/dsh";
const isDsh = (name) => name === dshName || name.startsWith(`${dshName}-`);
const isOfficial = (name) => name.startsWith("@deepseek-ai/");
const smokeFiles = ["test/dsh-composition.test.ts", "test/native-ecosystem.integration.test.ts"];

function versionParts(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.(0|[1-9]\d*))?$/u.exec(version);
  return match
    ? match.slice(1).map((part) => (part === undefined ? Infinity : Number(part)))
    : null;
}

function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < 4; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

// Registry inventory order and dist-tags (which may point to an RC) do not
// define semver order. Alpha/dev builds cannot silently become release probes.
export function selectCandidates(inventory, audited) {
  if (!versionParts(audited) || !Object.hasOwn(inventory.versions ?? {}, audited)) {
    throw new Error(
      "The audited DSH version is absent or invalid in the official version inventory",
    );
  }
  const versions = Object.entries(inventory.versions)
    .filter(([version, manifest]) => versionParts(version) && !manifest.deprecated)
    .map(([version]) => version)
    .filter((version) => compareVersions(version, audited) > 0)
    .sort(compareVersions);
  const stable = versions.filter((version) => !version.includes("-")).at(-1) ?? null;
  const rc =
    versions
      .filter(
        (version) => version.includes("-rc.") && (!stable || compareVersions(version, stable) > 0),
      )
      .at(-1) ?? null;
  return { stable, rc };
}

export function candidateManifest(production, candidate, graph, companions) {
  const source = { ...production.dependencies, ...production.devDependencies };
  const dependencies = Object.fromEntries(
    Object.entries(source).filter(([name]) => !isOfficial(name)),
  );
  for (const [name, metadata] of Object.entries(graph)) {
    if (!isDsh(name) || metadata.name !== name || metadata.version !== candidate) {
      throw new Error(`Candidate graph identity mismatch: ${name}`);
    }
    dependencies[name] = candidate;
  }
  for (const name of Object.keys(source).filter(isOfficial)) {
    if (isDsh(name)) {
      if (!graph[name]) throw new Error(`Candidate graph is missing required package: ${name}`);
    } else {
      const requirements = Object.values(graph).flatMap((metadata) => [
        metadata.dependencies?.[name],
        metadata.peerDependencies?.[name],
      ]);
      // Prefer the candidate CLI's declared dependency, then another member's
      // requirement. npm validates the complete peer graph without overrides.
      const spec =
        graph[dshName]?.dependencies?.[name] ?? requirements.find(Boolean) ?? companions[name];
      if (!spec) throw new Error(`No official candidate constraint found for ${name}`);
      dependencies[name] = spec;
    }
  }
  return {
    name: "dsh-upstream-compatibility-probe",
    version: "0.0.0",
    private: true,
    type: "module",
    dependencies,
  };
}

export function verifyInstalledGraph(lock, candidate, graph) {
  const inventory = {};
  const cordis = new Set();
  for (const [location, metadata] of Object.entries(lock.packages ?? {})) {
    const name = location.split("node_modules/").at(-1);
    if (!isOfficial(name)) continue;
    (inventory[name] ??= []).push(metadata.version);
    if (isDsh(name) && metadata.version !== candidate) {
      throw new Error(`Mixed DSH graph: ${name}@${metadata.version}; expected ${candidate}`);
    }
    if (name === "@deepseek-ai/cordis") cordis.add(metadata.version);
  }
  for (const name of Object.keys(graph)) {
    if (!inventory[name]?.includes(candidate))
      throw new Error(`Installed graph is missing ${name}@${candidate}`);
  }
  if (cordis.size !== 1) throw new Error("Candidate must use one matching Cordis runtime");
  return Object.fromEntries(
    Object.entries(inventory)
      .sort()
      .map(([name, versions]) => [name, [...new Set(versions)]]),
  );
}

export function interruptedReport(report) {
  if (report.status !== "not-tested" || report.phase === "complete") return report;
  if (["resolution", "installation", "dependency-validation"].includes(report.phase)) {
    return {
      ...report,
      status: "install-failed",
      detail: `Interrupted during ${report.phase}; compatibility tests were not run.`,
    };
  }
  return {
    ...report,
    detail: `Interrupted during ${report.phase}; no completed compatibility result.`,
  };
}

export function compatibilityStatus(result) {
  if (!result.started || result.timedOut || result.signal !== null || result.exitCode === null) {
    return "not-tested";
  }
  return result.exitCode === 0 ? "passed" : "interface-incompatible";
}

export function metadataRequest(name, version = "") {
  if (!/^@deepseek-ai\/[a-z0-9-]+$/u.test(name)) throw new Error("Invalid official package name");
  return {
    url: `${registry}${encodeURIComponent(name)}${version ? `/${encodeURIComponent(version)}` : ""}`,
    // npm's per-version endpoint rejects the abbreviated packument media type
    // with HTTP 406; it is valid only for the complete package inventory.
    accept: version ? "application/json" : "application/vnd.npm.install-v1+json",
  };
}

async function metadata(name, version = "") {
  const request = metadataRequest(name, version);
  const response = await fetch(request.url, {
    headers: { accept: request.accept },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(
      `Official registry returned HTTP ${response.status} for ${name}${version ? `@${version}` : ""}`,
    );
  return await response.json();
}

export async function candidateGraph(
  source,
  candidate,
  candidateMetadata,
  loadMetadata = metadata,
) {
  const graph = { [dshName]: candidateMetadata };
  const pending = new Set(
    Object.keys({ ...source.dependencies, ...source.devDependencies }).filter(isDsh),
  );
  while (pending.size > 0) {
    const batch = [...pending].slice(0, 8);
    for (const name of batch) pending.delete(name);
    const packages = await Promise.all(
      batch.map(async (name) => graph[name] ?? (await loadMetadata(name, candidate))),
    );
    for (const packageMetadata of packages) {
      graph[packageMetadata.name] = packageMetadata;
      for (const name of Object.keys({
        ...packageMetadata.dependencies,
        ...packageMetadata.optionalDependencies,
        ...packageMetadata.peerDependencies,
      }).filter(isDsh)) {
        if (!graph[name]) pending.add(name);
      }
    }
    if (Object.keys(graph).length + pending.size > 512)
      throw new Error("Official candidate graph exceeds the 512-package bound");
  }
  return graph;
}

async function runCommand(command, args, cwd, logPath, timeout) {
  const child = spawn(command, args, {
    cwd,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      npm_config_registry: registry,
      npm_config_legacy_peer_deps: "false",
      npm_config_force: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  writeFileSync(logPath, output);
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      output = (output + chunk.toString()).slice(-128_000);
      // Persist bounded partial evidence while the command is still running;
      // parent cancellation must not erase the entire test/install transcript.
      writeFileSync(logPath, output);
    });
  let started = false;
  child.once("spawn", () => {
    started = true;
  });
  let timedOut = false;
  let killTimer;
  const terminate = (signal) => {
    try {
      // Ubuntu commands have their own process group, including fixture
      // grandchildren, so cancellation bounds npm and Vitest alike.
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  const timer = setTimeout(() => {
    timedOut = true;
    terminate("SIGTERM");
    killTimer = setTimeout(() => terminate("SIGKILL"), 5_000);
  }, timeout);
  try {
    const result = await new Promise((resolveExit) => {
      child.once("error", (error) =>
        resolveExit({ exitCode: null, signal: null, spawnError: error.message }),
      );
      child.once("close", (exitCode, signal) => resolveExit({ exitCode, signal }));
    });
    return {
      ...result,
      started,
      timedOut,
      success: started && result.exitCode === 0 && !result.signal && !timedOut,
    };
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
    await writeFile(logPath, output);
  }
}

async function pathsFor(channel) {
  if (!["stable", "rc"].includes(channel))
    throw new Error("Candidate channel must be stable or rc");
  const root = join(process.env.RUNNER_TEMP ?? tmpdir(), `dsh-upstream-${channel}`);
  const evidence = join(root, "evidence");
  await mkdir(evidence, { recursive: true });
  return { root, evidence, report: join(evidence, "report.json") };
}

async function probe(channel) {
  const paths = await pathsFor(channel);
  const sourceRoot = process.cwd();
  const production = JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8"));
  const audited = production.dependencies[dshName];
  const report = {
    schemaVersion: 1,
    channel,
    audited,
    registry,
    candidate: null,
    status: "not-tested",
    phase: "selection",
    detail: "Candidate selection has not completed.",
  };
  const save = async () => await writeFile(paths.report, `${JSON.stringify(report, null, 2)}\n`);
  await save();
  try {
    const inventory = await metadata(dshName);
    report.distTags = inventory["dist-tags"];
    report.candidate = selectCandidates(inventory, audited)[channel];
    if (!report.candidate) {
      report.phase = "complete";
      report.detail = `No newer official ${channel} candidate; an RC superseded by a stable release is not retested.`;
      return;
    }
    report.phase = "resolution";
    await save();
    const graph = await candidateGraph(
      production,
      report.candidate,
      inventory.versions[report.candidate],
    );
    const companions = {};
    for (const name of Object.keys({
      ...production.dependencies,
      ...production.devDependencies,
    }).filter((name) => isOfficial(name) && !isDsh(name))) {
      // Companion packages have independent versions; use the official latest
      // only if no DSH member declares a requirement, then validate npm peers.
      companions[name] = (await metadata(name))["dist-tags"]?.latest;
    }
    const manifest = candidateManifest(production, report.candidate, graph, companions);
    const candidateRoot = join(paths.root, "candidate");
    await mkdir(candidateRoot); // Never consume leftovers from a previous attempt.
    for (const entry of ["src", "assets", "test", "vitest.config.ts", "tsconfig.json"]) {
      await cp(join(sourceRoot, entry), join(candidateRoot, entry), { recursive: true });
    }
    await writeFile(join(candidateRoot, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await cp(join(candidateRoot, "package.json"), join(paths.evidence, "candidate-package.json"));
    report.phase = "installation";
    await save();
    // Invoke npm's JS entry on Windows; .cmd shims require an unsafe shell.
    const npm = process.platform === "win32" ? process.execPath : "npm";
    const npmArgs =
      process.platform === "win32"
        ? [join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")]
        : [];
    const installation = await runCommand(
      npm,
      [
        ...npmArgs,
        "install",
        "--no-audit",
        "--no-fund",
        "--ignore-scripts",
        "--strict-peer-deps",
        `--registry=${registry}`,
      ],
      candidateRoot,
      join(paths.evidence, "install.log"),
      10 * 60_000,
    );
    if (!installation.success)
      throw new Error(
        `Candidate installation failed (exit ${installation.exitCode}, timed out: ${installation.timedOut}); see install.log.`,
      );
    report.phase = "dependency-validation";
    await save();
    const lockPath = join(candidateRoot, "package-lock.json");
    await cp(lockPath, join(paths.evidence, "candidate-package-lock.json"));
    report.installed = verifyInstalledGraph(
      JSON.parse(await readFile(lockPath, "utf8")),
      report.candidate,
      graph,
    );
    const dependencyCheck = await runCommand(
      npm,
      [...npmArgs, "ls", "--all", "--json"],
      candidateRoot,
      join(paths.evidence, "dependency-tree.json"),
      60_000,
    );
    if (!dependencyCheck.success)
      throw new Error("Candidate dependency/peer validation failed; see dependency-tree.json.");
    report.phase = "testing";
    await save();
    // Invoke this candidate's installed Vitest directly: npm exec must not
    // fetch a fallback tool or resolve modules from the production checkout.
    const smoke = await runCommand(
      process.execPath,
      [join(candidateRoot, "node_modules", "vitest", "vitest.mjs"), "run", ...smokeFiles],
      candidateRoot,
      join(paths.evidence, "smoke.log"),
      10 * 60_000,
    );
    report.status = compatibilityStatus(smoke);
    report.detail = smoke.success
      ? "Native composition and ecosystem compatibility smoke passed."
      : `Compatibility smoke did not pass (started: ${smoke.started}, exit: ${smoke.exitCode}, signal: ${smoke.signal}, timed out: ${smoke.timedOut}${smoke.spawnError ? `, spawn error: ${smoke.spawnError}` : ""}); see smoke.log.`;
    report.phase = "complete";
  } catch (error) {
    report.status = ["selection", "testing"].includes(report.phase)
      ? "not-tested"
      : "install-failed";
    report.detail = error instanceof Error ? error.message : String(error);
    report.phase = "complete";
    process.exitCode = 1;
  } finally {
    await save();
  }
  if (report.candidate && report.status !== "passed") process.exitCode = 1;
}

async function summarize(channel) {
  const paths = await pathsFor(channel);
  let report;
  try {
    report = interruptedReport(JSON.parse(await readFile(paths.report, "utf8")));
  } catch {
    report = {
      channel,
      status: "not-tested",
      detail: "The probe did not produce a report; candidate compatibility is unknown.",
    };
  }
  await writeFile(paths.report, `${JSON.stringify(report, null, 2)}\n`);
  const summary = `### Official DSH ${channel} compatibility warning\n\n- Candidate: ${report.candidate ?? "none selected"}\n- Status: **${report.status}**\n- ${report.detail}\n\nProduction remains pinned and supported only at ${report.audited ?? "the audited version"}. This advisory probe does not upgrade production or declare support. Candidate manifests, lockfiles and bounded diagnostics are attached as artifacts.\n`;
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  process.stdout.write(summary);
  if (["install-failed", "interface-incompatible"].includes(report.status)) {
    process.stdout.write(
      `::warning::Official DSH ${channel} compatibility probe: ${report.status}. See the report and diagnostic artifacts.\n`,
    );
  }
}

if (import.meta.main) {
  const [command, channel] = process.argv.slice(2);
  if (command === "run") await probe(channel);
  else if (command === "report") await summarize(channel);
  else throw new Error("Usage: node scripts/upstream-canary.mjs <run|report> <stable|rc>");
}
