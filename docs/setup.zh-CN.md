# 安装与接入

[English](setup.md) · [项目首页](../README.zh-CN.md) · [使用指南](usage.zh-CN.md) · [配置参考](configuration.md)

本指南从安装开始，带你建立第一个安全 workflow。建议先启用只读 PR 审查；只有仓库确实需要时，再加入命令或写模式。

## 快速开始：安装器

在需要接入的仓库根目录运行：

```bash
npm create deepseek-harness-action@latest
```

选择要安装的内容：

| 选择                     | 创建的文件                           |
| ------------------------ | ------------------------------------ |
| **PR Review**            | `.github/workflows/dsh-review.yml`   |
| **@dsh Coding Commands** | `.github/workflows/dsh-commands.yml` |
| **Both**                 | 以上两个 workflow 文件               |

在 CI 或其它非交互环境中，必须显式传入 mode，安装器不会等待 stdin：

```bash
npm create deepseek-harness-action@latest -- --mode both
```

非交互使用时，省略 `--dsh-mode` 会保持兼容的 `controlled` 默认值。交互流程
会明确询问；除非确实需要 native composition，否则请选择 Controlled：

```bash
npm create deepseek-harness-action@latest -- --mode both --dsh-mode native
```

安装器会按需创建 `.github/workflows/`，如果目标 workflow 已存在则拒绝覆盖。
它不会添加 `DEEPSEEK_API_KEY`、commit 或 push 改动，也不会创建 PR。安装器
v0.2.0 只在正式 v0.8.0 Tag、GitHub Release 与 release canary 身份一致后
构建；生成的 workflow 固定到不可变 commit
`86fff4c4527694c7eefdc65c6cf7a633b5ea8cb1`，不会使用 candidate SHA、浮动 Tag
或分支。

安装成功后：

1. 在 **Settings → Secrets and variables → Actions** 中添加 `DEEPSEEK_API_KEY`。
2. 使用 Review 时，打开或更新一个非 draft PR。
3. 使用 Coding Commands 时，把 `@dsh` 命令写在 Issue 或 PR 评论的第一行。请求写入前，必须把 validation command 占位符替换为适合你项目的命令。
4. 继续阅读本文的安全说明，并通过[使用指南](usage.zh-CN.md)了解所有受支持的命令。

本地只在运行安装器时需要 Node.js 和 npm；生成的 workflow 不会假定目标仓库是 Node.js 项目。

## 手工安装

如果希望自己创建 workflow，请按以下步骤操作。

### 准备条件

- 你能在目标 GitHub 仓库中添加 Actions Secret 和 workflow。
- 一个 DeepSeek API key。
- GitHub 托管的 Ubuntu runner，或已经安装 Docker 的自托管 runner。
- 只有开发这个 Action 本身时才需要 Node.js 24；手工安装的 workflow 不需要单独安装 Node.js。

处理不可信 PR 数据、执行任何写入，以及使用任何 MCP、Bundle 或 Plugin 扩展时，都必须使用 Docker。可选的 host 执行路径没有操作系统隔离，只适合专用的受信任 runner。

### 1. 添加 API key

打开 **Settings → Secrets and variables → Actions → New repository secret**，创建：

```text
DEEPSEEK_API_KEY
```

只把它传给 `deepseek-api-key` 输入。不要通过 `env`、prompt、验证命令、MCP 配置或 Plugin 配置暴露它。Action 会把真实 key 留在 Controller 侧代理中，DSH worker 只会拿到临时代理令牌。

默认的 `github-token` 是 `${{ github.token }}`，也只由 Controller 使用。请禁用 checkout 凭据，避免仓库代码或 worker 继承 Git 凭据。

### 2. 选择 Action 版本

为了便于阅读，示例使用当前发布 Tag：

```yaml
uses: Lixiaoyiao/deepseek-harness-action@v0.8.0
```

生产环境应把 Tag 替换为该版本发布时的完整、不可变 commit SHA。正式
v0.8.0 commit 是：

```yaml
uses: Lixiaoyiao/deepseek-harness-action@86fff4c4527694c7eefdc65c6cf7a633b5ea8cb1
```

不要使用 `main`、`latest`、版本范围、candidate SHA 或其它浮动 ref。
`dsh-version` 必须保持为本版本审计过的精确值：

```yaml
with:
  dsh-version: 0.1.1-rc.2
```

只有新的 DSH package family、Profile 和工具面完成复核并随新版本发布后，Action 才会接受不同版本。

### 3. 添加安全的自动 PR 审查

创建 `.github/workflows/dsh-review.yml`：

```yaml
name: DSH review

on:
  pull_request_target:
    types: [opened, synchronize, ready_for_review, reopened]

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: dsh-review-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  review:
    if: github.event.pull_request.draft == false
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - name: Checkout trusted base only
        uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
        with:
          ref: ${{ github.event.pull_request.base.sha }}
          persist-credentials: false
          fetch-depth: 1
      - uses: Lixiaoyiao/deepseek-harness-action@v0.8.0
        with:
          deepseek-api-key: ${{ secrets.DEEPSEEK_API_KEY }}
          dsh-version: 0.1.1-rc.2
```

`pull_request_target` 可以访问 Secret 和权限较高的 token，因此这个 workflow 只检出不可变、受信任的 base SHA。Action 通过 GitHub API 获取 PR diff 和变更文件上下文，不会检出或运行 fork revision。请保留 `persist-credentials: false`。

打开一个非 draft PR，检查 Actions 运行、审查汇总和行内问题。完整且持续维护的模板见 [`examples/fork-review.yml`](../examples/fork-review.yml)。

### 4. 只授予入口真正需要的 GitHub 权限

Agent 权限档位不会授予 GitHub 权限。workflow token scope 只决定受信任 Controller 可以调用哪些 API。

| 场景                              | Workflow 权限                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------- |
| 自动或 fork PR 审查               | `contents: read`、`pull-requests: write`                                                    |
| 不需要 Issue/PR 评论的只读 task   | `contents: read`                                                                            |
| 需要 Issue/PR 结果评论的只读 task | `contents: read`，再增加对应的 `issues: write` 或 `pull-requests: write`                    |
| CI 诊断                           | `actions: read`、`checks: read`、`contents: read`、`issues: write`、`pull-requests: write`  |
| 允许 fix 或 implement 的命令      | `actions: read`、`checks: read`、`contents: write`、`issues: write`、`pull-requests: write` |
| CI 自动修复                       | 与上一行相同                                                                                |
| 创建分支和 PR 的自动化任务        | `contents: write`、`pull-requests: write`                                                   |
| 选中的 typed GitHub Tools         | 只增加对应的 `issues`、`pull-requests`、`checks` 或 `statuses` 读写 scope                   |

较宽的 workflow token 不能绕过 actor、事件、来源、SHA、受保护路径、验证或 Controller 策略。反过来，缺少必要 scope 也会让本来获准的结果无法发布。

### 5. 添加命令、CI 或自动化流程

按使用场景复制模板：

- [`examples/commands.yml`](../examples/commands.yml)：`@dsh` task、review、diagnose、fix 和 Issue 实现。
- [`examples/ci-diagnose.yml`](../examples/ci-diagnose.yml)：诊断失败的 CI，不修改代码。
- [`examples/ci-auto-fix.yml`](../examples/ci-auto-fix.yml)：带强制验证的受信任 CI 修复。
- [`examples/task-automation.yml`](../examples/task-automation.yml)：由维护者发起、可选只读或写入的 dispatch task。
- [`examples/github-integration.yml`](../examples/github-integration.yml)：自定义路由、安全分支命名、typed GitHub Tools 与结构化 task output。
- [`examples/controlled-extensions.yml`](../examples/controlled-extensions.yml)：高级 custom Profile、MCP 和 Bundle 配置。

对于 `issue_comment`、`workflow_run`、dispatch 和 schedule workflow，应从受信任的默认分支运行 workflow 定义。检出已经绑定的受信任分支或 SHA，始终设置 `persist-credentials: false`，并确保带权限含义的输入只使用字面值，或只从受信任 workflow 配置推导。

`prompt`、trigger/filter、branch、schema 与 tool inputs 都属于受信任的维护者配置。不要把 Issue 正文、PR 内容、评论、日志、仓库文件或模型输出插入其中。GitHub 会在 Action 启动前解析表达式，Action 无法恢复这些值原来的来源。

### 6. 谨慎启用写模式

写命令本身不会授权变更。有效的写 workflow 还必须通过 actor、事件、同仓库、分支、SHA、workspace 和工具策略检查，并配置由 Controller 执行的验证。启用写模式前，必须把下面的每个占位符替换为适合你项目的命令和固定到 digest 的容器镜像；这里特意不提供 npm 默认值：

```yaml
with:
  permission-profile: standard
  allow-write: "true"
  run-tests: "true"
  validation-integrity: strict
  test-commands: >-
    [
      ["REPLACE_WITH_YOUR_PROJECT_INSTALL_COMMAND"],
      ["REPLACE_WITH_YOUR_PROJECT_TEST_COMMAND"]
    ]
  container-image: REPLACE_WITH_YOUR_PROJECT_IMAGE@sha256:REPLACE_WITH_FULL_DIGEST
```

每条 validation command 都是固定 argv 数组，不会经过 shell 展开；每个参数都要写成独立字符串，并且所有命令都必须成功。占位符在替换前会安全失败。`run-tests: "false"` 会拒绝写入，不是跳过验证的开关。

Docker image 本身就是可执行的 worker code。写入和扩展必须使用完整 digest，不能只固定 Tag。启用前请阅读[写模式与验证](configuration.md#write-validation-and-integrity)。

### Checkout、超时与并发规则

- 固定每个 `actions/checkout` 版本，并设置 `persist-credentials: false`。
- 使用 `pull_request_target` 时，只检出 `github.event.pull_request.base.sha`，绝不运行 fork checkout。
- 按 PR、Issue、上游 run 或自动化目标设置 concurrency group。sticky marker 不包含 run/head 新鲜度信息，因此必须串行化，避免旧运行覆盖新状态。
- job 的 `timeout-minutes` 应比 Action 的同名输入多留几分钟，让 Action 有一个短且有上限的窗口停止 worker、写入 outputs，并尝试发布适用的取消状态。
- runner 被强制终止时可能完全跳过 cleanup。应以 Actions conclusion 为准，详见[评论一直显示 In progress](troubleshooting.md#cancellation-or-a-sticky-comment-remains-in-progress)。

### 验证接入结果

第一次运行后，确认：

1. Checkout 显示 `persist-credentials: false`，且检出的是预期受信任 SHA。
2. Action 把 `dsh-version` 解析为 `0.1.1-rc.2`。
3. 只读审查没有 workspace 写能力。
4. 只出现预期的 Controller-owned 汇总评论和行内问题。
5. step summary 与 `result-json` 中的 operation、权限档位、有效工具和网络路径符合预期。

接下来可阅读[使用指南](usage.zh-CN.md)了解命令，阅读[配置参考](configuration.md)了解全部输入、权限边界和输出。
