# Configuration check / 配置检查

From a reviewed Action source checkout with Node 24 and installed dependencies:

```bash
npm run check:config -- --config examples/config-check.json
```

The JSON document has `schemaVersion: 1`, an `inputs` object mapping public
Action names to strings, and optional `credentialEnv` mapping
`deepseek-api-key`/`github-token` to environment variable names. Keep credentials
in environment variables rather than a tracked JSON file. The example fails
clearly when those variables are absent. A successful static check only proves
that the supplied configuration can be parsed; its JSON result explicitly
reports untested items as `not_checked`.

It starts no model or subprocess, runs no repository validation commands,
makes no network request and changes no remote state. The configuration file
is limited to 256 KiB, strict UTF-8 and the declared schema. Unknown Action
inputs and malformed configuration fail. Diagnostics redact credential values.

Checks cover credential presence, the exact DSH `0.2.1-rc.2` pin, input and
extension schemas, mode/isolation requirements, and explicit write-task
validation argv, `run-tests=true` and a digest-pinned image. `command: auto`
cannot resolve a future event offline: its write eligibility is checked again
after real routing and before the model. Docker daemon/image availability,
credential validity, quota/permissions, source files, executable toolchain,
extension activation and validator behavior remain `not_checked` offline.

Normal runs reuse the configuration gates and perform a bounded, credential-free
Docker daemon probe before worker installation. Runtime admission,
authorization, fresh revalidation and successful final validation still govern
writes. The checker never grants trust to a repository script or waives a gate.

中文：从已审查的源码目录运行上述命令。它只做静态配置校验，不启动模型、不执行
仓库代码、不联网、不改远端。凭据通过 `credentialEnv` 指定环境变量，不放入已跟踪
JSON。Docker、在线权限、配额、文件内容、扩展激活和验证脚本执行结果均明确标记
`not_checked`。显式写任务缺少验证、仍含安装器占位符或未固定镜像会提前失败；
自动路由的写任务在实际路由后再次检查。验证命令须由维护者选择并审查，不能因
检查配置通过就把仓库脚本提升为授权。

See [setup](setup.md), [中文安装](setup.zh-CN.md), [text context](text-files.md)
and the [public input reference](configuration.md).
