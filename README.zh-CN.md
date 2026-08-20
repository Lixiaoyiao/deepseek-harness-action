# DeepSeek Harness for GitHub

[![CI](https://github.com/Lixiaoyiao/deepseek-harness-action/actions/workflows/ci.yml/badge.svg)](https://github.com/Lixiaoyiao/deepseek-harness-action/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Lixiaoyiao/deepseek-harness-action?display_name=tag)](https://github.com/Lixiaoyiao/deepseek-harness-action/releases/latest)
[![MIT](https://img.shields.io/github/license/Lixiaoyiao/deepseek-harness-action)](LICENSE)

[English](README.md)

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
      - uses: Lixiaoyiao/deepseek-harness-action@50580590de152abcc3bd81c07b26dd632b76360b # v0.2.0
        with:
          deepseek-api-key: ${{ secrets.DEEPSEEK_API_KEY }}
```

现在打开一个非 draft PR。Action 会读取 diff 和仓库上下文，并发布 review summary；有确定问题时，也会在对应代码行留下评论。

完整模板见 [`examples/fork-review.yml`](examples/fork-review.yml)。这个 workflow 使用 `pull_request_target`，只 checkout 受信任的 base SHA，不会运行 fork 里的代码。

> v0.2.0 已发布。上面的 Quick start 和现有 v0.2 模板仍固定到本次真实 E2E 验证过的不可变 runtime commit SHA，不代表该 SHA 已包含下述 v0.3 功能。新增的 [`examples/task-automation.yml`](examples/task-automation.yml) 明确标记为拟发布 v0.3 接口；发布后应把 tag 换成不可变 commit SHA。完整 release notes 见 [`CHANGELOG.md`](CHANGELOG.md)。

## 能做什么

| 入口                                                 | 结果                                       |
| ---------------------------------------------------- | ------------------------------------------ |
| PR `opened` / `synchronize` / `ready_for_review`     | 自动 review，发布 summary 和行内评论       |
| `@dsh task --read <问题或任务>`                      | 通用问答、代码阅读和仓库分析               |
| `@dsh task --write <编码任务>`                       | 在全部写入 gate 通过后修改、验证并交付代码 |
| dispatch / schedule workflow 中显式设置非空 `prompt` | 运行通用自动化 task                        |
| `@dsh review`                                        | 手动重新 review 当前 PR                    |
| `@dsh diagnose`                                      | 读取失败的 check 和日志，定位原因          |
| `@dsh fix`                                           | 在受信任写模式下修改代码并运行验证         |
| Issue 中的 `@dsh implement`                          | 理解 Issue、改代码、运行验证并创建 PR      |

命令必须出现在评论第一行。可以直接复制这些 workflow：

- [`examples/commands.yml`](examples/commands.yml)：`@dsh` 命令、修复和 Issue → PR
- [`examples/ci-diagnose.yml`](examples/ci-diagnose.yml)：CI 失败诊断
- [`examples/ci-auto-fix.yml`](examples/ci-auto-fix.yml)：受信任的 CI 自动修复
- [`examples/task-automation.yml`](examples/task-automation.yml)：拟发布 v0.3 的显式 prompt 通用自动化

`fix` 和 `implement` 不会因为写了命令就自动获得权限。你还需要在 workflow 中设置 `allow-write: "true"`，并配置测试命令。详细输入见 [`action.yml`](action.yml)。

## 通用 task 与显式自动化（v0.3.0 开发预览）

`task` 不把工作限制在 review、diagnose、fix 或 implement 模板内。它既能回答自然语言问题，也能阅读仓库或执行编码任务：

```text
@dsh task --read 解释这个 PR 为什么需要两阶段提交
@dsh task --write 为解析器补上空输入测试并运行验证
```

命令必须从评论第一行开始；后续行可以继续写任务说明。`--read` 是 `task` 的默认值。`--write` 只表示请求写能力，不是授权：仍需 `allow-write: "true"`、同仓库且非 `pull_request_target` 的上下文、所有来源 actor 通过 write/maintain/admin 检查，以及 `workspace.edit` 留在有效工具 allowlist 中。fork PR 永远不会因此升级为写模式。

在 `workflow_dispatch`、`repository_dispatch` 或 `schedule` 这类自动化事件中，`command: auto` 加非空 `prompt` 会路由到通用 `task`。也可以显式设置 `command: task`；此时 `prompt` 必填。`task-access` 默认为 `read`：

```yaml
with:
  command: auto
  prompt: "检查依赖边界，必要时补测试并解释结果"
  task-access: read
```

`prompt` 属于受信任 control-plane 配置，只应来自维护者写入的 workflow 或受信任的 dispatch 输入；不要把 Issue 正文、PR 内容、日志或其他不可信数据未经区分地提升为 `prompt`。完整的读/写 dispatch 模板见 [`examples/task-automation.yml`](examples/task-automation.yml)。该模板使用拟发布的 `@v0.3` 接口占位，正式发布后必须固定到不可变 commit SHA。

无 Issue/PR 实体的只读自动化会通过 step summary 和 outputs 返回回答。无实体或以 Issue 为目标的写 task 会创建独立 `dsh/task-*` 分支和 PR；controller 不会把通用自动化改动直接推到默认分支。PR 上获准的同仓库写 task 仍只作用于 controller 绑定并重新校验过的目标分支。

## 多轮修改、验证与修复闭环

v0.3 的循环在 Action controller 中，而不在 DSH shell 中。每一轮都是新的、受同一任务锚点和能力策略约束的 DSH turn：

```text
DSH turn
  ├─ needs_tool → controller 运行一个已允许工具 → 限长/脱敏结果作为不可信反馈 → 下一轮
  ├─ final → controller validation 失败 → stdout/stderr 作为不可信反馈 → 下一轮修改
  ├─ final → validation 通过 → controller 发布、commit 或创建 PR
  └─ blocked → 安全结束并返回 neutral
```

DSH 不能直接运行 shell，也不持有 GitHub 或 DeepSeek 凭据。controller 负责工具执行、validation、实际变更检查和最后的 GitHub 写入。`max-turns`（默认 3）统一限制工具请求和 validation 修复所消耗的 DSH turn；`timeout-minutes` 是整个 controller loop 的总 deadline。若相同 workspace revision 连续得到相同 validation 失败，controller 会以 no-progress 错误停止，避免无效循环。turn/tool/validation-retry 计数与限长 tool receipts 会写入 `result-json.loop`。

## 维护者定义的安全命令工具

模型不能自由拼 shell。维护者在 versioned `tool-config` 中给每个命令固定完整 argv，再通过 `allowed-tools` 单独暴露其 ID：

```yaml
with:
  allowed-tools: '["workspace.read","workspace.search","workspace.edit","command.unit-tests"]'
  tool-config: |
    {
      "schemaVersion": 1,
      "commands": [{
        "name": "unit-tests",
        "description": "Run the repository unit-test command",
        "argv": ["npm", "test"],
        "timeoutMinutes": 10,
        "maxOutputBytes": 131072,
        "maxCalls": 2,
        "network": "none",
        "workspaceAccess": "read"
      }]
    }
```

请把示例 argv 替换为仓库自己的确定命令。command tool 不接收模型参数；常见的直接 shell executable 会作为附加防线被拒绝，未定义工具、超出调用次数以及不符合当前 policy 的 network/workspace 权限也会失败。真正的安全边界是维护者固定全部 argv、模型不能追加参数，以及凭据隔离的容器。命令在无 controller 凭据、固定 digest 的 hardened container 中运行；stdout/stderr 会限长和脱敏，并始终按不可信数据回送。仅把工具写进 manifest 也不会授权执行：ID 还必须出现在 `allowed-tools`，且当前 security policy 必须允许相应的 execute/write/network capability。

## v0.3 扩展接口与 v0.2 兼容性

v0.3 在 controller 内部固定了 protocol v1 的 `AgentEngine`、`ToolProvider`、`ExtensionProvider`、`SessionStore` 与 session binding 数据形状。binding 为将来的 resume 预留 repository/head、actor、policy、task scope、engine、toolset 和 extension lock 绑定，避免跨仓库、跨 SHA 或跨能力策略复用会话。

这些目前只是扩展 seam：**v0.3.0 没有启用真实 MCP server、插件发现/安装/执行，也没有跨 workflow run 的 session 持久化或 resume**。当前没有可配置的 MCP/plugin/resume action input，也不会输出可复用 session token；请勿把 provider 类型名理解成已交付功能。

协议版本、tool routing、session binding 与未来 provider 必须满足的安全责任见 [`docs/extension-contracts.md`](docs/extension-contracts.md)。

v0.2 的既有 inputs、scalar outputs 和 schema-v1 `result-json` envelope 继续有效；`command: auto` 保持原来的自动 review 与 `workflow_run` diagnose/fix 路由。v0.3 只新增 `task` operation 和可选 loop metadata，默认 `task-access: read`、`max-turns: 3`，且 command manifest 为空，因此现有 workflow 不需要为新能力改写。上面的 v0.2.0 SHA 示例仍然只代表 v0.2.0。

## 运行进度与结构化输出

当一次获准的操作能够对应到 PR 或 Issue 时，controller 会在三个主要阶段更新一条 sticky comment：准备受限上下文、运行 DSH 并校验结构化输出、发布结果或执行受信任写入。它复用现有的 controller-owned v1 marker，因此不会额外制造一条“进度评论”：

| 操作                | 复用的 sticky marker |
| ------------------- | -------------------- |
| `task`              | `task`               |
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
| `operation`        | `task`、`review`、`diagnose`、`fix`、`implement` 或 `none`         |
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

| 场景                          | Workflow token permissions                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------- |
| 自动或 fork PR review         | `contents: read`、`pull-requests: write`                                                    |
| 只读通用 task                 | `contents: read`；需要 Issue/PR sticky comment 时再加对应 write scope                       |
| 创建分支和 PR 的自动化写 task | `contents: write`、`pull-requests: write`                                                   |
| CI diagnosis                  | `actions: read`、`checks: read`、`contents: read`、`issues: write`、`pull-requests: write`  |
| 支持 fix / implement 的命令   | `contents: write`、`actions: read`、`checks: read`、`issues: write`、`pull-requests: write` |
| CI auto-fix                   | 与上一行相同                                                                                |

progress comment 使用与最终结果评论相同的权限，不新增 scope。`GITHUB_TOKEN` 只留在 controller；DeepSeek key 由 controller 侧代理注入，两者都不会进入 DSH workspace 或 validation 命令。完整信任边界、已知限制和漏洞报告方式见 [`SECURITY.md`](SECURITY.md)。v0.3.0 仍只接受经过当前 policy profile 审计的 `@deepseek-ai/dsh@0.1.0-rc.6`；DSH 仍在快速迭代，升级版本前必须新增并审查对应 profile。

## 架构

```text
GitHub event
    ↓
Action controller: route task/review/diagnose/fix/implement → resolve target → authorize
    ↓
Controller-owned sticky progress → bounded workspace / context
    ↓
Fresh DSH turn in Docker
    ├─ needs_tool → controller fixed-argv tool ─┐
    └─ final → controller validation failure ──┤ bounded untrusted feedback
                                               └→ next DSH turn (max-turns/deadline)
    ↓
Action controller: final schema + validation → publish / commit / branch + PR
    ↓
Action outputs: legacy scalars + versioned result-json
```

DSH worker 不持有 GitHub client。模型输出通过 schema 校验后，才由 controller 映射到 diff 行、调用已授权工具、更新 tracking 评论或执行受信任写入。MCP/plugin/session store 目前只位于 provider contract 层，不在这条运行路径中。

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
