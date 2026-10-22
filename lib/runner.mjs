/**
 * dsh-codex-consult — the Codex CLI invocation engine.
 *
 * Ported from the battle-tested `codex-ask-runner` used by the DSH bridge and
 * extended for plugin use:
 *   - inline plugin config (codex path, home, proxy, transport, ...)
 *   - quota snapshots before/after every call (no extra API traffic)
 *   - verified model provenance from the Codex rollout file
 *   - bounded retries through `codex exec resume`
 *   - a durable call index plus per-call directories
 */
import { spawn, spawnSync } from 'node:child_process'
import { createWriteStream, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import readline from 'node:readline'
import net from 'node:net'

import {
  DEFAULTS,
  appendCallIndex,
  chineseCharCount,
  createCallId,
  ensureDir,
  pruneCalls,
  readQuotaSnapshot,
  resolveCodexExecutable,
  resolveCodexHome,
  resolveStateDir,
  sha256,
  verifyProvenance,
  writeJsonFile,
} from './core.mjs'

/** Fold one `codex exec --json` event into the streaming state. */
export function consumeEvent(state, event) {
  if (event.type === 'thread.started') state.threadId = event.thread_id
  if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
    state.agentText = event.item.text || ''
  }
  if (event.type === 'item.completed' && event.item?.type === 'error') {
    state.warnings.push(event.item.message)
  }
  if (event.type === 'turn.completed') {
    state.completed = true
    state.usage = event.usage
  }
  if (event.type === 'turn.failed') {
    state.failed = true
    state.errors.push(event.error?.message || 'turn.failed')
  }
  if (event.type === 'error') state.errors.push(event.message || 'error')
}

/**
 * Judge one attempt. `ok` requires a clean exit, a finished turn, a valid
 * final message and — unless explicitly disabled — a served model/effort that
 * matches the request.
 */
export function assessFinal({
  exitCode,
  completed,
  failed,
  timedOut,
  text,
  agentText,
  effective,
  model,
  effort,
  minChineseChars = 0,
  marker = '',
  requireModelVerification = true,
}) {
  const modelVerified = effective?.model === model && effective?.effort === effort
  const outputValid = Boolean(text)
    && text === (agentText || '').trim()
    && chineseCharCount(text) >= minChineseChars
    && (!marker || text.endsWith(marker))
  return {
    modelVerified,
    outputValid,
    ok: exitCode === 0
      && completed
      && !failed
      && !timedOut
      && outputValid
      && (!requireModelVerification || modelVerified),
  }
}

async function checkProxy(proxyUrl) {
  if (!proxyUrl) return true
  const url = new URL(proxyUrl)
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
  return new Promise((resolve) => {
    const socket = net.connect({ host: url.hostname, port })
    const finish = (ok) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(3000, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

function killTree(child) {
  if (child.pid == null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
  } else {
    child.kill('SIGKILL')
  }
}

/**
 * Run one consultant call end to end.
 *
 * @param options.consult — `{ text, sources, bytes }` assembled by the caller.
 * @param exec — DSH tool execution context (`exec.signal` cancels the child).
 */
export async function runConsult(options = {}, exec = {}) {
  const startedAt = Date.now()
  const stateDir = resolveStateDir(options)
  const workspace = options.workspace || process.cwd()
  const callId = createCallId('consult')
  const callDir = ensureDir(join(stateDir, 'calls', callId))
  const promptFile = join(callDir, 'prompt.md')
  const resultFile = join(callDir, 'result.json')
  const finalFile = join(callDir, 'final.md')
  const promptText = options.consult?.text || ''
  writeFileSync(promptFile, promptText, 'utf8')

  const result = {
    callId,
    label: options.label || '',
    status: 'running',
    exitCode: null,
    model: options.model || DEFAULTS.model,
    effort: options.effort || DEFAULTS.effort,
    transport: options.transport || DEFAULTS.transport,
    sandbox: options.sandbox || DEFAULTS.sandbox,
    workspace,
    elapsedSec: 0,
    finalText: '',
    finalChars: 0,
    finalChineseChars: 0,
    usage: null,
    errors: [],
    attempts: [],
    callDir,
    promptFile,
    promptFileRelative: promptFile,
    promptBytes: Buffer.byteLength(promptText, 'utf8'),
    promptSha256: sha256(promptText),
    promptSources: options.consult?.sources || [],
    resultFile,
    finalFile,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: null,
    modelVerified: false,
    quotaBefore: null,
    quotaAfter: null,
    codexPath: null,
    codexVersion: null,
  }
  writeJsonFile(resultFile, result)

  try {
    if (!['read-only', 'workspace-write', 'danger-full-access'].includes(result.sandbox)) {
      throw new Error(`invalid_sandbox: ${result.sandbox}`)
    }
    if (!['https', 'native'].includes(result.transport)) {
      throw new Error(`invalid_transport: ${result.transport}`)
    }
    if (!promptText.trim()) throw new Error('empty_prompt')
    result.quotaBefore = readQuotaSnapshot({ codexHome: resolveCodexHome(options) })
    result.codexPath = resolveCodexExecutable(options)
    result.codexVersion = spawnSync(result.codexPath, ['--version'], { encoding: 'utf8', windowsHide: true })
      .stdout?.trim() || null

    const env = { ...process.env }
    // A consultant is an independent CLI client, not a child of the App task.
    for (const key of [
      'CODEX_THREAD_ID',
      'CODEX_SESSION_ID',
      'CODEX_TOOL_CALL_ID',
      'CODEX_INTERNAL_ORIGINATOR_OVERRIDE',
      'CODEX_APP_TOOLS_PIPE_PATH',
    ]) {
      delete env[key]
    }
    env.CODEX_HOME = resolveCodexHome(options)
    if (options.proxyUrl) {
      env.HTTPS_PROXY = options.proxyUrl
      env.HTTP_PROXY = options.proxyUrl
      env.ALL_PROXY = options.proxyUrl
      env.NO_PROXY = env.NO_PROXY || '127.0.0.1,localhost'
      if (!(await checkProxy(options.proxyUrl))) {
        throw new Error(`proxy_unavailable: ${options.proxyUrl}`)
      }
    }

    const timeoutMs = Math.max(1, Number(options.timeoutSec || DEFAULTS.timeoutSec)) * 1000
    const maxAttempts = Math.max(1, Number(options.maxAttempts || DEFAULTS.maxAttempts))
    const requireModelVerification = options.requireModelVerification ?? DEFAULTS.requireModelVerification
    const minChineseChars = Number(options.minChineseChars || 0)
    const marker = options.completionMarker || ''
    let threadId = null
    let aborted = false
    const onAbort = () => {
      aborted = true
    }
    if (exec.signal) exec.signal.addEventListener('abort', onAbort, { once: true })

    for (let index = 1; index <= maxAttempts; index += 1) {
      if (aborted) {
        result.errors.push('cancelled')
        break
      }
      if (index > 1) await new Promise((resolve) => setTimeout(resolve, Math.min(index * 2000, 10000)))
      const remaining = timeoutMs - (Date.now() - startedAt)
      if (remaining <= 0) {
        result.errors.push('total_timeout')
        break
      }
      const prefix = join(callDir, `attempt-${index}`)
      const attempt = {
        index,
        mode: threadId ? 'resume' : 'new',
        threadId,
        startedAt: new Date().toISOString(),
        exitCode: null,
        completed: false,
        timedOut: false,
        cancelled: false,
        errors: [],
        warnings: [],
        log: `${prefix}.jsonl`,
        stderr: `${prefix}.stderr.log`,
        finalFile: `${prefix}.final.txt`,
        finalChars: 0,
        finalChineseChars: 0,
        modelVerified: false,
        outputValid: false,
        transportInterrupted: false,
        effective: null,
      }

      const args = ['exec']
      if (!options.loadUserConfig) args.push('--ignore-user-config')
      args.push(
        '--model', result.model,
        '--config', `model_reasoning_effort="${result.effort}"`,
        '--config', 'approval_policy="never"',
        '--config', `sandbox_mode="${result.sandbox}"`,
        '--skip-git-repo-check',
        '--json',
        '--output-last-message', attempt.finalFile,
      )
      if (result.transport === 'https') {
        // A distinct provider avoids built-in websocket capability overrides and
        // raises the stream idle budget, which is what makes long reviews stable
        // behind proxies.
        args.push(
          '--config', 'model_provider="dsh-https"',
          '--config', 'model_providers.dsh-https.name="OpenAI HTTPS (DSH)"',
          '--config', 'model_providers.dsh-https.requires_openai_auth=true',
          '--config', 'model_providers.dsh-https.supports_websockets=false',
          '--config', 'model_providers.dsh-https.wire_api="responses"',
          '--config', 'model_providers.dsh-https.stream_idle_timeout_ms=600000',
          '--config', 'model_providers.dsh-https.stream_max_retries=3',
        )
      }
      if (threadId) args.push('resume', threadId, '-')
      else args.push('-C', workspace, '-')
      attempt.arguments = args

      const stdout = createWriteStream(attempt.log)
      const stderr = createWriteStream(attempt.stderr)
      const attemptStarted = Date.now()
      let stderrText = ''
      const events = {
        agentText: '',
        usage: null,
        completed: false,
        failed: false,
        threadId,
        errors: attempt.errors,
        warnings: attempt.warnings,
      }
      const child = spawn(result.codexPath, args, {
        cwd: workspace,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      child.stdout.pipe(stdout)
      child.stderr.on('data', (chunk) => {
        stderr.write(chunk)
        stderrText += chunk.toString('utf8')
      })
      child.stdin.on('error', (error) => {
        if (error.code !== 'EPIPE') attempt.errors.push(error.message)
      })
      const eventTask = (async () => {
        const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
        for await (const line of lines) {
          let event
          try {
            event = JSON.parse(line)
          } catch {
            continue
          }
          consumeEvent(events, event)
          threadId = events.threadId
          attempt.threadId = threadId
        }
      })()
      const timer = setTimeout(() => {
        attempt.timedOut = true
        killTree(child)
      }, remaining)
      const exitCode = await new Promise((resolve) => {
        child.once('error', (error) => {
          attempt.errors.push(error.message)
          resolve(-1)
        })
        child.once('close', (code) => resolve(code ?? -1))
        if (aborted) {
          attempt.cancelled = true
          killTree(child)
        }
        const input = index === 1
          ? promptText
          : `上次传输未完成。请基于会话上下文及下面重新提供的完整原始任务，重新输出完整最终答案，不拼接残片、不降模型或推理档位。\n\n${promptText}`
        child.stdin.end(input, 'utf8')
      })
      clearTimeout(timer)
      await eventTask
      await Promise.all([
        new Promise((resolve) => stdout.end(resolve)),
        new Promise((resolve) => stderr.end(resolve)),
      ])

      attempt.exitCode = exitCode
      attempt.completed = events.completed
      attempt.elapsedSec = Number(((Date.now() - attemptStarted) / 1000).toFixed(3))
      attempt.finishedAt = new Date().toISOString()
      attempt.transportInterrupted = /stream disconnected|Reconnecting|falling back from WebSockets/i.test(
        `${stderrText}\n${attempt.errors.join('\n')}\n${attempt.warnings.join('\n')}`,
      )
      const text = existsSync(attempt.finalFile) ? readFileSync(attempt.finalFile, 'utf8').trim() : ''
      attempt.finalChars = [...text].length
      attempt.finalChineseChars = chineseCharCount(text)
      attempt.effective = await verifyProvenance(threadId, attemptStarted, { codexHome: resolveCodexHome(options) })
      const assessment = assessFinal({
        exitCode,
        completed: events.completed,
        failed: events.failed,
        timedOut: attempt.timedOut,
        text,
        agentText: events.agentText,
        effective: attempt.effective,
        model: result.model,
        effort: result.effort,
        minChineseChars,
        marker,
        requireModelVerification,
      })
      attempt.modelVerified = assessment.modelVerified
      attempt.outputValid = assessment.outputValid
      result.attempts.push(attempt)
      result.errors.push(...attempt.errors)
      result.exitCode = exitCode
      result.log = attempt.log

      if (assessment.ok) {
        result.status = 'ok'
        result.finalText = text
        result.finalChars = [...text].length
        result.finalChineseChars = chineseCharCount(text)
        result.usage = events.usage
        result.threadId = threadId
        result.modelVerified = assessment.modelVerified
        writeFileSync(finalFile, `${text}\n`, 'utf8')
        break
      }
      if (!attempt.modelVerified) result.errors.push('effective_model_or_effort_unverified')
      if (!attempt.outputValid) result.errors.push('incomplete_or_invalid_final_output')
      if (aborted) {
        result.errors.push('cancelled')
        break
      }
      writeJsonFile(resultFile, { ...result, elapsedSec: Number(((Date.now() - startedAt) / 1000).toFixed(3)) })
      if (/usage limit|quota|rate.?limit|capacity|401|unauthorized|invalid.*config/i.test(`${attempt.errors.join(' ')} ${stderrText}`)) {
        break
      }
      if (attempt.timedOut) break
    }
    if (exec.signal) exec.signal.removeEventListener('abort', onAbort)
    if (result.status !== 'ok') {
      result.status = /usage limit|quota/i.test(result.errors.join(' ')) ? 'usage_limit' : 'failed'
    }
    result.quotaAfter = readQuotaSnapshot({ codexHome: resolveCodexHome(options) })
  } catch (error) {
    result.status = 'failed'
    result.exitCode ??= -1
    result.errors.push(error.message)
  }

  result.elapsedSec = Number(((Date.now() - startedAt) / 1000).toFixed(3))
  result.finishedAt = new Date().toISOString()
  result.transportInterrupted = result.attempts.some((attempt) => attempt.transportInterrupted)
  writeJsonFile(resultFile, result)
  writeFileSync(finalFile, result.finalText ? `${result.finalText}\n` : '', 'utf8')

  try {
    appendCallIndex(stateDir, {
      ts: result.finishedAt,
      callId: result.callId,
      label: result.label,
      status: result.status,
      model: result.model,
      effort: result.effort,
      transport: result.transport,
      sandbox: result.sandbox,
      elapsedSec: result.elapsedSec,
      finalChars: result.finalChars,
      modelVerified: result.modelVerified,
      attempts: result.attempts.length,
      promptSha256: result.promptSha256,
      quotaBefore: result.quotaBefore ? { primary: result.quotaBefore.primary?.usedPercent, weekly: result.quotaBefore.secondary?.usedPercent } : null,
      quotaAfter: result.quotaAfter ? { primary: result.quotaAfter.primary?.usedPercent, weekly: result.quotaAfter.secondary?.usedPercent } : null,
      callDir: result.callDir,
    })
    pruneCalls(stateDir, options.keepCalls ?? DEFAULTS.keepCalls)
  } catch {
    /* logging must never break a consultant call */
  }

  return result
}
