export const id = 327;
export const ids = [327];
export const modules = {

/***/ 3327:
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {


// EXPORTS
__webpack_require__.d(__webpack_exports__, {
  finishFix: () => (/* binding */ finishFix)
});

// EXTERNAL MODULE: ./node_modules/@actions/core/lib/core.js + 18 modules
var core = __webpack_require__(6257);
// EXTERNAL MODULE: ./src/review/tracking.ts
var tracking = __webpack_require__(4843);
// EXTERNAL MODULE: ./src/github/comments.ts
var comments = __webpack_require__(6645);
// EXTERNAL MODULE: ./src/security/redaction.ts
var redaction = __webpack_require__(5275);
;// CONCATENATED MODULE: ./src/github/status.ts



async function publishStatusComment(client, target, authorId, title, message, runUrl) {
    const body = [
        (0,tracking/* createTrackingMarker */.ky)({ kind: "write" }),
        `## ${title}`,
        "",
        (0,redaction/* sanitizeUntrustedText */.Ti)(message.replace(/<!--\s*dsh-action:[\s\S]*?-->/giu, "")).slice(0, 60_000),
        "",
        `<sub>[Workflow run](${runUrl}) · dsh-action</sub>`,
    ].join("\n");
    await (0,comments/* upsertTrackingComment */.k)(client, target, authorId, "write", body);
}

// EXTERNAL MODULE: ./src/write/pr.ts
var pr = __webpack_require__(8385);
// EXTERNAL MODULE: ./src/write/github.ts
var github = __webpack_require__(252);
// EXTERNAL MODULE: ./src/write/validate.ts
var validate = __webpack_require__(6713);
// EXTERNAL MODULE: ./src/write/workspace.ts + 1 modules
var workspace = __webpack_require__(1670);
;// CONCATENATED MODULE: ./src/commands/fix.ts






async function finishFix(input) {
    await (0,pr/* revalidatePullRequestIdentity */.kf)(input.client, input.target.owner, input.target.repo, input.target.issueNumber, input.identity);
    const changes = await (0,workspace/* inspectWorkspaceChanges */.$Z)(input.snapshot);
    if (changes.all.length === 0)
        throw new Error("DSH reported a fix but produced no file changes");
    if (input.inputs.runTests && input.inputs.testCommands.length === 0) {
        throw new Error("run-tests is true but test-commands is empty; set run-tests=false for an explicit unverified write");
    }
    const verified = input.inputs.runTests;
    if (verified) {
        const tests = await (0,validate/* runValidationCommandsInDocker */.K)(input.snapshot.workerRoot, input.inputs.testCommands, input.inputs.containerImage);
        const failed = tests.find(({ result }) => result.exitCode !== 0 || result.timedOut);
        if (failed !== undefined) {
            throw new Error(`Validation failed: ${failed.argv.join(" ")}`);
        }
    }
    await (0,pr/* revalidatePullRequestIdentity */.kf)(input.client, input.target.owner, input.target.repo, input.target.issueNumber, input.identity);
    const created = await (0,github.createGitHubCommitFromWorkspace)(input.client, {
        owner: input.target.owner,
        repo: input.target.repo,
        baseSha: input.boundHeadSha,
        message: "fix: apply DeepSeek Harness fix",
    }, input.snapshot);
    await (0,pr/* revalidatePullRequestIdentity */.kf)(input.client, input.target.owner, input.target.repo, input.target.issueNumber, input.identity);
    await (0,github.assertRemoteBranchHead)(input.client, input.target.owner, input.target.repo, input.headBranch, input.boundHeadSha);
    await (0,github.updateRemoteBranch)(input.client, input.target.owner, input.target.repo, input.headBranch, created.sha);
    try {
        await publishStatusComment(input.client, input.target, input.expectedAuthorId, verified ? "DeepSeek Harness fix prepared" : "DeepSeek Harness fix prepared (unverified)", `${input.result.output.summary}\n\n${verified ? "Configured validation passed." : "No validation commands were configured; this change is unverified."}\n\nCommit: \`${created.sha}\`\n\nChanged: ${created.paths.map((path) => `\`${path}\``).join(", ")}`, input.runUrl);
        return { commitSha: created.sha, paths: created.paths, status: "success" };
    }
    catch {
        // The branch update is the authoritative write. A later comment failure
        // must not turn an already-pushed fix into a failed/retried mutation.
        core/* warning */.$e(`Partial success: fix commit ${created.sha} was pushed, but its GitHub status comment could not be published.`);
        try {
            await core/* summary */.z
                .addHeading("DeepSeek Harness fix: partial success", 2)
                .addRaw(`Fix commit \`${created.sha}\` was pushed, but the status comment could not be published.`)
                .write();
        }
        catch {
            core/* warning */.$e("The partial-success step summary could not be published either.");
        }
        return { commitSha: created.sha, paths: created.paths, status: "partial-success" };
    }
}


/***/ })

};

//# sourceMappingURL=327.index.js.map