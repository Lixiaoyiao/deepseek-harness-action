# 使用指南

[English](usage.md) · [项目首页](../README.zh-CN.md) · [安装指南](setup.zh-CN.md) · [配置参考](configuration.md)

DeepSeek Harness 可以由仓库自动事件、评论第一行的 `@dsh` 命令，或维护者编写的自动化 workflow 中的显式 prompt 启动。

## 如何选择操作

| 入口                                                                                     | 实际操作    |
| ---------------------------------------------------------------------------------------- | ----------- |
| PR 的 `opened`、`synchronize`、`ready_for_review` 或 `reopened` 事件，且 `command: auto` | `review`    |
| 使用诊断模板的失败 `workflow_run`                                                        | `diagnose`  |
| 使用受信任自动修复模板的失败 `workflow_run`                                              | `fix`       |
| 第一行 `@dsh task ...`                                                                   | `task`      |
| 第一行 `@dsh review`                                                                     | `review`    |
| 第一行 `@dsh diagnose`                                                                   | `diagnose`  |
| 第一行 `@dsh fix`                                                                        | `fix`       |
| Issue 第一行 `@dsh implement`                                                            | `implement` |
| 维护者配置的 Issue label 或 assignee                                                     | `task`      |
| 维护者配置的 PR label 或 assignee                                                        | `review`    |
| dispatch 或 schedule 中 `command: auto`，并提供非空 `prompt`                             | `task`      |

交互命令必须从触发评论的第一行开始，后续行可以继续写说明。Controller 会先校验所有来源 actor，再把命令正文视为操作者的受信任指令；无法查询权限时会拒绝请求。

workflow 中的 `if: contains(..., '@dsh')` 只是粗略的 job 过滤条件；修改 `trigger-phrase` 时也要同步该条件。Action 仍会执行精确解析、上下文检查和授权。Label/assignee 路由以及 actor/comment filters 只影响维护者控制的路由，绝不授予 trust。

## 通用 task

仓库问答、代码分析或不适合专用命令的编码工作，都可以使用 `task`。

```text
@dsh task --read 解释这个 PR 为什么需要两阶段提交
@dsh task --write 为解析器补上空输入测试并运行验证
```

省略访问标记时，默认使用 `--read`。只读 task 只能使用经过实际信任与权限策略筛选后仍然有效的工具。

`--write` 只是请求能力，不是授权。workflow 还必须设置 `allow-write: "true"`、保持 `run-tests: "true"`、为实际变更提供至少一个验证 argv 数组、运行在符合条件的同仓库且非 `pull_request_target` 的上下文中、通过所有 actor 与 identity 检查，并让 `workspace.edit` 在策略求交后仍然有效。fork PR 永远不能升级为写模式。

结果的交付方式取决于目标：

- 附着在 Issue 或 PR 上的只读 task 会复用一条 Controller-owned task 评论。
- 没有 Issue 或 PR 的只读自动化通过 step summary 和 outputs 返回结果。
- 以 Issue 为目标或没有实体目标的写 task 会创建 Controller-owned 分支和 PR，不会直接推送选定 base branch。默认仍为 `dsh/task-*`；自定义 prefix/template 保持确定性并保留 Controller key。
- 附着在同仓库 PR 上的写 task 只能影响已经绑定并重新校验的 PR head 分支。
- 获准的写 task 如果没有产生仓库变化，可以发布最终回答，但不会创建 commit、ref、PR 或 Release 变更。

## PR 审查

自动审查是最简单的入口。Action 会读取已经绑定的 diff 和仓库上下文，发布一条汇总，并且只为经过筛选的高置信度问题添加行内评论。重新运行同一操作时，会更新 Controller-owned summary marker，不会再创建一条汇总评论。

如需手动重新审查，可以评论：

```text
@dsh review
```

fork 和 `pull_request_target` 审查始终是只读的。workflow 只能检出受信任的 base SHA；untrusted profile 中的 worker 没有仓库工具，也不会运行 fork 代码。

## CI 诊断

使用 [`examples/ci-diagnose.yml`](../examples/ci-diagnose.yml) 在 CI workflow 失败后运行。Controller 会按仓库和不可变 head SHA 选择检查与日志，经过限长和脱敏后，明确标为不可信数据再交给 DSH。

通过授权的维护者也可以评论：

```text
@dsh diagnose
```

诊断是只读操作，只会发布原因和建议的下一步，不会授予 shell 或修改仓库。

## 修复 PR

在符合条件的同仓库 PR 上使用：

```text
@dsh fix
```

workflow 必须显式启用受信任写模式和固定验证命令。DSH 在一次性的无 `.git` workspace 中修改文件；Controller 会检查实际变更、受保护路径、验证和 Validation Integrity，然后才创建 commit 或更新已经绑定的 PR 分支。最终验证成功前，不会发布写任务的生命周期评论。

交互修复模板见 [`examples/commands.yml`](../examples/commands.yml)，失败 CI 修复模板见 [`examples/ci-auto-fix.yml`](../examples/ci-auto-fix.yml)。

## 实现 Issue

在 Issue 中评论：

```text
@dsh implement
```

授权通过后，Controller 会绑定 Issue 和维护者选定的 base head，执行同样的修改与验证关卡，再创建专用分支并打开 PR。操作期间如果绑定的 Issue 规格被修改，或选定 base head 发生变化，写入会默认拒绝。是否合并生成的 PR 仍由维护者另行决定。

## 显式自动化

自动化是一种 workflow 用法，不存在 `@dsh automation` 命令。在 `workflow_dispatch`、`repository_dispatch` 或 `schedule` 中，`command: auto` 加非空 `prompt` 会选择 `task`。也可以显式设置 `command: task`，此时 `prompt` 必填。

```yaml
with:
  command: auto
  prompt: "检查依赖边界，必要时补测试并解释结果"
  task-access: read
```

`task-access` 默认是 `read`。设置为 write 后仍需通过全部写入关卡；对于 Issue-backed 或没有实体目标的 task，结果是分支和 PR，而不是直接推送默认分支。

`prompt` 属于受信任的控制面配置。它只能来自维护者编写的 workflow，或调用者身份受信任的 dispatch 输入。不要把 Issue 正文、PR 内容、日志、仓库文件或模型输出提升为 `prompt`。所有带权限含义的输入都要遵守同一来源规则，尤其是权限档位、工具列表、验证、容器与运行时、网络 endpoint 和扩展配置。

完整的读写 dispatch 模板见 [`examples/task-automation.yml`](../examples/task-automation.yml)。自定义 trigger、typed GitHub Tools、安全 branch UX 与结构化 task output 见 [`examples/github-integration.yml`](../examples/github-integration.yml)。

## 多轮工具、验证与修复

每次外层迭代都会启动一个新的 DSH turn，但任务、workspace 和 Controller 策略保持绑定：

```text
DSH turn
  ├─ needs_tool → 运行获准工具 → 限长、脱敏结果 → 下一轮
  ├─ final → Controller 验证失败 → 限长输出 → 修复轮
  ├─ final → 验证通过 → Controller 发布或写入
  └─ blocked → 只有不存在 Controller 验证失败时才能返回 neutral
```

`max-turns` 默认是 3，同时计算工具请求和验证修复轮。Action 的 `timeout-minutes` 是 setup 与执行的总 deadline；runtime setup、扩展安装、每个 Agent turn 和验证还有独立上限。在相同 workspace revision 上重复出现同一个验证失败时，会以 no-progress 错误停止。

修复轮不能通过返回 `blocked`、耗尽轮数或输出畸形结构化结果来抹去尚未解决的验证或 Validation Integrity 失败。只有后续 finalization 真正通过后，原始 Controller 失败才会解除。

## 进度与结果

获准的只读操作如果有 Issue 或 PR 目标，Controller 会在主要阶段更新一条 sticky comment，并让最终结果复用同一个 marker。

| 操作                | Marker      |
| ------------------- | ----------- |
| `task`              | `task`      |
| `review`            | `summary`   |
| `diagnose`          | `diagnosis` |
| `fix` / `implement` | `write`     |

`progress-comment` 默认为 `true`。设为 `false` 只会关闭中间生命周期更新；正常汇总、行内问题、诊断和获准的最终结果仍会发布。

写请求在验证成功或实际变更检查确认任务没有变化前，不会发布生命周期或状态评论。失败时请查看 step summary 和 outputs。Action 在 success、neutral 和 failure 路径都会设置标量 outputs 和 schema-v1 `result-json`。配置 task schema 后，只会额外产生 Controller 校验过的 `task-output`/`taskOutput` 数据，不会替换审计信封。

取消收尾有明确时间上限，但只能尽力完成。`SIGTERM` 或 `SIGINT` 可以更新符合条件的 sticky comment；`SIGKILL`、runner/host 丢失、进程崩溃或 GitHub API 失败仍可能让评论停在 “In progress”。应以 Actions conclusion 为准，详见[故障排查](troubleshooting.md)。

完整 output schema 和安全的 `always()` 读取示例见[配置参考](configuration.md#outputs)。

## Workflow 模板

- [安全的 fork 审查](../examples/fork-review.yml)
- [交互命令](../examples/commands.yml)
- [CI 诊断](../examples/ci-diagnose.yml)
- [受信任 CI 自动修复](../examples/ci-auto-fix.yml)
- [通用 task 自动化](../examples/task-automation.yml)
- [GitHub integration 配置](../examples/github-integration.yml)
- [受控扩展](../examples/controlled-extensions.yml)

所有模板都禁用了 checkout 凭据。生产环境请把模板中的发布 Tag 替换为对应版本的完整、不可变 release commit SHA。
