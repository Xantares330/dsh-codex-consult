/**
 * dsh-codex-consult — DeepSeek Harness plugin entry.
 *
 * Exposes three tools to every DSH agent:
 *
 *   codex_consult  run one Codex CLI consultant call (review / planning /
 *                  diagnosis) with inline evidence, quota guard and a
 *                  provenance-verified model report;
 *   codex_quota    read the latest Codex quota snapshot without any API call;
 *   codex_calls    review recent consultant calls from the durable call index.
 *
 * The plugin is deliberately provider-agnostic: it shells out to whatever
 * `codex` CLI is installed and authenticated for the current user.
 */
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

import {
  DEFAULTS,
  assemblePrompt,
  evaluateQuotaGuard,
  formatQuotaShort,
  readCallIndex,
  readQuotaSnapshot,
  resolveCodexHome,
  resolveStateDir,
  resolveWorkspace,
} from './core.mjs'
import { runConsult } from './runner.mjs'

export const name = 'dsh-codex-consult'

/** Tools are the only capability this plugin needs from the harness. */
export const inject = ['tools']

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra']
const SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access']
const TRANSPORTS = ['native', 'https']

/** Plugin configuration (editable in the DSH Settings UI / profile patch). */
export const Config = Schema.object({
  codexPath: Schema.string()
    .default('')
    .description('Codex CLI executable. Empty = auto-detect the newest install (or CODEX_CLI_PATH).'),
  codexHome: Schema.string()
    .default('')
    .description('Codex home directory with auth.json/sessions. Empty = CODEX_HOME or ~/.codex.'),
  stateDir: Schema.string()
    .default('')
    .description('Durable call log directory. Empty = $DSH_HOME/codex-calls (or ~/.dsh/codex-calls).'),
  model: Schema.string()
    .default(DEFAULTS.model)
    .description('Default Codex model.'),
  effort: Schema.string()
    .default(DEFAULTS.effort)
    .description('Default reasoning effort: low | medium | high | xhigh | max | ultra.'),
  transport: Schema.string()
    .default(DEFAULTS.transport)
    .description('native = stock Codex transport; https = stable long-stream provider (recommended behind proxies).'),
  sandbox: Schema.string()
    .default(DEFAULTS.sandbox)
    .description('Codex sandbox for consultant runs: read-only | workspace-write | danger-full-access.'),
  timeoutSec: Schema.number()
    .default(DEFAULTS.timeoutSec)
    .description('Total time budget for one consultant call, in seconds.'),
  maxAttempts: Schema.number()
    .default(DEFAULTS.maxAttempts)
    .description('Automatic retries (resume in the same thread) before a call is reported failed.'),
  loadUserConfig: Schema.boolean()
    .default(DEFAULTS.loadUserConfig)
    .description('Load the user Codex config.toml (MCP servers, profiles). Off keeps calls hermetic.'),
  requireModelVerification: Schema.boolean()
    .default(DEFAULTS.requireModelVerification)
    .description('Fail a call when the served model/effort cannot be proven from the Codex rollout file.'),
  proxyUrl: Schema.string()
    .default('')
    .description('Optional HTTP proxy for the Codex child process, e.g. http://127.0.0.1:7897. Empty = inherit env.'),
  keepCalls: Schema.number()
    .default(DEFAULTS.keepCalls)
    .description('Number of recent call directories to keep on disk.'),
  quota: Schema.object({
    enabled: Schema.boolean().default(DEFAULTS.quota.enabled).description('Read quota snapshots and guard expensive calls.'),
    warnOnly: Schema.boolean()
      .default(DEFAULTS.quota.warnOnly)
      .description('true = only warn when over budget; false = refuse the call.'),
    primaryMaxPercent: Schema.number()
      .default(DEFAULTS.quota.primaryMaxPercent)
      .description('Refuse/warn when the short (5h) window is at or above this used percentage.'),
    weeklyMaxPercent: Schema.number()
      .default(DEFAULTS.quota.weeklyMaxPercent)
      .description('Refuse/warn when the weekly window is at or above this used percentage.'),
  }).description('Codex quota guardrails.'),
})

function validateEffort(effort) {
  if (!EFFORTS.includes(effort)) throw new Error(`invalid_effort: ${effort} (expected ${EFFORTS.join('|')})`)
  return effort
}

function validateSandbox(sandbox) {
  if (!SANDBOXES.includes(sandbox)) throw new Error(`invalid_sandbox: ${sandbox} (expected ${SANDBOXES.join('|')})`)
  return sandbox
}

function validateTransport(transport) {
  if (!TRANSPORTS.includes(transport)) throw new Error(`invalid_transport: ${transport} (expected ${TRANSPORTS.join('|')})`)
  return transport
}

function markdown(...lines) {
  return lines.filter((line) => line != null && line !== '').join('\n')
}

function renderConsult(args, value) {
  const verified = value.modelVerified ? '✅ 已验证' : '⚠️ 未验证'
  const quota = value.quotaBefore === value.quotaAfter
    ? value.quotaBefore
    : `${value.quotaBefore} → ${value.quotaAfter}`
  const text = markdown(
    value.quotaNote ? `> ⚠️ ${value.quotaNote}` : '',
    `### Codex 咨询 · ${value.status === 'ok' ? '完成' : value.status}`,
    '',
    `- **模型**：${value.model} · effort \`${value.effort}\` · ${verified}`,
    `- **耗时**：${value.elapsedSec}s · **输出**：${value.finalChars} 字符`,
    `- **额度**：${quota}`,
    `- **调用记录**：\`${value.resultFile}\``,
    '',
    '---',
    '',
    value.finalText,
  )
  return [{ type: 'text', text }]
}

function renderQuota(args, value) {
  if (!value.available) {
    return [{
      type: 'text',
      text: markdown(
        '### Codex 额度',
        '',
        `- 暂无可读快照（${value.reason || '执行一次 Codex 调用后即可获得'}）。`,
      ),
    }]
  }
  const formatWindow = (window, label) => {
    if (!window) return `- ${label}：未知`
    const reset = window.resetsAt ? ` · 重置 ${new Date(window.resetsAt * 1000).toISOString()}` : ''
    return `- ${label}：已用 **${window.usedPercent}%**（窗口 ${window.windowMinutes} 分钟${reset}）`
  }
  return [{
    type: 'text',
    text: markdown(
      '### Codex 额度',
      '',
      formatWindow(value.primary, '5h 窗口'),
      formatWindow(value.secondary, '每周窗口'),
      value.credits ? `- Credits：${value.credits.unlimited ? 'unlimited' : value.credits.balance ?? 'n/a'}` : '',
      '',
      `采样：${value.sampledAt || 'n/a'}`,
    ),
  }]
}

function renderCalls(args, value) {
  if (!value.calls.length) {
    return [{ type: 'text', text: `### Codex 调用记录\n\n暂无记录（目录：${value.stateDir}）` }]
  }
  const lines = value.calls.map((call) => {
    const when = call.ts ? new Date(call.ts).toISOString().replace('T', ' ').slice(0, 19) : '?'
    const status = call.status === 'ok' ? '✅' : '❌'
    const verified = call.modelVerified ? '✓' : '✗'
    const label = call.label ? `「${call.label}」` : ''
    return `- ${status} ${when} ${label}\`${call.model || '?'}/${call.effort || '?'}\` ${call.elapsedSec}s · ${call.finalChars} 字符 · 验证 ${verified}`
  })
  return [{
    type: 'text',
    text: markdown('### Codex 调用记录', '', ...lines, '', `目录：\`${value.stateDir}\``),
  }]
}

export function apply(ctx, config = {}) {
  const settings = {
    ...DEFAULTS,
    ...config,
    quota: { ...DEFAULTS.quota, ...(config.quota || {}) },
  }

  const stateDir = () => resolveStateDir(settings)
  const codexHome = () => resolveCodexHome(settings)
  const lastQuota = () => readQuotaSnapshot({ codexHome: codexHome() })

  ctx.tools.register(defineTool({
    name: 'codex_consult',
    description: [
      'Consult OpenAI Codex CLI — an independent second reviewer for planning, review and hard diagnosis.',
      'Use it for: architecture/route decisions, review of reports/plans/conclusions before reporting to the user,',
      'stuck debugging where a second opinion on evidence helps, and acceptance/verdict calls.',
      'It runs Codex in a read-only sandbox by default, inlines `evidenceFiles` into the prompt (so Codex needs no',
      'workspace access), verifies the served model/effort from the Codex rollout file, snapshots quota before and',
      'after, and persists every call under the configured state directory.',
      'Returns the full final answer plus a markdown summary with verification and quota facts.',
    ].join(' '),
    parameters: {
      prompt: {
        type: 'string',
        description: 'Instruction for Codex (may be combined with promptFile / evidenceFiles).',
      },
      promptFile: {
        type: 'string',
        description: 'Path to a prompt file; relative paths resolve against the workspace.',
      },
      evidenceFiles: {
        type: 'array',
        items: { type: 'string' },
        description: 'Evidence files to inline into the prompt (sizes bounded by inlineEvidenceMaxBytes).',
      },
      model: {
        type: 'string',
        description: 'Model override, e.g. gpt-6-astra or gpt-6.1-sol. Defaults to the plugin config.',
      },
      effort: {
        type: 'string',
        description: 'Reasoning effort override: low | medium | high | xhigh | max | ultra.',
      },
      sandbox: {
        type: 'string',
        description: 'Codex sandbox override: read-only (default) | workspace-write | danger-full-access.',
      },
      timeoutSec: {
        type: 'number',
        description: 'Total time budget in seconds for this call (defaults to the plugin config).',
      },
      workspace: {
        type: 'string',
        description: 'Codex working directory; defaults to the current working directory.',
      },
      label: {
        type: 'string',
        description: 'Short label recorded in the call index (e.g. "report-review").',
      },
      minChineseChars: {
        type: 'number',
        description: 'Minimum number of Chinese characters required in the final answer (quality gate).',
      },
      completionMarker: {
        type: 'string',
        description: 'Required suffix of the final answer (e.g. a sentinel line proving completion).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          callId: { type: 'string', required: true },
          model: { type: 'string', required: true },
          effort: { type: 'string', required: true },
          modelVerified: { type: 'boolean', required: true },
          elapsedSec: { type: 'number', required: true },
          finalChars: { type: 'number', required: true },
          finalText: { type: 'string', required: true },
          callDir: { type: 'string', required: true },
          resultFile: { type: 'string', required: true },
          quotaBefore: { type: 'string', required: true },
          quotaAfter: { type: 'string', required: true },
          quotaNote: { type: 'string' },
          threadId: { type: 'string' },
          usage: { type: 'json' },
        },
      },
      render: renderConsult,
    },
    async execute(args, exec) {
      const model = args.model || settings.model
      const effort = validateEffort(args.effort || settings.effort)
      const sandbox = validateSandbox(args.sandbox || settings.sandbox)
      const transport = validateTransport(settings.transport)
      const workspace = resolveWorkspace({ workspace: args.workspace || process.cwd() })

      const consult = assemblePrompt({
        baseDir: workspace,
        promptText: args.prompt,
        promptFile: args.promptFile,
        evidenceFiles: args.evidenceFiles,
        maxPromptBytes: settings.maxPromptBytes,
        inlineEvidenceMaxBytes: settings.inlineEvidenceMaxBytes,
      })

      const quota = settings.quota.enabled ? lastQuota() : null
      const guard = settings.quota.enabled
        ? evaluateQuotaGuard(quota, settings.quota)
        : { ok: true, reason: 'guard_disabled' }
      if (!guard.ok && !settings.quota.warnOnly) {
        throw new Error(
          `quota_guard_blocked: ${guard.reason}. Wait for the window to reset, downgrade model/effort, or set quota.warnOnly=true.`,
        )
      }

      const result = await runConsult({
        codexPath: settings.codexPath,
        codexHome: settings.codexHome,
        stateDir: settings.stateDir,
        model,
        effort,
        transport,
        sandbox,
        timeoutSec: args.timeoutSec || settings.timeoutSec,
        maxAttempts: settings.maxAttempts,
        loadUserConfig: settings.loadUserConfig,
        requireModelVerification: settings.requireModelVerification,
        proxyUrl: settings.proxyUrl,
        workspace,
        consult,
        label: args.label || '',
        minChineseChars: args.minChineseChars || 0,
        completionMarker: args.completionMarker || '',
        keepCalls: settings.keepCalls,
      }, exec)

      if (result.status !== 'ok') {
        throw new Error(
          `codex_consult_failed: ${result.status}; errors=${result.errors.slice(0, 5).join(' | ') || 'unknown'}; details=${result.resultFile}`,
        )
      }

      return {
        status: result.status,
        callId: result.callId,
        model: result.model,
        effort: result.effort,
        modelVerified: result.modelVerified,
        elapsedSec: result.elapsedSec,
        finalChars: result.finalChars,
        finalText: result.finalText,
        callDir: result.callDir,
        resultFile: result.resultFile,
        quotaBefore: formatQuotaShort(result.quotaBefore),
        quotaAfter: formatQuotaShort(result.quotaAfter),
        quotaNote: guard.ok ? '' : `quota_guard: ${guard.reason}（warnOnly，已按配置继续）`,
        threadId: result.threadId || '',
        usage: result.usage ?? null,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'codex_quota',
    description: [
      'Read the latest Codex quota snapshot (short 5h window + weekly window) that Codex itself recorded.',
      'No network or API call is made; the snapshot comes from the tail of recent Codex rollout files.',
      'Use it before expensive consultant calls or when the user asks about Codex quota.',
    ].join(' '),
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          available: { type: 'boolean', required: true },
          reason: { type: 'string' },
          sampledAt: { type: 'string' },
          source: { type: 'string' },
          primary: { type: 'json' },
          secondary: { type: 'json' },
          credits: { type: 'json' },
        },
      },
      render: renderQuota,
    },
    async execute() {
      const quota = settings.quota.enabled ? lastQuota() : null
      if (!quota) {
        return {
          available: false,
          reason: settings.quota.enabled
            ? 'No Codex rollout snapshot found (run any Codex call first).'
            : 'Quota reading is disabled in plugin config.',
        }
      }
      return {
        available: true,
        sampledAt: quota.sampledAt,
        source: quota.source,
        primary: quota.primary,
        secondary: quota.secondary,
        credits: quota.credits,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'codex_calls',
    description: [
      'Review recent Codex consultant calls recorded by this plugin (status, model/effort, duration, verified, label).',
      'Use it to avoid duplicate calls and to cite earlier Codex opinions precisely.',
    ].join(' '),
    parameters: {
      limit: {
        type: 'number',
        description: 'How many recent calls to return (default 10, max 100).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          stateDir: { type: 'string', required: true },
          calls: { type: 'array', items: { type: 'json' }, required: true },
        },
      },
      render: renderCalls,
    },
    async execute(args) {
      const limit = Math.min(Math.max(Number(args.limit || 10), 1), 100)
      return {
        stateDir: stateDir(),
        calls: readCallIndex(stateDir(), limit),
      }
    },
  }))
}
