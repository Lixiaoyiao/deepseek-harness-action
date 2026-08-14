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

仓库文件、diff、CI 日志、Issue、PR 和评论都按不可信数据处理。

- `GITHUB_TOKEN` 只留在 Action controller，不会交给 DSH。
- DeepSeek key 由 controller 侧代理注入，不会进入工作区或测试命令。
- fork 不获得文件系统或执行工具；`pull_request_target` 不 checkout PR head。
- 写入前会重新检查操作者权限、仓库来源、绑定的 commit 和实际改动文件。
- 验证在单独的无凭据容器中运行。

完整的信任边界、已知限制和漏洞报告方式见 [`SECURITY.md`](SECURITY.md)。v0.1.0 固定使用 `@deepseek-ai/dsh@0.1.0-rc.6`；DSH 仍在快速迭代，升级前请重新检查配置。

## 架构

```text
GitHub event
    ↓
Action controller: route → authorize → snapshot
    ↓
DSH worker in Docker
    ↓
Action controller: validate → comment / commit / open PR
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
