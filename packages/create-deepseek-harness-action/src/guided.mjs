import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { runProcess } from "./process.mjs";
import { createPrompter } from "./prompts.mjs";
import { publishReviewWorkflow } from "./publication.mjs";
import { canonicalWorkflowText } from "./workflow-text.mjs";

function githubRepository(url) {
  const match =
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/u.exec(
      url.trim(),
    );
  if (!match || match[2] === "." || match[2] === "..") return undefined;
  return `${match[1]}/${match[2]}`;
}

function verifyReviewConfiguration(contents) {
  const required = [
    /^\s+contents: read\s*$/mu,
    /^\s+ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}\s*$/mu,
    /^\s+persist-credentials: false\s*$/mu,
    /^\s+permission-profile: strict\s*$/mu,
    /^\s+isolation: docker\s*$/mu,
    /^\s+allow-write: "false"\s*$/mu,
  ];
  const action = [
    ...contents.matchAll(/^\s+- uses: Lixiaoyiao\/deepseek-harness-action@([0-9a-f]{40})\s*$/gmu),
  ];
  if (
    required.some((rule) => !rule.test(contents)) ||
    action.length !== 1 ||
    /^(?:\s+allow-write: "true"|\s+contents: write|\s+dsh-mode:)/mu.test(contents)
  ) {
    throw new Error(
      "Invalid read-only PR Review configuration. Use the official pinned starter; preserve existing workflows and review changes manually.",
    );
  }
}

async function configureSecret({ repository, root, prompt, output, invoke }) {
  const repositoryReference = `github.com/${repository}`;
  const details = await invoke(
    "gh",
    ["repo", "view", repositoryReference, "--json", "nameWithOwner,defaultBranchRef"],
    root,
  );
  let resolved;
  try {
    resolved = JSON.parse(details.stdout);
  } catch {
    /* Non-JSON transport output is never displayed. */
  }
  if (
    details.exitCode !== 0 ||
    resolved?.nameWithOwner?.toLowerCase() !== repository.toLowerCase()
  ) {
    output.write(
      "Could not verify GitHub repository access. Check gh auth status and repository permissions, then rerun.\n",
    );
    return "access_required";
  }
  const listed = await invoke(
    "gh",
    ["secret", "list", "--repo", repositoryReference, "--json", "name"],
    root,
  );
  let secrets;
  try {
    secrets = JSON.parse(listed.stdout);
  } catch {
    /* A failed list is not proof that the Secret is absent. */
  }
  if (listed.exitCode !== 0 || !Array.isArray(secrets)) {
    output.write(
      "Could not check Secret names. Add DEEPSEEK_API_KEY in GitHub Settings > Secrets and variables > Actions, then rerun.\n",
    );
    return "access_required";
  }
  if (secrets.some((entry) => entry?.name === "DEEPSEEK_API_KEY")) {
    output.write("DEEPSEEK_API_KEY is already configured; its value was not retrieved.\n");
    return "configured";
  }
  const answer = (await prompt.question(`Set DEEPSEEK_API_KEY for ${repository} now? [y/N]: `))
    .trim()
    .toLowerCase();
  if (answer !== "y" && answer !== "yes") {
    output.write(
      "Add DEEPSEEK_API_KEY in GitHub Settings > Secrets and variables > Actions before the first review.\n",
    );
    return "not_configured";
  }
  let key;
  try {
    key = await prompt.secret("DeepSeek API key (input hidden): ");
  } catch {
    output.write(
      "Hidden key input is unavailable. Set DEEPSEEK_API_KEY in GitHub Settings, then rerun.\n",
    );
    return "not_configured";
  }
  if (
    typeof key !== "string" ||
    key.trim() === "" ||
    key.length > 4096 ||
    [...key].some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)
  ) {
    output.write(
      "API key must be non-empty and contain no whitespace or control characters. No Secret was sent.\n",
    );
    return "not_configured";
  }
  const result = await invoke(
    "gh",
    ["secret", "set", "DEEPSEEK_API_KEY", "--repo", repositoryReference],
    root,
    `${key}\n`,
  );
  if (result.exitCode !== 0) {
    output.write(
      "Secret setup failed or is uncertain. Check repository administration permissions and Secret names in GitHub Settings before retrying.\n",
    );
    return "setup_failed";
  }
  output.write("DEEPSEEK_API_KEY configured through GitHub CLI.\n");
  return "configured";
}

/** A first-run transaction owns repo discovery, admission, consent and recovery. */
export async function runGuidedSetup(options) {
  const execute = options.processRunner ?? runProcess;
  const prompt = options.prompter ?? createPrompter(options.input, options.output);
  const output = options.output;
  const invoke = async (command, args, cwd = options.cwd, input, processOptions = {}) => {
    try {
      const result = await execute(command, args, {
        cwd,
        timeoutMs: 30_000,
        ...processOptions,
        ...(input === undefined ? {} : { input }),
      });
      if (result.termination === "unconfirmed")
        output.write(
          "External command cleanup is uncertain. Check for remaining Git/gh processes before retrying; no process output was displayed.\n",
        );
      if (result.failure === "tool_unavailable")
        output.write(
          "A trusted Git/gh tool is unavailable. Install it in an absolute host PATH directory outside this repository, then rerun.\n",
        );
      return result;
    } catch {
      return { exitCode: 1, stdout: "", stderr: "" };
    }
  };
  try {
    const gitRoot = await invoke("git", ["rev-parse", "--show-toplevel"]);
    if (gitRoot.exitCode !== 0)
      throw new Error(
        "Start inside an existing Git repository. Set its GitHub remote, then rerun; no remote repository is created.",
      );
    const root = await realpath(gitRoot.stdout.trim());
    const location = relative(root, await realpath(options.cwd));
    if (
      isAbsolute(location) ||
      location === ".." ||
      location.startsWith("../") ||
      location.startsWith("..\\")
    )
      throw new Error("Git root is outside the selected repository.");
    const remote = await invoke("git", ["remote", "get-url", "origin"], root);
    const repository = remote.exitCode === 0 ? githubRepository(remote.stdout) : undefined;
    if (repository === undefined)
      throw new Error(
        "Configure an origin remote on github.com, then rerun. No GitHub repository was created.",
      );
    output.write(`Repository: ${repository}\nGit root: ${root}\n`);
    const gh = await invoke("gh", ["--version"], root);
    const login =
      gh.exitCode === 0
        ? await invoke("gh", ["auth", "status", "--hostname", "github.com"], root)
        : undefined;
    const loggedIn = login?.exitCode === 0;
    if (!loggedIn)
      output.write(
        "GitHub CLI login is required for Secret setup. Install gh if missing, then run gh auth login --hostname github.com and rerun to resume. You can also add DEEPSEEK_API_KEY in GitHub Settings.\n",
      );
    const consent = (await prompt.question("Create a read-only PR Review workflow? [Y/n]: "))
      .trim()
      .toLowerCase();
    if (consent !== "" && consent !== "y" && consent !== "yes")
      return { mode: "review", dshMode: "controlled", createdFiles: [] };
    const expectedContents = canonicalWorkflowText(
      await readFile(join(options.templateDirectory, "dsh-review.yml"), "utf8"),
    );
    verifyReviewConfiguration(expectedContents);
    const createdFiles = await options.createWorkflow(root);
    output.write(
      createdFiles.length === 0
        ? "Preserved the identical pinned PR Review workflow; no file was overwritten.\n"
        : "Created the pinned PR Review workflow.\n",
    );
    output.write(
      "Configuration checked: Review can comment on code but cannot change files. The first GitHub run checks your key and runner setup.\n",
    );
    const secret = loggedIn
      ? await configureSecret({ repository, root, prompt, output, invoke })
      : "login_required";
    const publication = await publishReviewWorkflow({
      root,
      prompt,
      output,
      invoke,
      remoteUrl: remote.stdout,
      expectedContents,
    });
    output.write(
      "PR Review workflow is ready locally. It must reach the default branch, with DEEPSEEK_API_KEY configured, before opening a non-draft pull request. Rerun without flags to resume unchanged setup, or finish those steps manually.\n",
    );
    return {
      mode: "review",
      dshMode: "controlled",
      createdFiles,
      onboarding: { repository, root, secret, ...publication },
    };
  } finally {
    prompt.close();
  }
}
