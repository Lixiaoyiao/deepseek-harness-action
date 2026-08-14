# DeepSeek Harness for GitHub

[![CI](https://github.com/Lixiaoyiao/deepseek-harness-action/actions/workflows/ci.yml/badge.svg)](https://github.com/Lixiaoyiao/deepseek-harness-action/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Lixiaoyiao/deepseek-harness-action?display_name=tag)](https://github.com/Lixiaoyiao/deepseek-harness-action/releases/latest)
[![MIT](https://img.shields.io/github/license/Lixiaoyiao/deepseek-harness-action)](LICENSE)

[English](README.en.md)

让 GitHub 里的 PR、Issue 和失败 CI 直接调用 DeepSeek Harness。

```text
GitHub PR / Issue / CI  →  DeepSeek Harness  →  Review / Diagnose / Fix / Issue → PR
```

它和 [Claude Code Action](https://github.com/anthropics/claude-code-action) 属于同一类 GitHub 集成：由 GitHub 事件启动 coding agent，再把 review、诊断或代码改动写回仓库。这个项目使用的是 DeepSeek Harness。

PR 可以自动收到行内 review；失败的 CI 可以得到诊断；在你明确开放写权限后，`@dsh` 也可以修代码或把 Issue 做成 PR。

这是由社区维护的项目，不是 DeepSeek 或 GitHub 官方产品。

Maintained by [@Lixiaoyiao](https://github.com/Lixiaoyiao).

## 真实运行

下面都是这个仓库自己的公开运行记录，可以直接查看评论和 Actions 日志。

| 场景                            | 运行记录                                                                                                                                                              |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR Review，以及复跑不重复发评论 | [PR #3](https://github.com/Lixiaoyiao/deepseek-harness-action/pull/3) · [Actions run](https://github.com/Lixiaoyiao/deepseek-harness-action/actions/runs/31760570162) |
| 读取失败 check 和日志后给出诊断 | [Actions run](https://github.com/Lixiaoyiao/deepseek-harness-action/actions/runs/31760603284)                                                                         |
| 受信任写模式下修复并验证        | [Actions run](https://github.com/Lixiaoyiao/deepseek-harness-action/actions/runs/31761793492)                                                                         |
| 从 Issue 实现代码并创建 PR      | [Issue #4](https://github.com/Lixiaoyiao/deepseek-harness-action/issues/4) → [PR #5](https://github.com/Lixiaoyiao/deepseek-harness-action/pull/5)                    |

## 快速开始

先在仓库的 **Settings → Secrets and variables → Actions** 中添加 `DEEPSEEK_API_KEY`。

然后创建 `.github/workflows/dsh-review.yml`：

```yaml
name: DSH review

on:
  pull_request_target:
    types: [opened, synchronize, ready_for_review, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    if: github.event.pull_request.draft == false
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
        with:
          ref: ${{ github.event.pull_request.base.sha }}
          persist-credentials: false
          fetch-depth: 1
      - uses: Lixiaoyiao/deepseek-harness-action@badb4542f53941ae99c13773574ea90e48a277a1 # v0.1.0
        with:
          deepseek-api-key: ${{ secrets.DEEPSEEK_API_KEY }}
```

现在打开一个非 draft PR。Action 会读取 diff 和仓库上下文，并发布 review summary；有确定问题时，也会在对应代码行留下评论。

完整模板见 [`examples/fork-review.yml`](examples/fork-review.yml)。这个 workflow 使用 `pull_request_target`，只 checkout 受信任的 base SHA，不会运行 fork 里的代码。

> v0.2.0 仍在开发中。上面的 Quick start 和 `examples/` 会继续固定到最近已发布的 v0.1.0 commit SHA，直到 v0.2.0 正式发布；下面标注为 v0.2.0 的功能描述对应当前 `main` 分支。完整 release notes 见 [`CHANGELOG.md`](CHANGELOG.md)。

## 能做什么

| 入口                                             | 结果                                  |
| ------------------------------------------------ | ------------------------------------- |
| PR `opened` / `synchronize` / `ready_for_review` | 自动 review，发布 summary 和行内评论  |
| `@dsh review`                                    | 手动重新 review 当前 PR               |
| `@dsh diagnose`                                  | 读取失败的 check 和日志，定位原因     |
| `@dsh fix`                                       | 在受信任写模式下修改代码并运行验证    |
| Issue 中的 `@dsh implement`                      | 理解 Issue、改代码、运行验证并创建 PR |

命令必须出现在评论第一行。可以直接复制这些 workflow：

- [`examples/commands.yml`](examples/commands.yml)：`@dsh` 命令、修复和 Issue → PR
- [`examples/ci-diagnose.yml`](examples/ci-diagnose.yml)：CI 失败诊断
- [`examples/ci-auto-fix.yml`](examples/ci-auto-fix.yml)：受信任的 CI 自动修复

`fix` 和 `implement` 不会因为写了命令就自动获得权限。你还需要在 workflow 中设置 `allow-write: "true"`，并配置测试命令。详细输入见 [`action.yml`](action.yml)。

## 运行进度与结构化输出（v0.2.0，Unreleased）

当一次获准的操作能够对应到 PR 或 Issue 时，controller 会在三个主要阶段更新一条 sticky comment：准备受限上下文、运行 DSH 并校验结构化输出、发布结果或执行受信任写入。它复用现有的 controller-owned v1 marker，因此不会额外制造一条“进度评论”：

| 操作                | 复用的 sticky marker |
| ------------------- | -------------------- |
| `review`            | `summary`            |
| `diagnose`          | `diagnosis`          |
| `fix` / `implement` | `write`              |

成功时，详细 review、诊断或写入结果会替换同一条评论；失败时，同一位置会显示稳定错误码、失败阶段、经过脱敏和限长的错误信息，以及建议的下一步。只有预期 numeric bot ID 发布的 marker 才会被更新，用户伪造的 marker 不会被接管。生命周期评论更新是 best effort：GitHub 评论 API 暂时不可用不会遮蔽 agent、validation 或写入的真实结果。

`progress-comment` 默认是 `true`。如果不希望显示中间状态，可以关闭：

```yaml
with:
  progress-comment: "false"
```

关闭它只会禁用 lifecycle 更新，不会关闭正常的 review 行内评论、review summary、CI diagnosis 或 fix 最终状态发布。

建议让 job 的 `timeout-minutes` 比 Action 的同名输入多留几分钟；这样 DSH 内部 watchdog 能先结束 worker，并有时间写完失败 outputs、step summary 和 sticky comment。

Action 在 success、neutral 和 failure 路径都会设置 `result-json`。这是带 `schemaVersion: 1` 的 JSON envelope，包含适用的 `status`、operation、summary、timing、policy/capabilities、实际 isolation report、publication 统计、controller validation、write 结果、sticky comment ID 和 error。`status` 可能是 `success`、`neutral`、`failed`、`timed_out`、`validation_failed` 或 `denied`；`validation_failed` 同时覆盖无效的 DSH structured output 和 controller validation 失败，具体由 `error.code` 区分。失败对象包含稳定的 `code`、`phase`、`title`、`message`、`guidance` 和 `retryable`。

所有标量 outputs 如下：

| Output             | 含义                                                               |
| ------------------ | ------------------------------------------------------------------ |
| `conclusion`       | `success`、`neutral` 或 `failure`                                  |
| `operation`        | `review`、`diagnose`、`fix`、`implement` 或 `none`                 |
| `summary`          | 任意操作的校验后摘要，失败时为安全的失败摘要                       |
| `review-summary`   | `summary` 的向后兼容别名                                           |
| `findings-count`   | review 中选中的 finding 数；其他操作中为已校验的 agent finding 数  |
| `branch-name`      | 创建的 DSH 分支（不适用时为空）                                    |
| `pull-request-url` | 创建的 PR URL（不适用时为空）                                      |
| `commit-sha`       | 成功 fix 创建的 commit（不适用时为空）                             |
| `trust`            | `untrusted`、`trusted-read`、`trusted-write` 或尚未解析时的 `none` |
| `duration-ms`      | controller 总耗时，毫秒                                            |
| `comment-id`       | 可用时的 sticky progress/result comment ID                         |
| `error-code`       | 稳定失败码；成功和 neutral 时为空                                  |
| `error-message`    | 脱敏且限长的失败信息                                               |
| `result-json`      | 上述 versioned JSON envelope                                       |

v0.1.0 已有的 `conclusion`、`operation`、`review-summary`、`findings-count`、`branch-name` 和 `pull-request-url` 均保留；现有 workflow 不需要改写。模型给出的 `verification` 与 controller 真正运行的 validation 是两类数据，`result-json` 会把后者单独放在 `validation` 中。

失败的 Action step 也会先写 outputs；后续步骤要读取它时，请使用 `always()`，并通过环境变量传给 shell，避免把模型派生文本直接拼进脚本：

```yaml
# 先给 DeepSeek Harness step 设置 id: dsh
- name: Inspect DSH result
  if: ${{ always() && steps.dsh.outputs['result-json'] != '' }}
  env:
    DSH_RESULT_JSON: ${{ steps.dsh.outputs['result-json'] }}
  run: printf '%s\n' "$DSH_RESULT_JSON" | jq .
```

`result-json` 中的 summary、路径和其他模型派生字符串仍然是不可信数据；它们是 observability/output data，不能作为授权信号，也不要直接插入 shell 命令。

## 写模式

`allow-write` 默认是 `false`。写入只对同仓库、受信任操作者开放；fork PR 始终是 review-only。测试命令使用 argv 数组，不经过 shell 展开：

```yaml
with:
  allow-write: "true"
  run-tests: "true"
  test-commands: '[["npm","ci","--ignore-scripts"],["npm","test"],["npm","run","typecheck"]]'
  container-image: docker.io/library/node:24.18.0-bookworm@sha256:5711a0d445a1af54af9589066c646df387d1831a608226f4cd694fc59e745059
```

写模式要求使用完整的 Docker image digest。Docker 需要在 runner 上可用。

## 安全

安全模型分成四层，避免把“操作者可信”和“仓库内容可信”混为一谈：

1. **Actor / control plane**：交互式 `@dsh` 命令要求所有来源 actor 都通过 write/maintain/admin 检查；写操作还必须显式设置 `allow-write: "true"`。workflow token scopes 只决定 controller 能调用哪些 GitHub API，不能绕过 actor 或 policy gate。
2. **输入数据**：仓库文件、diff、CI 日志、README/AGENTS/CLAUDE、Issue、PR 和评论始终是不可信数据。模型输出也不直接获得权力，必须通过严格 schema、路径、大小和 marker 校验。
3. **Worker**：`untrusted`、`trusted-read`、`trusted-write` 是执行 profile，不表示仓库内容变得可信。fork 没有仓库工具；read profile 只允许不可变副本上的 read/search；write profile 只允许 `.git`-less 副本上的 read/search/edit，不能运行 shell 或直接调用 GitHub。
4. **Controller / commit authority**：只有 controller 持有 GitHub client 和真实凭据，负责重新绑定 SHA/Issue/PR identity、运行无凭据 validation、检查实际文件变化，并最终评论、commit、push 或创建 PR。

常用模板的 workflow permissions：

| 场景                        | Workflow token permissions                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------- |
| 自动或 fork PR review       | `contents: read`、`pull-requests: write`                                                    |
| CI diagnosis                | `actions: read`、`checks: read`、`contents: read`、`issues: write`、`pull-requests: write`  |
| 支持 fix / implement 的命令 | `contents: write`、`actions: read`、`checks: read`、`issues: write`、`pull-requests: write` |
| CI auto-fix                 | 与上一行相同                                                                                |

progress comment 使用与最终结果评论相同的权限，不新增 scope。`GITHUB_TOKEN` 只留在 controller；DeepSeek key 由 controller 侧代理注入，两者都不会进入 DSH workspace 或 validation 命令。完整信任边界、已知限制和漏洞报告方式见 [`SECURITY.md`](SECURITY.md)。当前已发布的 v0.1.0 固定使用 `@deepseek-ai/dsh@0.1.0-rc.6`；DSH 仍在快速迭代，升级前请重新检查配置。

## 架构

```text
GitHub event
    ↓
Action controller: route → resolve target → authorize
    ↓
Controller-owned sticky progress → bounded workspace / context
    ↓
DSH worker in Docker
    ↓
Action controller: schema validation → publish / controller validation / write
    ↓
Action outputs: legacy scalars + versioned result-json
```

DSH worker 不持有 GitHub client。模型输出通过 schema 校验后，才由 controller 映射到 diff 行、更新 tracking 评论或执行受信任写入。

## 开发

需要 Node.js 24。

```bash
npm ci
npm run check
```

Marketplace 使用的 `dist/` 会随 release 一起提交。依赖和打包说明见 [`BUNDLED_DEPENDENCIES.md`](BUNDLED_DEPENDENCIES.md)。

## License

[MIT](LICENSE)。第三方许可见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

## Acknowledgements

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供本项目使用的 headless agent runtime。
- GitHub 事件路由、权限检查和 tracking 机制基于 [Claude Code Action](https://github.com/anthropics/claude-code-action) 的 MIT 实现适配。对应上游 commit 和许可文本记录在 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。
- Structured output 和执行/发布权限分离的设计也参考了 [Codex GitHub Action](https://learn.chatgpt.com/docs/github-action)；本项目仍保留自己的 controller/worker 信任边界与输出协议。
