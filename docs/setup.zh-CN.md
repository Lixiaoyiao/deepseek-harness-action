# 安装与接入

[English](setup.md) · [项目首页](../README.zh-CN.md) · [使用指南](usage.zh-CN.md) · [配置参考](configuration.md)

本指南从安装开始，带你建立第一个安全 workflow。建议先启用只读 PR 审查；只有仓库确实需要时，再加入命令或写模式。

## 快速开始：安装器

在需要接入的现有 GitHub 仓库内运行：

```bash
npm create deepseek-harness-action@latest
```

终端中不传选项时，引导默认建立只读 PR Review。安装器找到 Git 根目录与
`github.com` origin，检查 `gh` 可用性和登录，再经确认创建
`.github/workflows/dsh-review.yml`。它不创建远端仓库或更改 remote。
引导要求已有 Git 仓库；还在准备仓库时可使用下方的手工文件生成方式。

`gh` 已登录时会核验仓库访问权限，只列出 Secret 名称。缺少
`DEEPSEEK_API_KEY` 时可确认通过隐藏输入设置，密钥仅经 `gh secret set` stdin
发送，不进入参数或日志。缺少登录时给出 `gh auth login --hostname github.com`；
手工完成登录后再次运行，或在 **Settings → Secrets and variables → Actions** 添加 Secret。

Commit 和 push 分别确认，均默认否。安装器用独立 index 只提交生成的 workflow，
保留其它改动和未跟踪文件；已有暂存改动时拒绝提交。它不执行仓库 hooks、filters、
验证脚本或签名程序，生成的是未签名 commit。仓库要求签名或 hooks 时请手工提交。
Push 要求唯一且经过核验的目的地址与远端父 commit，仅非 force 推送该确切 commit；
其它未发布或并发历史须手工协调。自动附带 Tag 只在该 push 命令中禁用，不修改
本地设置。Workflow 必须到达默认分支。

再次运行相同的无选项命令可恢复：内容完全相同的 workflow 会被保留，已修改文件
须手工审查。登录与 Secret 名称会重新检查；仅包含 workflow 的 commit 被复用，
已经发布的 commit 不会重复推送。Secret 请求失败或状态不确定时会给出恢复说明，
不会打印进程输出；再次尝试前应检查 Secret 名称和权限。

内置 starter 检查覆盖不可变 Action 引用、只读 worker 和受信 base checkout。
凭据、Actions 权限/配额、Docker/镜像与实际审查仍须通过首个 Action 运行验证。

通过 `--advanced` 显式进入 workflow 与 controlled/native 交互选择：

```bash
npm create deepseek-harness-action@latest -- --advanced
```

高级/手工流程提供：

| 选择                     | 创建的文件                           |
| ------------------------ | ------------------------------------ |
| **PR Review**            | `.github/workflows/dsh-review.yml`   |
| **@dsh Coding Commands** | `.github/workflows/dsh-commands.yml` |
| **Both**                 | 以上两个 workflow 文件               |
| **Automatic Session**    | `.github/workflows/dsh-session.yml`  |

高级流程和显式选项仅生成文件，不设置 Secret、commit、push 或创建 PR。
在 CI 或其它非交互环境中必须显式传入 mode；缺少 `--mode` 会直接失败，不读取 stdin：

```bash
npm create deepseek-harness-action@latest -- --mode both
```

显式 `--mode` 在终端中也保持手工生成；省略 `--dsh-mode` 默认 `controlled`，
不会询问 composition。需要 native 时明确指定：

```bash
npm create deepseek-harness-action@latest -- --mode both --dsh-mode native
```

Automatic Session 生成只读 starter，绑定相同的 key/run-name/concurrency，并以
`queue: max` 保留排队请求。提交到默认分支后，从默认分支 dispatch；为逻辑任务
选择小写 key，后续用同 key 和新 prompt 续接，无需 source run ID。
失败、过期、损坏或状态不明的历史须先协调解决。

```bash
npm create deepseek-harness-action@latest -- --mode session
```

安装器 `0.7.0` 面向正式 Action `v0.10.3`，两种 composition 都保持精确
DSH `0.2.1-rc.2`。只有 Action Tag、
GitHub Release 和 canary 身份一致后，打包才通过 `DSH_ACTION_RELEASE_SHA`
接收核验出的完整 commit。独立审查的安装器源码使用
`create-deepseek-harness-action-v0.7.0` Tag。源码模板保留受控 build token，
生成的 workflow 不包含该 token、candidate SHA、浮动 Tag 或分支。
源码 commit 不能提供自身尚未确定的未来身份。

安装成功后：

1. 引导未配置时，在 **Settings → Secrets and variables → Actions** 中添加 `DEEPSEEK_API_KEY`。
2. 把 workflow commit/push 到默认分支；使用 Review 时，打开或更新非 draft PR。
3. 使用 Coding Commands 时，把 `@dsh` 命令写在 Issue 或 PR 评论的第一行。请求写入前，必须把 validation command 占位符替换为适合你项目的命令。
4. 继续阅读本文的安全说明，并通过[使用指南](usage.zh-CN.md)了解所有受支持的命令。

本地只在运行安装器时需要 Node.js 和 npm；生成的 workflow 不会假定目标仓库是 Node.js 项目。

## 首次启动模型前检查配置

在经过审核的 Action 源码 checkout 中，用 Node.js 24 和已安装的锁定依赖，
复制 [`examples/config-check.json`](../examples/config-check.json)，把 `inputs`
改为 workflow 中的字面量输入名和值。凭据不要写进 JSON；`credentialEnv`
只指定保存 Controller 凭据的环境变量名称。

```bash
npm run check:config -- --config examples/config-check.json
```

检查器只读取明确选择的 JSON 文件（普通 UTF-8 文件，最多 256 KiB），复用
Action 的公开输入和扩展 schema，检查缺少凭据、DSH 精确版本、模式与隔离、
明确写任务的验证配置。它不启动模型、不执行仓库代码或验证命令、不联网、
不修改远端状态。JSON 输出的 `scope` 是 `static_configuration_only`；
`ok: true` 只表示静态配置通过。Docker/镜像可用性、凭据有效性、在线权限与
配额、当前事件/SHA 授权、文本文件内容和扩展激活都明确标记 `not_checked`。
允许写入的 `auto` 配置缺验证时只发警告，以保留只读路由；实际路由为写任务
时会在模型启动前拒绝。

实际运行时，凭据缺失、DSH 版本不支持或扩展格式错误在解析输入时失败。
明确或路由后的写任务会提前拒绝空验证、禁用测试和未替换的占位符；
有时间上限、无 Controller 凭据的 `docker info` 预检会在安装 runtime 前
报告 CLI/daemon 不可用。这些检查不授予权限，也不替代 Controller 的真实验证。

安装器 0.7.0 为 `commands` / `both` 提供显式 `--test-commands` JSON argv
和 `--container-image name@sha256:<64 位小写十六进制>`。维护者必须自行选择来源可信、经过审核、无凭据的验证命令。
安装器不会自动发现或执行脚本；省略选项仍保留安全失败的验证占位符。

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
uses: Lixiaoyiao/deepseek-harness-action@v0.10.3
```

生产环境应把 Tag 替换为从正式 `v0.10.3` 解析出的完整、不可变 commit SHA。
安装器 `0.7.0` 对应该 Action 身份，独立审查的 installer 源码 commit 是另一个身份。
生成的 workflow 使用核验后的正式 commit，源码模板通过发布构建接收该值。

必须分别核验 installer 源码 Tag 与 `DSH_ACTION_RELEASE_SHA` 打包输入；源码中的
迁移候选准备不能代替正式发布身份。

不要使用 `main`、`latest`、版本范围、candidate SHA 或其它浮动 ref。
`dsh-version` 必须保持为本版本审计过的精确值：

```yaml
with:
  dsh-version: 0.2.1-rc.2
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
      - uses: Lixiaoyiao/deepseek-harness-action@v0.10.3
        with:
          deepseek-api-key: ${{ secrets.DEEPSEEK_API_KEY }}
          dsh-version: 0.2.1-rc.2
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
2. Action 把 `dsh-version` 解析为 `0.2.1-rc.2`。
3. 只读审查没有 workspace 写能力。
4. 只出现预期的 Controller-owned 汇总评论和行内问题。
5. step summary 与 `result-json` 中的 operation、权限档位、有效工具和网络路径符合预期。

接下来可阅读[使用指南](usage.zh-CN.md)了解命令，阅读[配置参考](configuration.md)了解全部输入、权限边界和输出。

## 导入本地 DSH 插件

在终端运行 `npm create deepseek-harness-action@latest -- --advanced --import-plugins`。安装器只读取 `DSH_HOME/profiles` 下的包元数据，默认目录是 `~/.dsh/profiles`。它会展示第三方包名称、已安装版本和对 DSH `0.2.1-rc.2` 的兼容情况，再询问要导入的编号并确认。其他目录可用 `--dsh-home` 指定。

Native 模式可按精确版本重新安装已启用的 npm DSH Bundle。Controlled 模式还需要填写实际的 `plugin__owner__tool` 工具名，只允许你选中的只读工具。使用其他工具命名的插件需要 Native 或手工配置。本地路径、npm 别名、已停用的 Bundle、不兼容版本和普通依赖包需要手工处理，列表会说明原因。没有声明兼容范围时会明确显示未验证。

确认后才会在工作流中启用插件安装。不会复制 `.env`、密钥、本地 Cordis 配置、兼容例外或插件设置。导入的插件使用包自带默认值，不额外申请网络或工作区写权限；现有工作流的权限和整个 worker 的挂载范围仍然适用；所需云端配置可通过已有扩展输入另外设置。Fork PR 审查继续使用不加载扩展的配置。

Native 的网页搜索和读取通过 Controller 代理调用新版 DeepSeek Search/Fetch API。Controlled 的搜索也使用 Search API；Fetch 需要在 custom 或 standard 权限档位中明确加入 `native.web-fetch`。`base-url` 同时决定这些 API 的上游，`web-search-base-url` 保留为旧 Messages 搜索路由。新版 Flash 使用的模型 ID 是 `deepseek-flash`。

Controlled 自动导入面向只读 Review 和 Session；Coding Commands 的插件需要手工声明各任务所需权限。选择同时安装时，插件只加入 Review，Commands 保持原样。Native Commands 保留原有信任检查，插件不能在不受信任的 fork 命令中运行。

显式自定义 `web-search-base-url` 时保留原有 Messages 搜索协议；默认地址使用新版 Search API。Fetch 始终使用独立授权和 `base-url`，也可以只开启 Fetch 而不启用搜索。
