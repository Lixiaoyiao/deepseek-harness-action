export const id = 327;
export const ids = [327];
export const modules = {

/***/ 53327:
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {


// EXPORTS
__webpack_require__.d(__webpack_exports__, {
  finishFix: () => (/* binding */ finishFix)
});

// EXTERNAL MODULE: ./node_modules/@actions/core/lib/core.js + 13 modules
var core = __webpack_require__(77094);
// EXTERNAL MODULE: ./src/review/tracking.ts
var tracking = __webpack_require__(94843);
// EXTERNAL MODULE: ./src/github/comments.ts
var comments = __webpack_require__(66645);
// EXTERNAL MODULE: ./src/security/redaction.ts
var redaction = __webpack_require__(65275);
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

// EXTERNAL MODULE: ./src/write/transaction.ts + 2 modules
var transaction = __webpack_require__(88284);
;// CONCATENATED MODULE: ./src/commands/fix.ts



async function finishFix(input) {
    const task = input.result.output.operation === "task";
    const label = task ? "task" : "fix";
    const created = await (0,transaction/* executeValidatedRepositoryWrite */.L)({
        client: input.client,
        repository: { owner: input.target.owner, repo: input.target.repo },
        workspace: input.snapshot,
        plan: {
            kind: "pr-head",
            target: { number: input.target.issueNumber, identity: input.identity },
            commitMessage: task ? "feat: apply DeepSeek Harness task" : "fix: apply DeepSeek Harness fix",
        },
        validation: {
            runTests: input.inputs.runTests,
            commands: input.inputs.testCommands,
            containerImage: input.inputs.containerImage,
        },
        control: input,
    });
    try {
        await publishStatusComment(input.client, input.target, input.expectedAuthorId, `DeepSeek Harness ${label} prepared`, `${input.result.output.summary}\n\nConfigured validation passed.\n\nCommit: \`${created.commitSha}\`\n\nChanged: ${created.paths.map((path) => `\`${path}\``).join(", ")}`, input.runUrl, task ? "task" : "write");
        return { commitSha: created.commitSha, paths: created.paths, status: "success" };
    }
    catch {
        // The branch update is the authoritative write. A later comment failure
        // must not turn an already-pushed fix into a failed/retried mutation.
        core/* warning */.$e(`Partial success: ${label} commit ${created.commitSha} was pushed, but its GitHub status comment could not be published.`);
        try {
            await core/* summary */.z
                .addHeading(`DeepSeek Harness ${label}: partial success`, 2)
                .addRaw(`${task ? "Task" : "Fix"} commit \`${created.commitSha}\` was pushed, but the status comment could not be published.`)
                .write();
        }
        catch {
            core/* warning */.$e("The partial-success step summary could not be published either.");
        }
        return { commitSha: created.commitSha, paths: created.paths, status: "partial-success" };
    }
}


/***/ })

};

//# sourceMappingURL=327.index.js.map