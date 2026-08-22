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
      - uses: Lixiaoyiao/deepseek-harness-action@v0.5.1
        with:
          deepseek-api-key: ${{ secrets.DEEPSEEK_API_KEY }}
          dsh-version: 0.1.1-rc.2
```

现在打开一个非 draft PR。Action 会读取 diff 和仓库上下文，并发布 review summary；有确定问题时，也会在对应代码行留下评论。

完整模板见 [`examples/fork-review.yml`](examples/fork-review.yml)。这个 workflow 使用 `pull_request_target`，只 checkout 受信任的 base SHA，不会运行 fork 里的代码。

> 此 Quick start 跟随 v0.5.1 release Tag，让新用户默认使用当前版本。生产环境请把 Tag 替换为 v0.5.1 发布时给出的完整不可变 commit SHA。v0.3/v0.4/v0.5.0 的历史行为仍保留在 [`CHANGELOG.md`](CHANGELOG.md) 中。

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
- [`examples/task-automation.yml`](examples/task-automation.yml)：v0.5.1 基于 profile 的显式 prompt 通用自动化
- [`examples/controlled-extensions.yml`](examples/controlled-extensions.yml)：v0.5.1 custom MCP 与 DSH Bundle/Profile 配置

`fix` 和 `implement` 不会因为写了命令就自动获得权限。你还需要在 workflow 中设置 `allow-write: "true"`、保持 `run-tests: "true"`，并在 `test-commands` 中提供至少一个 argv 数组。详细输入见 [`action.yml`](action.yml)。

## 通用 task 与显式自动化

`task` 不把工作限制在 review、diagnose、fix 或 implement 模板内。它既能回答自然语言问题，也能阅读仓库或执行编码任务：

```text
@dsh task --read 解释这个 PR 为什么需要两阶段提交
@dsh task --write 为解析器补上空输入测试并运行验证
```

命令必须从评论第一行开始；后续行可以继续写任务说明。`--read` 是 `task` 的默认值。`--write` 只表示请求写能力，不是授权：仍需 `allow-write: "true"`、`run-tests: "true"`、非空 validation command 列表、同仓库且非 `pull_request_target` 的上下文、所有来源 actor 通过 write/maintain/admin 检查，以及 `workspace.edit` 留在有效工具 allowlist 中。fork PR 永远不会因此升级为写模式。

在 `workflow_dispatch`、`repository_dispatch` 或 `schedule` 这类自动化事件中，`command: auto` 加非空 `prompt` 会路由到通用 `task`。也可以显式设置 `command: task`；此时 `prompt` 必填。`task-access` 默认为 `read`：

```yaml
with:
  command: auto
  prompt: "检查依赖边界，必要时补测试并解释结果"
  task-access: read
```

`prompt` 属于受信任 control-plane 配置，只应来自维护者写入的 workflow 或受信任的 dispatch 输入；不要把 Issue 正文、PR 内容、日志或其他不可信数据未经区分地提升为 `prompt`。同样的来源规则也适用于 capability inputs，尤其是 `permission-profile`、`allowed-tools`、`disallowed-tools`、`container-image`、`base-url`、`web-search-base-url`、`isolation` 与 `dsh-executable`：它们决定权限、worker code、凭据路由或进程边界。当前基于 profile 的完整读/写 dispatch 模板见 [`examples/task-automation.yml`](examples/task-automation.yml)。

无 Issue/PR 实体的只读自动化会通过 step summary 和 outputs 返回回答。无实体或以 Issue 为目标的写 task 会创建独立 `dsh/task-*` 分支和 PR；controller 不会把通用自动化改动直接推到默认分支。PR 上获准的同仓库写 task 仍只作用于 controller 绑定并重新校验过的目标分支。

## 多轮修改、验证与修复闭环

v0.3 引入的 controller loop 在 v0.5.1 中仍是执行模型。它属于 Action controller，而不在 DSH shell 中；每一轮都是新的、受同一任务锚点和能力策略约束的 DSH turn：

```text
DSH turn
  ├─ needs_tool → controller 运行一个已允许工具 → 限长/脱敏结果作为不可信反馈 → 下一轮
  ├─ final → controller validation 失败 → stdout/stderr 作为不可信反馈 → 下一轮修改
  ├─ final → validation 通过 → controller 发布、commit 或创建 PR
  └─ blocked → 安全结束并返回 neutral
```

默认 `strict` Agent toolset 没有 shell。受信任维护者可以选择 `standard` 或精确的 `custom` 策略，在无凭据 Docker worker 内开放经过审计的 DSH 原生 Bash 工具。任何 profile 都不会让 DSH 获得 GitHub 凭据、真实 DeepSeek key、自行批准或扩大工具集合的能力，也不会获得 commit/push/PR/Release 权限。显式获准的第三方扩展属于受信任 worker code，可以产生下文说明的进程级副作用。controller 负责 validation、实际变更检查和所有最终 GitHub mutation。`max-turns`（默认 3）统一限制工具请求和 validation 修复所消耗的 DSH turn；`timeout-minutes` 是整个 controller loop 的总 deadline。若相同 workspace revision 连续得到相同 validation 失败，controller 会以 no-progress 错误停止，避免无效循环。turn/tool/validation-retry 计数与限长 tool receipts 会写入 `result-json.loop`。

## 权限档位

多数 workflow 只需要选择一个 preset。权限档位控制沙箱内的 Agent，不授予 GitHub authority。

| Profile    | 适用场景                        | 预设工具                                                                                     |
| ---------- | ------------------------------- | -------------------------------------------------------------------------------------------- |
| `strict`   | Review 与兼容 v0.4 的默认行为   | `workspace.read`、`workspace.search`，以及 policy 允许时的 `workspace.edit`                  |
| `standard` | 受信任维护者的常规 Coding Agent | strict preset 加 `native.bash`、Controller-mediated `native.web-search` 和 `native.subagent` |
| `custom`   | 精确工具、MCP、Bundle 或 Plugin | 不预设工具；显式列出每个需要的 canonical ID                                                  |

`allowed-tools` 在 preset 展开后增加精确 ID；`disallowed-tools` 使用相同的精确 ID 语法，并始终优先。可用族为 `workspace.*`、`native.*`、`command.<name>`、`mcp.<server>.<tool>` 和 `plugin.<extension>.<tool>`。如果 v0.4 workflow 依赖较小的精确 allowlist，应改选 `custom`，或加入对应 deny 项，因为 allowlist 不再替换 `strict`/`standard` preset。最终结果仍要与 actor、event、trust、workspace、network、extension 和 Controller policy 取交集；任何越界请求都会 fail closed。`custom` 不是通配授权：它从空集开始，未知、不可用、遗漏或 policy 不允许的 ID 都会 fail closed。outputs 与 step summary 会报告解析后的 `permission-profile`、`effective-tools`、`network-access`、`workspace-write` 和 `trusted-extensions`。

`native.web-search` 由 Controller 通过已配置的 DeepSeek web-search endpoint 中介；它不会把真实 key 暴露给 DSH，也不等于开放通用 bridge egress。`native.bash` 要求 trusted-write Docker，不能与 bridge-networked extension 共用 worker。MCP、Bundle 与 Plugin 配置属于高级 `custom` 路径，因为获准的启动代码是 trusted worker code。Agent 无法修改自己的 profile、allow/deny 列表、extension 配置或安装 gate。

## 维护者定义的安全命令工具

`command.*` 工具不能接收或组装模型提供的 argv。维护者在 versioned `tool-config` 中给每个命令固定完整 argv，再通过 `allowed-tools` 单独暴露其 ID：

```yaml
with:
  permission-profile: custom
  allowed-tools: '["workspace.read","workspace.search","workspace.edit","command.bundle-syntax"]'
  tool-config: |
    {
      "schemaVersion": 1,
      "commands": [{
        "name": "bundle-syntax",
        "description": "Check the bundled JavaScript syntax without installing dependencies",
        "argv": ["node", "--check", "dist/index.js"],
        "timeoutMinutes": 10,
        "maxOutputBytes": 131072,
        "maxCalls": 2,
        "network": "none",
        "workspaceAccess": "read"
      }]
    }
```

请把示例 argv 替换为仓库自己的确定命令。command tool 不接收模型参数；常见的直接 shell executable 会作为附加防线被拒绝，未定义工具、超出调用次数以及不符合当前 policy 的 network/workspace 权限也会失败。真正的安全边界是维护者固定全部 argv、模型不能追加参数，以及凭据隔离的容器。如果 workflow 把 controller 凭据插值进 command-tool 或 validation argv，输入校验会直接拒绝。命令在无 controller 凭据、固定 digest 的 hardened container 中运行；stdout/stderr 会限长和脱敏，并始终按不可信数据回送。仅把工具写进 manifest 也不会授权执行：ID 还必须出现在 `allowed-tools`，且当前 security policy 必须允许相应的 execute/write/network capability。单独的 `native.bash` 只会通过显式 `standard`/`custom` profile，并在 trusted-write Docker policy 检查后开放；它只能运行受限的前台命令，继承沙箱与凭据隔离，且不会获得提权批准。

## 官方 MCP、Bundle 与 Profile 接入

v0.5.1 把完整、经过审计的 DSH 依赖集从 `0.1.0-rc.8` 升级到精确固定的 `0.1.1-rc.2`，包括 `@deepseek-ai/dsh`、app-boot、官方 MCP client、Profile/Bundle 支持、原生工具及其它直接使用的 package。rc.2 复核覆盖 app-boot、Profile/Bundle/Plugin 加载、MCP、ToolRuntime、Bash、Web Search、Subagent、receipts 以及 Docker/path/timeout 行为；现有 Action inputs、outputs 与权限语义无需改变。Controller 仍生成受控 `github-action` Profile 与 Cordis patch，通过 `@deepseek-ai/dsh-app-boot@0.1.1-rc.2` 启动，而没有另造 MCP client 或 plugin loader。该路径跳过 workspace 与 `$DSH_HOME` 的 `.env` 发现，也不启用通用 CLI 的动态 user patch 监听/热加载路径。随 Action 交付的 DSH 依赖全部由 lockfile 精确固定；`latest`、semver range、浮动 Git ref 和旧式 MCP SSE 均会被拒绝。

官方 MCP client 在这里开放它实际支持的 transport：

- `stdio`：command 必须是 bare executable name 或 `/workspace` 之外的绝对 container path；shell、interpreter、downloader、包管理器、Git 与 `npx` 等动态 runner 会被拒绝；`cwd` 只能是仓库内相对路径。启动获准 executable 等同于在容器内授予完整 trusted worker-code execution，而不只是注册一个 tool schema。
- `streamable-http`：URL 必须使用 HTTP(S)，不得内嵌凭据或 fragment；server 和每个暴露工具都必须显式声明 `network`。结构化 audit 及其公开 profile digest 只公开 URL origin，不公开 pathname、query 或 headers；另一个仅供 Controller 使用的 digest 会为 runtime 复用绑定完整、已校验的配置。

`mcp-config` 是严格、带版本号的 server/tool allowlist。仅定义 server 不会授权：每个可见工具还必须以 `mcp.<server-id>.<tool-id>` 出现在 `allowed-tools`。Controller 自行推导官方 DSH 的 `mcp__...` 模型侧名称，因此 prompt 不能新增 server、重命名工具或扩大权限。例如：

```yaml
with:
  permission-profile: custom
  allowed-tools: '["workspace.read","workspace.search","mcp.repo-index.lookup"]'
  mcp-config: |
    {
      "schemaVersion": 1,
      "servers": [{
        "id": "repo-index",
        "transport": "stdio",
        "command": "/opt/dsh-extensions/bin/repository-index-mcp",
        "args": ["--stdio"],
        "cwd": ".",
        "network": false,
        "maxCalls": 8,
        "tools": [{
          "id": "lookup",
          "name": "lookup",
          "description": "Search the prebuilt repository index",
          "permissions": ["read"],
          "timeoutMs": 15000,
          "maxOutputBytes": 65536,
          "maxCalls": 4
        }]
      }]
    }
```

示例 executable 特意由 image 提供：请把经过审计的 server 构建进 digest-pinned `container-image`，不要在模型 turn 中下载。任何有效 MCP、Bundle 或 plugin 工具都要求 `isolation: docker`；本地 `dsh-executable` 兼容路径不能加载扩展。`streamable-http` 形状与受控 Profile/Bundle 路径见 [`examples/controlled-extensions.yml`](examples/controlled-extensions.yml)。

`plugin-config` 使用官方 Bundle/Profile 机制。每个 Bundle 或 plugin 都必须写明 package name、精确 semver 或 `git+https://github.com/...git#<40-character-commit>` source、工具清单和 network 行为。Package 工具在 Action 侧使用 `plugin.<extension-id>.<tool-id>`，在 DSH runtime 中必须以 `plugin__<extension-id>__` 开头。只有受信任 workflow 显式设置 `allow-plugin-install: "true"` 后才允许安装第三方 package；默认关闭。

> 第三方 Bundle 或 plugin 会在 DSH 启动阶段执行完整的 trusted worker code。获取 package 时会禁用 NPM lifecycle script，但工具调用 allowlist 不能沙箱化 package 初始化、后台任务或直接进程 I/O。应审查 package 及其 transitive dependency graph、不可变固定 source，必要时使用专用 runner/image，并把 network/workspace access 当成在该 worker 上授权代码执行。`allow-plugin-install` 永远不能由 prompt、PR、Issue、仓库文件或模型输出推导。

安装有效第三方 package 前，Controller 会快照完整的顶层 runtime package inventory。安装后会再次核对；如果任何既有 package 被删除或版本发生变化，则立即中止。随后还会单独核验已配置 extension 的 package identity 及精确 version 或 commit。

所有工具类型都从同一份 Controller policy 编译，并默认 fail closed：

| 限制              | 执行规则                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| `read`            | 需要读取仓库能力；untrusted fork profile 不可用                                                  |
| `workspace-write` | 需要 trusted-write、`allow-write: "true"`、同仓库 origin、actor 检查和最终 Controller validation |
| `network`         | owner 与每个工具都必须声明，且有效 Controller policy 必须允许                                    |
| `timeoutMs`       | 限制一次调用；同进程 plugin 取消是 cooperative，Action 总 deadline 会硬停止 DSH                  |
| `maxOutputBytes`  | 工具结果返回模型作为不可信反馈前的序列化字节上限                                                 |
| `maxCalls`        | 在 Controller 多轮 loop 内同时限制单工具和所属 server/package 的调用数                           |

Action 自有 policy adapter 对模型路由的 DSH native tools、官方 MCP tools 和 plugin tools 调用应用正向 runtime allowlist；现有 Controller `ToolRouter` 继续执行固定 argv 的 `command.*` 工具。两条执行路径共享 Controller 解析后的 capability、limit、audit identity 与限长 receipt。这只能约束模型可路由的调用，无法约束一个已经获准、主动恶意的 stdio server、Bundle 或 plugin 在启动、后台任务或直接进程 I/O 中做什么。Agent 本身不会得到无限制 shell、`GITHUB_TOKEN`、真实 DeepSeek key 或 commit/push/PR 权限。

限制前，每个可见 runtime tool 都必须属于 Controller 审计清单，且每个 selected tool 必须实际存在；配置中已声明但未列入 `allowed-tools` 的工具不要求完成注册。限制后，模型可见清单必须与 selected allowlist 完全一致。未知工具、缺失的 selected tool，以及仍暴露在 allowlist 外的 agent-scoped tool 都会 fail closed；独立的单调 ToolRuntime guard 还会拒绝任何缺少有效 Controller rule 的调用。

Network 与 workspace mount 属于整个 DSH 进程，而不是单个工具。由于 extension 进程共享 Agent 的仓库视图，每个 extension tool 都必须显式声明 `read`；同一 turn 内所有有效 MCP server/package 还必须声明相同的 network 与 workspace-write 模式。trusted-read worker 只接受 read-only owner，trusted-write worker 中共同运行的每个 owner 都必须显式声明 `workspace-write`。不同模式会被拒绝，而不会被表述成并不存在的 per-tool isolation。`network: false` 表示内部 Docker network 阻止普通外部出站，并非 worker 完全没有网络路径：DSH 仍会把 `host.docker.internal` 映射到该 network 经检查得到的 IPv4 gateway，以访问 Controller 侧 LLM proxy。因此有效权限 output 会报告 `host-gateway`，而不是 `none`。该 host-gateway path 不是 port allowlist，其他 host service 是否可达由 runner firewall policy 决定，package acquisition 也会另行使用 bridge network。

Profile composition、ID mapping、进程级兼容规则、receipt 形状与 deferred session 边界详见 [`docs/extension-contracts.md`](docs/extension-contracts.md)。

### 兼容性

默认 `strict` profile 保留 v0.4/v0.5.0 的 review、diagnose、fix、implement、auto、task、多轮、sticky comment 与 Controller-owned GitHub write 路径。原有 input 名称、scalar outputs 和 schema-v1 `result-json` envelope 保持兼容。v0.5.1 是 runtime 兼容、架构整理与稳定性版本；不加入 Session/Resume、Label/Assignee trigger、custom trigger phrase、branch template、Agent Teams、GitHub App/installer 或其它产品扩张。

## 运行进度与结构化输出

当一次获准的只读操作能够对应到 PR 或 Issue 时，controller 会在准备受限上下文、运行 DSH 和发布结果期间更新一条 sticky comment。写请求在全部最终 Controller validation command 成功前不会发布任何 lifecycle/status comment；通过 gate 并完成受控写入后，最终结果才可复用同一个 controller-owned v1 marker，因此不会额外制造一条“进度评论”：

| 操作                | 复用的 sticky marker |
| ------------------- | -------------------- |
| `task`              | `task`               |
| `review`            | `summary`            |
| `diagnose`          | `diagnosis`          |
| `fix` / `implement` | `write`              |

成功时，详细 review、诊断或通过 validation 的写入结果会替换同一条评论。只读失败可以在这里显示稳定错误码、阶段、经过脱敏和限长的消息与下一步。若获准的 `@dsh task --write` 最终没有 repository change，Controller 不会 commit、更新 ref、创建 PR 或 Release，但仍会把 final answer 正常发布到已解析的 Issue/PR，并把 no-change 结果写入 outputs 与 step summary。被阻止的请求，或在最终 validation 前/期间失败的写请求，仍只产生 outputs 与 step summary。只有预期 numeric bot ID 发布的 marker 才会被更新，用户伪造的 marker 不会被接管。适用的生命周期评论更新是 best effort：GitHub 评论 API 暂时不可用不会遮蔽 agent、validation 或写入的真实结果。

收到 `SIGTERM` 或 `SIGINT` 时，v0.5.1 会中止活跃 worker，并在 run-scoped cleanup 进行的同时立即启动一次有时间上限的 best-effort 终态更新。若随后发现权威的非取消失败，它可以纠正 provisional cancellation；终态保护也会阻止排队中的“In progress”反向覆盖结果。强制 `SIGKILL`、runner/host 丢失、进程崩溃，或 network/GitHub API 中断都可能让全部收尾代码无法运行，因此 sticky comment 仍可能停留在“In progress”。workflow concurrency 仍然重要；排查时应以 Actions conclusion 为准，不能把陈旧评论当成任务仍在运行的证明。

`progress-comment` 默认是 `true`。如果不希望显示中间状态，可以关闭：

```yaml
with:
  progress-comment: "false"
```

关闭它只会禁用 lifecycle 更新，不会关闭正常的 review 行内评论、review summary、CI diagnosis 或 fix 最终状态发布。

建议让 job 的 `timeout-minutes` 比 Action 的同名输入多留几分钟；这样 DSH 内部 watchdog 能先结束 worker，并有时间写完失败 outputs、step summary 和适用的只读 sticky comment。runtime 创建/安装、extension 安装、每个 Agent turn 与 validation 实际得到的是自身上限与总执行 deadline 剩余时间中的较小值，因此 setup 不会悄悄吃完整个任务预算。cleanup 与取消评论收尾则在 outcome 或 deadline 后各自获得固定、很短的 best-effort grace：它们不会无限阻塞，但可能让实际 wall-clock 比配置的执行 deadline 略长。

Action 在 success、neutral 和 failure 路径都会设置 `result-json`。这是带 `schemaVersion: 1` 的 JSON envelope，包含适用的 `status`、operation、summary、timing、policy/capabilities、permission audit、有效 extension audit、限长 tool receipts、实际 isolation report、publication 统计、controller validation 与 validation-integrity audit、write 结果、sticky comment ID 和 error。`status` 可能是 `success`、`neutral`、`failed`、`timed_out`、`validation_failed` 或 `denied`；`validation_failed` 同时覆盖无效的 DSH structured output 和 controller validation 失败，具体由 `error.code` 区分。失败对象包含稳定的 `code`、`phase`、`title`、`message`、`guidance` 和 `retryable`。

所有标量 outputs 如下：

| Output                     | 含义                                                                                |
| -------------------------- | ----------------------------------------------------------------------------------- |
| `conclusion`               | `success`、`neutral` 或 `failure`                                                   |
| `operation`                | `task`、`review`、`diagnose`、`fix`、`implement` 或 `none`                          |
| `summary`                  | 任意操作的校验后摘要，失败时为安全的失败摘要                                        |
| `review-summary`           | `summary` 的向后兼容别名                                                            |
| `findings-count`           | review 中选中的 finding 数；其他操作中为已校验的 agent finding 数                   |
| `branch-name`              | 创建的 DSH 分支（不适用时为空）                                                     |
| `pull-request-url`         | 创建的 PR URL（不适用时为空）                                                       |
| `commit-sha`               | 成功 fix 创建的 commit（不适用时为空）                                              |
| `trust`                    | `untrusted`、`trusted-read`、`trusted-write` 或尚未解析时的 `none`                  |
| `permission-profile`       | 已解析的 `strict`、`standard`、`custom` 或 `none` Agent 权限 preset                 |
| `effective-tools`          | 经过 preset、deny、trust 与 policy 检查后剩余精确工具的 JSON 数组                   |
| `network-access`           | 有效 worker path：`host-gateway`、`mediated-web`、`bridge`，权限尚未解析时为 `none` |
| `workspace-write`          | 有效 Agent 工具能否修改 disposable workspace                                        |
| `trusted-extensions`       | Controller 批准的 MCP、Bundle 与 Plugin owner 的 JSON 数组                          |
| `duration-ms`              | controller 总耗时，毫秒                                                             |
| `comment-id`               | 可用时的 sticky progress/result comment ID                                          |
| `error-code`               | 稳定失败码；成功和 neutral 时为空                                                   |
| `error-message`            | 脱敏且限长的失败信息                                                                |
| `extension-profile-digest` | 脱敏后有效 Profile audit 的 SHA-256 digest；不可用时为空                            |
| `tool-receipts`            | 含限长 `controller`/`dsh` 数组及截断元数据的 JSON object                            |
| `result-json`              | 上述 versioned JSON envelope                                                        |

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

`result-json` 中的 summary、路径和其他模型派生字符串仍然是不可信数据；这个 envelope、invocation-count state 与 receipts 都只是 telemetry，不是授权依据或防篡改安全日志。获准 extension code 与 worker 共享进程/文件系统，因此可以影响这些 telemetry；不要把输出字符串直接插入 shell 命令，也不要把它们当作独立证明。

## 写模式

`allow-write` 默认是 `false`。所有代码、Git ref、pull request 和写任务评论变更都要求 `run-tests: "true"`、至少一个 `test-commands` argv 数组，并且每条 validation command 成功。`run-tests: "false"` 会拒绝变更，不再是 waiver；这是 v0.4 有意引入的 breaking security hardening。在该 gate 成功或 actual-change inspection 确认 task 无变更之前，写请求不会产生 GitHub comment、commit、ref update 或 pull request；no-change task 只能发布 final answer。repository mutation 仍只对同仓库、受信任操作者开放；fork PR 始终是 review-only。测试命令使用 argv 数组，不经过 shell 展开：

```yaml
with:
  allow-write: "true"
  permission-profile: standard
  run-tests: "true"
  validation-integrity: strict
  test-commands: '[["npm","ci","--ignore-scripts"],["npm","test"],["npm","run","typecheck"]]'
  container-image: docker.io/library/node:24.18.0-bookworm@sha256:5711a0d445a1af54af9589066c646df387d1831a608226f4cd694fc59e745059
```

写模式和任何有效 extension 都要求使用完整的 Docker image digest。所有 image 值（包括允许 tag 的只读兼容路径）都必须是单一 Docker/OCI reference，不能以 option 开头或包含可拆分参数的空白；image 本身属于 trusted worker code。Docker 需要在 runner 上可用。

### Validation 定义完整性

Controller 会单独识别能够重新定义“validation 通过”含义的变更，包括 package scripts、test source/config、lint、typecheck、build config 和其它 validation entrypoint。这不会禁止代码与测试一起正常修改。

- `off`：记录并报告 validation-definition changes，但不阻止。
- `warn`：默认模式；报告变化类别与可疑的削弱信号。
- `strict`：阻止高置信度的削弱（包括 audit 截断）；若 control-plane definition 有变化但没有明显削弱信号，则保留候选代码/测试并恢复基线 validation definitions，再执行配置好的 validation。

该模式属于受信任 workflow 配置，仓库内容与模型都不能降低它。Controller 会在考虑任何 GitHub mutation 前把 audit 与处置结果写入 `result-json` 和 step summary。

## 安全

安全模型分成四层，避免把“操作者可信”和“仓库内容可信”混为一谈：

1. **Actor / control plane**：交互式 `@dsh` 命令要求所有来源 actor 都通过 write/maintain/admin 检查；写操作还必须显式设置 `allow-write: "true"` 并通过强制 validation。`permission-profile`、精确 allow/deny 列表、`validation-integrity`、`container-image`、凭据路由 URL、`isolation`、`dsh-executable` 等 capability-bearing inputs 只能来自受信任 workflow 配置。workflow token scopes 只决定 controller 能调用哪些 GitHub API，不能绕过 actor 或 policy gate。
2. **输入数据**：仓库文件、diff、CI 日志、README/AGENTS/CLAUDE、Issue、PR 和评论始终是不可信数据。模型输出也不直接获得权力，必须通过严格 schema、路径、大小和 marker 校验。
3. **Worker**：`untrusted`、`trusted-read`、`trusted-write` 是 trust profile；`strict`、`standard`、`custom` 是独立的 Agent permission 维度。fork 没有仓库工具。受信任的 standard/custom worker 可以在无凭据 Docker 边界内开放经过审计的 native tools，但绝不直接访问 GitHub。
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

progress comment 使用与最终结果评论相同的权限，不新增 scope。`GITHUB_TOKEN` 只留在 controller；DeepSeek key 由 controller 侧代理注入，两者都不会进入 DSH prompt、workspace、MCP/Plugin 配置、worker argv/environment 或 validation 命令。输入与启动前检查会拒绝误插入的凭据，且不会在错误中回显。完整信任边界、已知限制和漏洞报告方式见 [`SECURITY.md`](SECURITY.md)。v0.5.1 只接受经过审计的 `@deepseek-ai/dsh@0.1.1-rc.2` package family 与提交的 exact lock；其他版本必须重新审查对应 policy/profile。

## 架构

```text
GitHub event
    ↓
Action controller: route → authorize → compile permission profile + exact allow/deny
    ↓
只读操作的 Controller-owned sticky progress → bounded workspace / context
    ↓
Fresh DSH turn in Docker
    ├─ DSH native / official MCP / Plugin tool → positive Action policy → receipt
    ├─ needs_tool → controller fixed-argv tool ──────────────────────────┐
    └─ final → validation + validation-integrity failure ────────────────┤ bounded untrusted feedback
                                                                         └→ next DSH turn (max-turns/deadline)
    ↓
Action controller: final schema + gates → answer / commit / branch + PR
                                      （写任务评论只会从这里开始）
    ↓
Action outputs: legacy scalars + versioned result-json
```

DSH worker 不持有 GitHub client。模型输出通过 schema 校验后，才由 controller 映射到 diff 行或调用已授权工具。只读 tracking comment 始终由 Controller 控制；写任务评论和所有受信任写入还必须等待最终仓库 validation 成功。受控 Profile 只会在 Controller 校验后由受信任 workflow inputs 生成；仓库内容和模型输出不能修改 MCP/Bundle/Plugin 集合。

v0.5.1 保持上述外部流程，同时把 runtime 安装与 inventory audit、进程启动、Docker/network policy、Profile setup、receipt reconciliation、timeout 和 cleanup 拆成严格 run-scoped 的职责。Validation Integrity 也会先构建 normalized command graph，再规划 baseline replay。receipt 收集从上次 byte offset 继续，并使用 set-based reconciliation，避免每轮重扫完整文件，同时不改变公开 output 格式。

## 核心发布 E2E

永久 [Core E2E workflow](.github/workflows/e2e.yml) 必须先经过审查并单独合入默认分支，成为可信 harness。维护者随后从默认分支 dispatch，并提供完整 candidate SHA 与对应的 open、非 draft、same-repository PR 编号，同时把 `DSH_E2E_CANDIDATE_SHA` 设为完全相同的 SHA。gate 不读取任何 secret：它要求触发 actor 具有 write 权限，绑定 PR head 与默认 base，并验证 dispatch/workflow SHA 等于实时默认分支 SHA。read-only、write 与 cancellation 三个 job 全部绑定受保护的 `core-e2e` environment；写入 `DEEPSEEK_API_KEY` 前，应把该 environment 配置为只允许默认分支。

harness 文件与 fixture 固定 checkout gate 输出的不可变默认分支 SHA；candidate Action code 只按独立绑定的 candidate SHA checkout，且所有 checkout 都使用 `persist-credentials: false`。no-mutation 路径会比较默认分支状态、完整 candidate identity/comments、每个 `dsh/task-*` ref 的 object type/SHA，以及 Controller task PR 的 state/draft/head/base/body。取消路径创建带 run/attempt/candidate marker 的临时 Issue，锁定唯一 bot comment ID 并验证它从 in-progress 转为 cancelled，随后严格删除该 comment 并关闭 Issue；不会复用或覆盖 candidate PR sticky comment。

## Release canary

轻量 [release canary](.github/workflows/release-canary.yml) 每周或手动运行，只使用 `contents: read`、一个 `strict` 只读 task，不设置矩阵或 mutation scope。其无 secret gate 要求 workflow ref 为 `refs/heads/main`，并要求 run/workflow SHA 等于实时默认分支 SHA；读取 secret 的 smoke job 与 Core E2E 一样绑定受保护、仅允许 main 的 `core-e2e` environment。发布维护者需要把 repository variable `DSH_RELEASE_CANARY_SHA` 设为小写、完整 40 字符的 commit SHA；它必须同时是正式 v0.5.1 Tag 与 GitHub Release 指向的 commit，并提供 `DEEPSEEK_API_KEY`。workflow 会先验证 Tag、非 draft/非 prerelease 的正式 Release 与该变量都解析到同一不可变 commit，再 checkout 并以本地 Action 运行。

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

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供本项目使用的 headless runtime、MCP client、Bundle/Profile 加载与 Cordis 配置。
- GitHub 事件路由、权限检查和 tracking 机制基于 [Claude Code Action](https://github.com/anthropics/claude-code-action) 的 MIT 实现适配。对应上游 commit 和许可文本记录在 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。
- Structured output 和执行/发布权限分离的设计也参考了 [Codex GitHub Action](https://learn.chatgpt.com/docs/github-action)；本项目仍保留自己的 controller/worker 信任边界与输出协议。
