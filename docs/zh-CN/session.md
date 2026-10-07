# Session 检查点与自动续接

[English](../session.md) · [配置](../configuration.md) · [安全边界](../../SECURITY.md)

Session 是显式 opt-in，用于在后续 Actions run 中继续同一便携文本任务。它复用固定
**DSH 0.2.0-rc.2** 的公开 JSONL persistence 和 `--session-id`。检查点保存完整的
原始 v4 Session 日志及来源 manifest；headless NDJSON 事件投影、拼接历史评论都
不能替代真实 Session 日志。

把[可运行 dispatch 示例](../../examples/session.yml)复制到
`.github/workflows/dsh-session.yml`，提交到默认分支并配置 `DEEPSEEK_API_KEY`。
生产环境应绑定正式 Release 公布的 Action 完整 commit。在默认分支
dispatch `auto` 并指定维护者选择的 key。该 key 无已记录历史时自动创建
generation 1；后续在**同一个 workflow** 中保持相同 key 和模式 dispatch，
自动定位最新成功且兼容的检查点，无需填写 `source_run_id`。可以修改 prompt，
提出同一任务的后续问题；成功恢复后保存下一 generation。结果记录
`selection: created` 或 `resumed`、generation 和自动选择的 `sourceRunId`。

[显式示例](../../examples/session-explicit.yml)继续支持 `save` 和 `resume`：
`save` 使用新逻辑 key；`resume` 显式指定最新成功 producer 的数字
`source_run_id`。显式工作流保留原并发契约；采用自动契约时使用新的 workflow
文件路径和新 key。旧 run 没有可核验 key 的 run-name 时，该 workflow 的历史
属于未知，auto 会拒绝执行，即使其 artifact 已消失也不会当成首次。

| 输入                     | 含义                                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| `session-mode`           | 默认 `off`，另有 `auto`、`save`、`resume`。`auto` 按 key 自动创建或续接。                  |
| `session-key`            | 维护者选择的 1–64 位 ASCII 字母、数字、点、下划线或连字符；启用时必填。auto 不区分大小写。 |
| `session-source-run-id`  | 仅 resume 必填，显式指定成功 producer run ID；使用在线核验后的当前 run attempt。           |
| `session-retention-days` | 默认 `3`，范围 `1`–`7` 天；过期状态拒绝恢复。                                              |

controlled 和 native 都要求 `isolation: docker`、digest 锁定镜像及固定 worker
工作目录 `/workspace`。host 执行不能提供跨 run 稳定的 cwd 身份。检查点最多保存
**4 MiB** 原始日志、**16 KiB** manifest；保留真实记录及原始模型流结算，不静默
截断、脱敏改写或迁移原始日志。

## 工作流与来源绑定

auto 工作流必须在**根级别**声明相同的 run-name 与 concurrency，并将同一个
必填 string dispatch input 原样传给 Action：

```yaml
run-name: dsh-session-${{ inputs.session_key }}
on:
  workflow_dispatch:
    inputs:
      session_key:
        type: string
        required: true
concurrency:
  group: dsh-session-${{ inputs.session_key }}
  cancel-in-progress: false
# 单个生产 Action step 内：
# with:
#   session-mode: auto
#   session-key: ${{ inputs.session_key }}
```

相同逻辑 key 串行，不同 key 可以并行。auto 将 key 转成小写，与 GitHub
concurrency group 不区分大小写的行为一致。也支持维护者指定的静态 key，此时
`session-key`、group 后缀与 run-name 后缀必须是相同字面量。其他表达式、key
表达式不匹配或启用取消均被拒绝。显式 save/resume 仍使用原字面量 group
`dsh-session` 与 `cancel-in-progress: false`。

一个静态命名 job 中只能有一个 Session-producing Action step；不支持 producer
matrix 或 reusable job。Session 模式、key、source run 必须由
维护者控制，PR/Issue 内容、日志和模型输出不能选择这些配置或授予权限。

本次 GitHub triggering actor 必须与刚核验的授权身份一致。auto 拒绝 rerun 旧的
Actions run，必须发起新的维护者 dispatch；显式模式拒绝不同账号发起的 rerun。
新的 dispatch 账号可以不同于来源 run。

Controller 在线重新核验仓库 ID、默认分支、不可变 workflow revision、workflow
路径、静态 job 和 run attempt。来源必须是同仓库默认分支的成功 run；拒绝
`pull_request`、`pull_request_target` 来源。manifest 还绑定 task、key、DSH
版本、composition、镜像、扩展配置、generation 和保留期限。Issue/PR 绑定实体与
operation；automation 绑定 operation 与 Session key，所以允许修改后续指令。
改变仓库、任务、key 或运行时组合时，使用新的 key 创建 Session。
controlled 扩展 digest 包含其有效扩展工具授权；权限变更如果移除或改变这些授权，
恢复会因不兼容而拒绝，需要新的 key。扩展配置或凭据变更也可能改变 digest。
每次兼容恢复仍会重新计算当前权限。

GitHub artifact 元数据能证明所属 workflow run，不能独立证明由哪个 job 上传。
manifest 中的 job/actor 字段会与当前 GitHub run/job 元数据核对，但不是服务端签发
的 artifact issuer 证明。信任边界是维护者审阅的**整个默认分支 workflow**；应
审阅所有 step、引用的 Action，以及能够上传 artifact 的步骤。

只允许恢复最新成功 generation。旧来源、多个匹配检查点、重复执行已经 claim 的
attempt、过期状态、generation 冲突都会 fail closed。claim 记录已经开始的
attempt；失败或结果不明的 run 不能作为恢复来源。先查看 run 结果并核对外部副
作用，再选择新的逻辑 key；不会靠自动重放任务或重试写操作恢复不明结果。

auto 在模型启动前、保存前分别按已核验 run-name 检查完整可用 workflow 历史。
同 key 上一个 run 失败、取消或结果不明时，即使旧成功检查点仍在，也会拒绝续接。
最新成功 run 的检查点过期、缺失、损坏或不兼容时分别给出失败诊断，不会当成首次
创建，也不会回退旧成功检查点。GitHub concurrency 不保证先入先出：更晚的同 key
请求已经启动或结束时，较早请求会被拒绝；仍在排队的后续请求不阻止当前 run 保存。

扫描上限为 1,000 个 workflow run、1,000 个仓库 artifact、20 个兼容保留检查点
候选；列表不完整、重复或无法读取时 fail closed。保留的 run-name 能在 artifact
过期或被清理后证明已有该 key 历史。管理员可删除 run 和 artifact；删除的证据
无法重建，本功能不承诺永久识别“有史以来首次”。不要通过删除历史重试结果不明
的任务。同 auto key 在不同 workflow、task 或 runtime 中复用不兼容；先核对历史
副作用，再选择新 key。

## 权限、凭据与保留数据

新 worker 使用本次 run 重新计算的权限；启动策略在 driver 执行前替换历史
permission、sandbox、approval 设置，不恢复旧授权。Controller 的 GitHub 写入
仍需授权、验证、写前即时校验和结果核对，导入检查点不会重放以前的 GitHub
写入。外部扩展的凭据和副作用继续按扩展自身边界管理。

导出仅接受一个完整、已结算的顶级 Session。排队输入、未结束的 turn/request/
tool 或其他已跟踪操作、child/fork 血缘、不兼容 cwd/preset、未知必需事件、损坏
记录、额外 Session/generation、符号链接、硬链接以及超限 JSON 复杂度均拒绝。
artifact 仅含 `manifest.json` 与 `session.jsonl`，不保存完整 worker home、配置
或 lease 文件。导入校验完整性后写入新的专用目录，拒绝覆盖现有状态。

初版检查点只支持便携文本 Session。DSH 已发布的 attachment store 和 native
`read_image` 等工具能创建持久图片或文件引用，其字节保存在
`DSH_HOME/attachments/v1`，不在 raw JSONL 内。Action 的双文件 archive 不携带
该存储，也未实现新 worker 的附件还原，因此导入 admission 和检查点收集都会
拒绝 DSH 实际解释为图片/文件内容的持久引用，包括当前 run 工具生成的引用。
保存会明确失败，不生成恢复后缺少附件字节的半套状态；诊断不回显引用的文件名
或 attachment ID。文本中的文件名和普通业务 JSON 本身不是二进制附件。

native 工具图继续可用，此限制不禁用 `read_image`，也不表示 DSH 没有图片能力。
附件传输、存储生命周期及新 worker 还原是尚未完成的 Action 工程，与
[运行时审计](../v0.9.2-runtime-audit.md#why-images-and-binary-attachments-are-deferred)
记录的已发布 Headless 输入限制分别说明。

初版不会自动快照 child Session。native 保留现有工具图；任务如果实际创建了
subagent/child persistence，额外 Session 会使检查点收集失败并给出明确诊断，
不会只保存父 Session 的半套状态。blocked 或失败任务不生成可恢复检查点；先
核对其 claim 与外部副作用，再创建新的逻辑 Session。

导出和导入检查 Controller 实际已知凭据、扩展实际秘密、proxy 凭据、凭据字段、
已知 token 格式及 private key。发现后给出不回显原文的诊断并拒绝，不改写 raw
日志来获得成功。这些检查**不能证明已排除任意第三方事件数据中的所有秘密**。
检查点会保留任务文本、仓库上下文、模型输出及工具结果；将 Actions artifact
视为保留的任务数据，启用前审查扩展输出。该功能提供文本会话连续性，不代表
原生图片或 Office 附件支持。

workflow/run/artifact 读取复用现有 Controller GitHub client 与配额诊断。SDK 上传
使用独立的 job-scoped runtime 凭据；该 SDK 的传输请求数不计入主 client 审计。
上传等待有界，结果不明时保留诊断，不重放任务或写入。

## 失败后的处理

通过 run 结果和 artifact receipt 核对 source run、generation、校验值。只从
最新、兼容、成功 run 的检查点恢复。过期或不兼容时，用新的维护者 key 启动新
任务。当前 worker 生成持久图片/文件引用时，检查点可能在工具执行后收集失败；
先核对 tool receipts 和已经确认的外部副作用，再选择新的逻辑 Session，不会
生成部分附件检查点。损坏状态或凭据拒绝时，修复生成配置或输出并创建新 Session。手工编辑
原始记录会失去完整性和无损恢复保证。配置检查入口不会假装已经核验在线来源、
Docker 可用性或 artifact 权限；实际 run 会在模型启动前完成这些检查。
