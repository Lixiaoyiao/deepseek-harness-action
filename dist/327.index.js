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
// EXTERNAL MODULE: ./src/lifecycle/cancellation.ts
var cancellation = __webpack_require__(3257);
// EXTERNAL MODULE: ./src/review/tracking.ts
var tracking = __webpack_require__(4843);
// EXTERNAL MODULE: ./src/github/comments.ts
var comments = __webpack_require__(6645);
// EXTERNAL MODULE: ./src/security/redaction.ts
var redaction = __webpack_require__(5275);
;// CONCATENATED MODULE: ./src/github/status.ts



async function publishStatusComment(client, target, authorId, title, message, runUrl, trackingKind = "write") {
    const body = [
        (0,tracking/* createTrackingMarker */.ky)({ kind: trackingKind }),
        `## ${title}`,
        "",
        (0,redaction/* sanitizeUntrustedText */.Ti)(message.replace(/<!--\s*dsh-action:[\s\S]*?-->/giu, "")).slice(0, 60_000),
        "",
        `<sub>[Workflow run](${runUrl}) · dsh-action</sub>`,
    ].join("\n");
    await (0,comments/* upsertTrackingComment */.k)(client, target, authorId, trackingKind, body);
}

// EXTERNAL MODULE: ./src/write/pr.ts
var pr = __webpack_require__(8385);
// EXTERNAL MODULE: ./src/write/github.ts
var github = __webpack_require__(252);
// EXTERNAL MODULE: ./src/write/validate.ts
var validate = __webpack_require__(6713);
// EXTERNAL MODULE: ./src/write/workspace.ts + 1 modules
var workspace = __webpack_require__(1670);
// EXTERNAL MODULE: ./src/write/validation-deadline.ts
var validation_deadline = __webpack_require__(4301);
;// CONCATENATED MODULE: ./src/commands/fix.ts








async function finishFix(input) {
    const task = input.result.output.operation === "task";
    const label = task ? "task" : "fix";
    const validation = {
        deadlineMs: input.validationDeadlineMs ?? Date.now() + 10 * 60_000,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
    };
    input.onPhase?.("validation");
    await (0,validation_deadline/* withinValidationDeadline */.No)(async () => (0,pr/* revalidatePullRequestIdentity */.kf)(input.client, input.target.owner, input.target.repo, input.target.issueNumber, input.identity), validation);
    const changes = await (0,validation_deadline/* withinValidationDeadline */.No)(async () => (0,workspace/* inspectWorkspaceChanges */.$Z)(input.snapshot), validation);
    if (changes.all.length === 0) {
        throw new Error(`DSH reported a ${label} but produced no file changes`);
    }
    (0,validate/* assertWriteValidationConfigured */.BM)(input.inputs.runTests, input.inputs.testCommands);
    const tests = await (0,validation_deadline/* withinValidationDeadline */.No)(async () => (0,validate/* runValidationCommandsInDocker */.KQ)(input.snapshot.workerRoot, input.inputs.testCommands, input.inputs.containerImage, (0,validation_deadline/* remainingValidationMs */.qK)(validation), undefined, input.signal), validation);
    (0,validate/* assertValidationSucceeded */.Ph)(tests);
    (0,cancellation/* throwIfCancelled */.d)(input.signal);
    input.onPhase?.("write");
    await (0,validation_deadline/* withinValidationDeadline */.No)(async () => (0,pr/* revalidatePullRequestIdentity */.kf)(input.client, input.target.owner, input.target.repo, input.target.issueNumber, input.identity), validation);
    (0,cancellation/* throwIfCancelled */.d)(input.signal);
    // Crossing this boundary may create Git objects. Complete the existing
    // reconcile/update sequence even if cancellation arrives afterwards.
    const created = await (0,github.createGitHubCommitFromWorkspace)(input.client, {
        owner: input.target.owner,
        repo: input.target.repo,
        baseSha: input.boundHeadSha,
        message: task ? "feat: apply DeepSeek Harness task" : "fix: apply DeepSeek Harness fix",
    }, input.snapshot);
    await (0,pr/* revalidatePullRequestIdentity */.kf)(input.client, input.target.owner, input.target.repo, input.target.issueNumber, input.identity);
    await (0,github.assertRemoteBranchHead)(input.client, input.target.owner, input.target.repo, input.headBranch, input.boundHeadSha);
    await (0,github.updateRemoteBranch)(input.client, input.target.owner, input.target.repo, input.headBranch, created.sha);
    try {
        await publishStatusComment(input.client, input.target, input.expectedAuthorId, `DeepSeek Harness ${label} prepared`, `${input.result.output.summary}\n\nConfigured validation passed.\n\nCommit: \`${created.sha}\`\n\nChanged: ${created.paths.map((path) => `\`${path}\``).join(", ")}`, input.runUrl, task ? "task" : "write");
        return { commitSha: created.sha, paths: created.paths, status: "success" };
    }
    catch {
        // The branch update is the authoritative write. A later comment failure
        // must not turn an already-pushed fix into a failed/retried mutation.
        core/* warning */.$e(`Partial success: ${label} commit ${created.sha} was pushed, but its GitHub status comment could not be published.`);
        try {
            await core/* summary */.z
                .addHeading(`DeepSeek Harness ${label}: partial success`, 2)
                .addRaw(`${task ? "Task" : "Fix"} commit \`${created.sha}\` was pushed, but the status comment could not be published.`)
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