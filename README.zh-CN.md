# DeepSeek Harness for GitHub

[![CI](https://github.com/Lixiaoyiao/deepseek-harness-action/actions/workflows/ci.yml/badge.svg)](https://github.com/Lixiaoyiao/deepseek-harness-action/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Lixiaoyiao/deepseek-harness-action?display_name=tag)](https://github.com/Lixiaoyiao/deepseek-harness-action/releases/latest)
[![MIT](https://img.shields.io/github/license/Lixiaoyiao/deepseek-harness-action)](LICENSE)

[English](README.md)

让 GitHub 里的 PR、Issue、失败 CI 和维护者编写的自动化流程直接调用 DeepSeek Harness。

```text
GitHub PR / Issue / CI  →  DeepSeek Harness  →  Review / Diagnose / Fix / Issue → PR
```

Action 会启动与凭据隔离的 DSH worker，校验结构化结果，再由受信任的 Controller 发布评论或经过验证的改动。这是社区项目，并非 DeepSeek 或 GitHub 官方产品，由 [@Lixiaoyiao](https://github.com/Lixiaoyiao) 维护。

## 核心能力

| 能力          | 作用                                                                            |
| ------------- | ------------------------------------------------------------------------------- |
| PR 审查       | 审查新提交，发布一条汇总，并为高置信度问题添加行内评论                          |
| 通用任务      | 回答仓库问题，或执行经过明确授权的编码任务                                      |
| CI 诊断与修复 | 读取失败的检查和日志；受信任 workflow 可以验证并发布修复                        |
| Issue 实现    | 把经过授权的 Issue 请求实现为已验证的分支和 PR                                  |
| 受控工具      | 以精确工具档位提供原生、固定命令、Controller GitHub、MCP、Bundle 与 Plugin 工具 |
| 结构化结果    | 保留 schema-v1 审计信封，并可校验维护者定义的可选 task 结果                     |

v0.6.0 新增维护者控制的触发器、actor/comment 过滤、安全分支配置、Controller-owned typed GitHub Tools，以及可选的结构化 task output；默认行为和 authority 不变。由于精确审计的 DSH headless 契约仍只支持文本，GitHub 图片附件明确 defer；DSH pin 仍为 `0.1.1-rc.2`。

## 真实运行

以下是本仓库的公开运行记录，可以直接查看评论和 Actions 日志。

| 场景                            | 运行记录                                                                                                                                                              |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR 审查，以及复跑时不重复发评论 | [PR #3](https://github.com/Lixiaoyiao/deepseek-harness-action/pull/3) · [Actions run](https://github.com/Lixiaoyiao/deepseek-harness-action/actions/runs/31760570162) |
| 根据失败的检查和日志进行诊断    | [Actions run](https://github.com/Lixiaoyiao/deepseek-harness-action/actions/runs/31760603284)                                                                         |
| 在受信任写模式下修复并验证      | [Actions run](https://github.com/Lixiaoyiao/deepseek-harness-action/actions/runs/31761793492)                                                                         |
| 实现 Issue 后创建 PR            | [Issue #4](https://github.com/Lixiaoyiao/deepseek-harness-action/issues/4) → [PR #5](https://github.com/Lixiaoyiao/deepseek-harness-action/pull/5)                    |

## 快速开始

在需要接入的仓库根目录运行安装器：

```bash
npm create deepseek-harness-action@latest
```

选择一种模式：

- **PR Review** 创建 `.github/workflows/dsh-review.yml`。
- **@dsh Coding Commands** 创建 `.github/workflows/dsh-commands.yml`。
- **Both** 创建以上两个 workflow 文件。

在 CI 或其它非交互环境中，必须显式传入 mode，安装器不会等待 stdin：

```bash
npm create deepseek-harness-action@latest -- --mode both
```

安装器会按需创建 `.github/workflows/`，如果目标 workflow 已存在则拒绝覆盖。它不会添加 Secret、commit 或 push 改动，也不会创建 PR。生成的 workflow 会把 Action 固定到 v0.5.2 的不可变 release commit。

安装完成后，在 **Settings → Secrets and variables → Actions** 中添加 `DEEPSEEK_API_KEY`。打开或更新一个非 draft PR 即可触发 Review；使用 Coding Commands 时，把 `@dsh` 命令写在 Issue 或 PR 评论的第一行。完整 onboarding 与安全说明见[安装指南](docs/setup.zh-CN.md)。

### 手工安装

先在仓库的 **Settings → Secrets and variables → Actions** 中添加 `DEEPSEEK_API_KEY`，再创建 `.github/workflows/dsh-review.yml`：

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
      - uses: Lixiaoyiao/deepseek-harness-action@v0.6.0
        with:
          deepseek-api-key: ${{ secrets.DEEPSEEK_API_KEY }}
          dsh-version: 0.1.1-rc.2
```

打开一个非 draft PR。Action 只会检出受信任的 base SHA，通过 GitHub API 读取 PR，并且不会运行 fork 中的代码。

生产环境应把 `v0.6.0` 替换为该版本发布时的完整、不可变 commit SHA。权限、版本固定、安全检出规则和完整模板见[安装指南](docs/setup.zh-CN.md)。

## 常用 `@dsh` 命令

命令必须写在 Issue 或 PR 评论的第一行。

| 命令                       | 用途                               |
| -------------------------- | ---------------------------------- |
| `@dsh task --read <问题>`  | 解释代码、检查仓库或回答通用问题   |
| `@dsh task --write <任务>` | 请求编码任务；所有写入关卡仍须通过 |
| `@dsh review`              | 重新审查当前 PR                    |
| `@dsh diagnose`            | 诊断失败的检查和日志               |
| `@dsh fix`                 | 在受信任写模式下修复同仓库 PR      |
| `@dsh implement`           | 实现 Issue 并创建 PR               |

`--write`、`fix` 和 `implement` 只是请求能力，并不授予权限。workflow 必须显式启用写模式，并提供由 Controller 执行的验证命令。命令和自动化用法见[使用指南](docs/usage.zh-CN.md)，完整关卡见[配置参考](docs/configuration.md)。

维护者可以修改 trigger phrase，添加 label/assignee 路由，过滤 actor 或历史评论，选择 base branch，并配置确定性 branch template。这些设置只改变路由和命名；GitHub authority 仍由 Controller policy 与 workflow token scope 决定。

## 安全边界

- Agent 不会拿到真实的 `GITHUB_TOKEN` 或 DeepSeek key。只有 Controller 能调用 GitHub 写入 API。
- 仓库内容、diff、Issue、PR、评论、日志、模型输出和工具输出始终是不可信数据。
- fork 审查使用没有 `.git`、没有凭据的 worker；workflow 只能检出受信任的 base SHA，并设置 `persist-credentials: false`。
- 写入需要受信任的同仓库上下文、通过授权检查的操作者、Docker、`allow-write: "true"`、非空固定验证命令，以及全部验证成功；受保护路径和 Validation Integrity 检查仍然有效。
- Typed `github.*` mutation 使用精确 ID、绑定当前 entity，并延迟到 Controller 验证成功后执行，同时保留有界 receipts 与 reconciliation；不存在 arbitrary REST、GraphQL、raw URL 或凭据透传。
- Validation Integrity 针对已支持的 entrypoint、package script、test/config 变弱、lock/toolchain 控制和已知 wrapper/interpreter 提供高置信度变弱检测与 baseline replay；它不是完整的跨语言 dependency provenance 或形式化完整性证明。
- Validation 可能使用 Docker bridge network。在 self-hosted runner 或企业网络中，仓库验证代码可能访问 runner 可达的网络服务；应使用专用 runner 以及 runner 级网络分段和出口控制。
- 获准的 Bundle、Plugin 或 stdio MCP server 属于受信任的 worker code。ToolRuntime 只能限制模型路由的调用，不能沙箱化扩展启动、后台任务或直接进程 I/O。

启用写模式、host 执行、网络访问或第三方扩展前，请完整阅读[安全策略](SECURITY.md)。

## 文档

| 指南                                                       | 内容                                                                 |
| ---------------------------------------------------------- | -------------------------------------------------------------------- |
| [安装指南](docs/setup.zh-CN.md) · [English](docs/setup.md) | 安装器、手工安装、Secret、权限、安全检出和模板                       |
| [使用指南](docs/usage.zh-CN.md) · [English](docs/usage.md) | `@dsh` 命令、task、review、diagnose、fix、implement 和自动化         |
| [配置参考](docs/configuration.md)                          | 输入、权限档位、工具、验证、扩展和输出                               |
| [故障排查](docs/troubleshooting.md)                        | 权限拒绝、Docker、超时、取消、验证和扩展故障                         |
| [安全策略](SECURITY.md)                                    | 信任模型、凭据边界、网络行为和已知限制                               |
| [扩展契约](docs/extension-contracts.md)                    | MCP、Profile、Bundle、Plugin、ToolRuntime 和 receipts 的深层技术约束 |
| [维护者发布指南](docs/maintainer-release.md)               | 本地检查、核心 E2E、release canary、版本更新和发布                   |
| [贡献指南](CONTRIBUTING.md) · [更新记录](CHANGELOG.md)     | 开发流程和版本历史                                                   |

## 开发

需要 Node.js 24。

```bash
npm ci
npm run check
```

具体流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。用于 GitHub Marketplace 的 `dist/` 会随版本提交，请勿手工修改。

## 许可证

本项目采用 [MIT](LICENSE) 许可证。第三方许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 和 [BUNDLED_DEPENDENCIES.md](BUNDLED_DEPENDENCIES.md)。

DeepSeek Harness 提供 headless runtime 和官方扩展机制。GitHub 集成还参考了采用 MIT 许可证的 [Claude Code Action](https://github.com/anthropics/claude-code-action) 模式，以及 [Codex GitHub Action](https://learn.chatgpt.com/docs/github-action) 对执行权限和发布权限的分离方式；准确的来源说明记录在第三方许可文件中。
