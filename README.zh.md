# dsh-codex-consult

> 把 **OpenAI Codex CLI** 接进 **DeepSeek Harness**，做一个随时可用的「外部顾问」。

插件给每个 DSH agent 提供三个工具：

| 工具 | 作用 |
| --- | --- |
| `codex_consult` | 让 Codex 做规划 / 审查 / 疑难诊断：证据内联、**服务端真实模型档位可验证**、调用前后额度快照、全程落盘可追溯。 |
| `codex_quota` | 读取 Codex 最新额度快照（5 小时窗口 + 每周窗口），**不产生任何 API 调用**。 |
| `codex_calls` | 查看最近的 Codex 调用记录：状态、模型、耗时、是否验证、标签。 |

目标是**低门槛、可审计的第二意见**：DSH 在做架构取舍、把报告/结论发给用户前、
卡在疑难问题超过 30–60 分钟、或需要判定验收是否达标时，可以随时咨询另一个模型
家族——并且有证据能证明「到底是哪个模型回答的」。

---

## 为什么需要这个插件

单一模型家族可能自信地犯错。咨询另一个模型很便宜，但朴素集成有三个坑，
这个插件都处理了：

1. **请求说用一个模型，实际被悄悄降级**（容量不足、额度限制、provider 回退）。
   插件读取 Codex 的 rollout 文件，校验**实际服务**的模型与推理档位；不一致直接判失败。
2. **长审查流被中途掐断**。在代理后面，长流式响应容易被重置。`transport: "https"`
   会抬高 stream idle 上限，并在同一 thread 内自动 `codex exec resume` 重试，
   重发完整 prompt——答案不会是残片拼接。
3. **没人知道花了多少额度**。每次调用前后从 Codex 自己的遥测里快照额度，
   写入持久索引；超过阈值可配置为「警告」或「拒绝调用」。

---

## 环境要求

- **DeepSeek Harness**，需要 `tools` 能力（在 `0.2.0-rc.*`、`@deepseek-ai/dsh-tools >= 0.1.5-rc.2` 上测试）。
- **Codex CLI** 已安装并登录（`codex --version` 可用、`codex login` 完成）。
  插件自动探测最新安装，**不读取** `auth.json`。
- Node.js 22+（DSH 自带运行时，无需额外安装）。

---

## 安装

### A. 装进某个 DSH profile（本地包）

```powershell
# 1) 让 profile 能解析到包
$profile = "$env:USERPROFILE\.dsh\profiles\desktop"
New-Item -ItemType Junction -Path "$profile\node_modules\dsh-codex-consult" -Target "D:\path\to\dsh-codex-consult"

# 2) 挂载：在 profile 的 cordis.patch.yml 末尾追加
```

```yaml
- insert:
    - id: codex-consult
      name: dsh-codex-consult
```

重启 DSH（或重新加载 profile）后，该 profile 的所有会话都会出现三个工具。

> 通过 bundle 方式挂载的包自带 `cordis.patch.yml`（见
> [`cordis.patch.yml`](./cordis.patch.yml)），不需要手动写 `insert`；
> 手动挂载只用于「直接从 profile 的 node_modules 加载」的场景。

### B. 作为 bundle 分发（推荐给别人用）

在 profile 的 `package.json` 里加依赖，并把包名加进 bundle 列表：

```json
{
  "dependencies": { "dsh-codex-consult": "^0.1.0" },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-codex-consult"]
    }
  }
}
```

### C. 从 npm 安装（发布后）

```powershell
dsh plugin --profile desktop add dsh-codex-consult
```

---

## 配置

配置写在插件节点（`codex-consult`）的 config 里，例如 profile patch：

```yaml
- id: codex-consult
  config:
    codexPath: ""                                    # 空 = 自动探测
    codexHome: ""                                    # 空 = ~/.codex
    stateDir: ""                                     # 空 = $DSH_HOME/codex-calls
    model: gpt-6-astra
    effort: high
    transport: https                                 # 代理环境下推荐
    sandbox: read-only
    timeoutSec: 900
    maxAttempts: 3
    loadUserConfig: false
    requireModelVerification: true
    proxyUrl: http://127.0.0.1:7897
    keepCalls: 100
    quota:
      enabled: true
      warnOnly: true
      primaryMaxPercent: 90
      weeklyMaxPercent: 85
```

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `model` / `effort` | `gpt-6-astra` / `high` | 可在工具参数里逐次覆盖。 |
| `transport` | `native` | `https` 会在代理环境下启用稳定的长流 provider（`dsh-https`）。 |
| `sandbox` | `read-only` | Codex 不需要写权限：证据是内联进 prompt 的。 |
| `requireModelVerification` | `true` | 仅当 Codex 不写 rollout 日志时才建议关闭。 |
| `proxyUrl` | `""` | 只对 Codex 子进程生效；空 = 继承环境变量。 |
| `quota.warnOnly` | `true` | 设为 `false` 时，超额度会**拒绝**调用。 |

---

## 使用

任何 DSH agent 都可以直接调用。典型话术：

```text
审查 papers/phystwin/docs/06-report.md 和 research/.../render_metrics_20261021.txt 里的证据，
结论是否站得住？用 codex_consult 并传 evidenceFiles。

发送前用 codex_consult 审一下我的最终答复。
```

工具返回内容除完整答案外，还包含：

- `model` / `effort` —— 请求值；`modelVerified` —— 从 rollout 证明的真实值；
- `elapsedSec`、`finalChars`、token `usage`；
- `quotaBefore` / `quotaAfter`（如 `5h 3% · weekly 22%`）；
- `callDir` / `resultFile` —— 本次调用的持久记录。

---

## 验证与额度是怎么做的

- **模型验证**：调用结束后，按 thread id 找到本次精确的 rollout 文件
  （`~/.codex/sessions/YYYY/MM/DD/rollout-*<thread>.jsonl`），读取最后一条
  `turn_context` 事件，对比 `model` / `effort`。不一致则本次调用判定失败。
  这些信息来自 Codex 自己的元数据，插件不会打开 `auth.json`。
- **额度快照**：Codex 会在 `token_count` 事件里记录 `rate_limits`；插件只读
  最近 rollout 的尾部，不产生任何 API 调用，所以 `codex_quota` 零成本。
  调用前护栏可「警告」或「拒绝」，调用后记录额度变化。

---

## 安全

- 默认 `read-only` 沙箱；非交互调用固定 `approval_policy="never"`，不会卡在审批上。
- 证据会内联进 prompt；**prompt 与答案文件保存在调用目录**，可能含敏感项目数据，
  请像对待你附上的文件一样对待它们。
- 插件只会启动用户配置或系统安装的 Codex 可执行文件。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| `codex_not_found` | 配置 `codexPath` 或 `CODEX_CLI_PATH`。 |
| `proxy_unavailable` | 启动代理 / 修正 `proxyUrl` / 去掉该配置。 |
| `effective_model_or_effort_unverified` | Codex 降级或替换了模型：检查额度，或确认本机 Codex 会写 rollout 日志。 |
| `usage_limit` / `capacity` | 等窗口重置、降低 `model`/`effort`，先用 `codex_quota` 看看。 |
| 长调用约 2 分钟被断 | 用 `transport: https`（会抬高 stream idle 超时）。 |
| Codex 配置报错 | `loadUserConfig: false` 保持调用干净；需要用户 MCP/配置时才开。 |

## 开发

```powershell
node test/unit.mjs    # 纯函数测试，无网络
node test/e2e.mjs     # 假 DSH ctx + 一次真实 Codex 调用（需要登录+网络）
```

目录结构：

```
lib/core.mjs     路径解析、rollout 溯源、额度、prompt 组装、调用索引
lib/runner.mjs   Codex CLI 调用引擎（重试/resume/遥测）
lib/index.mjs    DSH 插件入口：配置 schema + 三个工具
test/            单测 + e2e
examples/        AGENTS.md 片段、profile patch 示例
```

版本历史见 [CHANGELOG.md](./CHANGELOG.md)。

## License

[MIT](./LICENSE)
