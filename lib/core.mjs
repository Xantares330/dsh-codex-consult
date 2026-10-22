/**
 * dsh-codex-consult — pure helpers.
 *
 * Path resolution, Codex rollout provenance, quota snapshots, prompt
 * assembly and the durable call index. Everything here is independent of the
 * DSH runtime so it can be unit-tested with plain Node.js.
 */
import { spawnSync } from 'node:child_process'
import { createReadStream } from 'node:fs'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import readline from 'node:readline'

/** Plugin-level defaults. Profile config overrides merge over this object. */
export const DEFAULTS = Object.freeze({
  model: 'gpt-6-astra',
  effort: 'high',
  transport: 'native',
  sandbox: 'read-only',
  timeoutSec: 900,
  maxAttempts: 3,
  loadUserConfig: false,
  requireModelVerification: true,
  minChineseChars: 0,
  completionMarker: '',
  proxyUrl: '',
  inlineEvidenceMaxBytes: 262144,
  maxPromptBytes: 1048576,
  keepCalls: 100,
  quota: Object.freeze({ enabled: true, warnOnly: true, primaryMaxPercent: 90, weeklyMaxPercent: 85 }),
})

export function expandHome(value, home = homedir()) {
  if (!value) return value
  if (value === '~') return home
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(home, value.slice(2))
  return value
}

export function pad2(value) {
  return String(value).padStart(2, '0')
}

export function chineseCharCount(text) {
  return ((text || '').match(/\p{Script=Han}/gu) || []).length
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
  return dir
}

export function writeJsonFile(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temp, file)
}

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * Resolve the Codex CLI executable: explicit path > CODEX_CLI_PATH env >
 * newest version directory under %LOCALAPPDATA%\\OpenAI\\Codex\\bin > PATH.
 */
export function resolveCodexExecutable(options = {}, env = process.env, platform = process.platform) {
  const requested = expandHome(options.codexPath)
  if (requested) {
    if (!existsSync(requested)) throw new Error(`codex_not_found: ${requested}`)
    return requested
  }
  const candidates = []
  if (env.CODEX_CLI_PATH) candidates.push(expandHome(env.CODEX_CLI_PATH))
  if (platform === 'win32') {
    const base = join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin')
    if (existsSync(base)) {
      const entries = readdirSync(base, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(base, entry.name, 'codex.exe'))
        .filter((file) => existsSync(file))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
      candidates.push(...entries)
    }
  } else {
    const found = spawnSync('which', ['codex'], { encoding: 'utf8' })
    if (found.status === 0 && found.stdout.trim()) candidates.push(found.stdout.trim().split(/\r?\n/)[0])
  }
  for (const file of candidates.filter(Boolean)) {
    if (existsSync(file)) return file
  }
  throw new Error('codex_not_found: pass codexPath, set CODEX_CLI_PATH, or install the Codex CLI')
}

export function resolveCodexHome(options = {}, env = process.env) {
  const configured = options.codexHome ? expandHome(options.codexHome) : env.CODEX_HOME
  return configured ? resolvePath(configured) : join(homedir(), '.codex')
}

export function resolveStateDir(options = {}, env = process.env) {
  const configured = options.stateDir ? expandHome(options.stateDir) : env.DSH_CODEX_CONSULT_DIR
  if (configured) return resolvePath(configured)
  const dshHome = env.DSH_HOME ? resolvePath(expandHome(env.DSH_HOME)) : join(homedir(), '.dsh')
  return join(dshHome, 'codex-calls')
}

export function resolveWorkspace(options = {}) {
  const configured = options.workspace ? expandHome(options.workspace) : ''
  return configured ? resolvePath(configured) : process.cwd()
}

/** Read at most `maxBytes` from the tail of a file (Codex rollouts grow large). */
export function readTailText(file, maxBytes = 262144) {
  const size = statSync(file).size
  const length = Math.min(size, maxBytes)
  const buffer = Buffer.alloc(length)
  const fd = openSync(file, 'r')
  try {
    readSync(fd, buffer, 0, length, Math.max(0, size - length))
  } finally {
    closeSync(fd)
  }
  return buffer.toString('utf8')
}

function listCodexSessionFiles(dir, acc, depth) {
  if (depth > 5) return acc
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return acc
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      listCodexSessionFiles(full, acc, depth + 1)
    } else if (entry.name.endsWith('.jsonl')) {
      try {
        acc.push({ path: full, mtimeMs: statSync(full).mtimeMs })
      } catch {
        /* race with rotation: ignore */
      }
    }
  }
  return acc
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function normalizeQuotaWindow(window) {
  if (!window) return null
  return {
    usedPercent: numberOrNull(window.used_percent),
    windowMinutes: numberOrNull(window.window_minutes),
    resetsAt: window.resets_at ?? null,
  }
}

export function normalizeQuota(raw) {
  if (!raw) return null
  return {
    primary: normalizeQuotaWindow(raw.primary),
    secondary: normalizeQuotaWindow(raw.secondary),
    credits: raw.credits
      ? {
          hasCredits: Boolean(raw.credits.has_credits),
          unlimited: Boolean(raw.credits.unlimited),
          balance: raw.credits.balance ?? null,
        }
      : null,
  }
}

/**
 * Latest quota snapshot observed by the Codex CLI itself — read from the tail
 * of the newest rollout files so no extra network/API call is required.
 */
export function readQuotaSnapshot(options = {}) {
  const codexHome = options.codexHome || resolveCodexHome()
  const sessionsRoot = join(codexHome, 'sessions')
  if (!existsSync(sessionsRoot)) return null
  const files = listCodexSessionFiles(sessionsRoot, [], 0)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, options.maxFiles ?? 8)
  for (const file of files) {
    const lines = readTailText(file.path, options.tailBytes ?? 262144).split(/\r?\n/)
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index].trim()
      if (!line || !line.includes('"rate_limits"')) continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (event?.payload?.type !== 'token_count' || !event.payload.rate_limits) continue
      return {
        ...normalizeQuota(event.payload.rate_limits),
        sampledAt: event.timestamp || new Date(file.mtimeMs).toISOString(),
        source: file.path,
      }
    }
  }
  return null
}

/**
 * Locate the rollout file backing one Codex thread. Looks around the call day
 * (±1 day) so calls that cross midnight still resolve.
 */
export async function findSessionFile(threadId, startedAt = Date.now(), options = {}) {
  if (!threadId || !/^[0-9a-f-]{36}$/i.test(threadId)) return null
  const codexHome = options.codexHome || resolveCodexHome()
  for (const offset of [0, -86400000, 86400000]) {
    const date = new Date(startedAt + offset)
    const dir = join(codexHome, 'sessions', String(date.getFullYear()), pad2(date.getMonth() + 1), pad2(date.getDate()))
    if (!existsSync(dir)) continue
    const name = readdirSync(dir).find((entry) => entry.endsWith(`${threadId}.jsonl`))
    if (name) return join(dir, name)
  }
  return null
}

/**
 * Read-only provenance proof for the exact thread created by this call.
 * Verifies the *served* model/effort rather than trusting the request.
 */
export async function verifyProvenance(threadId, startedAt, options = {}) {
  const file = await findSessionFile(threadId, startedAt, options)
  if (!file) return null
  let proof = null
  const lines = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity })
  for await (const line of lines) {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (event.type === 'turn_context') {
      const payload = event.payload || {}
      proof = {
        model: payload.model ?? null,
        effort: payload.effort ?? payload.reasoning_effort ?? null,
        provider: payload.model_provider ?? null,
        source: file,
      }
    }
  }
  return proof
}

export function formatQuotaShort(quota) {
  if (!quota) return 'quota unknown'
  const primary = quota.primary?.usedPercent
  const weekly = quota.secondary?.usedPercent
  return `5h ${primary == null ? '?' : primary}% · weekly ${weekly == null ? '?' : weekly}%`
}

/**
 * Guard before expensive calls. Returns `{ ok, reason }`; `ok:false` means the
 * caller should either refuse or downgrade (see `quota.warnOnly`).
 */
export function evaluateQuotaGuard(quota, guard = {}) {
  if (!quota) return { ok: true, reason: 'quota_unknown' }
  const primaryMax = guard.primaryMaxPercent ?? DEFAULTS.quota.primaryMaxPercent
  const weeklyMax = guard.weeklyMaxPercent ?? DEFAULTS.quota.weeklyMaxPercent
  const primary = quota.primary?.usedPercent ?? 0
  const weekly = quota.secondary?.usedPercent ?? 0
  if (primary >= primaryMax) return { ok: false, reason: `primary_usage_${primary}%_gte_${primaryMax}%` }
  if (weekly >= weeklyMax) return { ok: false, reason: `weekly_usage_${weekly}%_gte_${weeklyMax}%` }
  return { ok: true, reason: 'ok' }
}

export function resolveInputPath(value, baseDir) {
  const expanded = expandHome(value)
  if (!expanded) return expanded
  return /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(expanded) ? resolvePath(expanded) : resolvePath(baseDir, expanded)
}

/**
 * Build the final consultant prompt: instruction text plus inlined evidence
 * files. Inlining is deliberate — Codex is treated as a pure reviewer, not as
 * an agent that re-reads the workspace with its own (possibly sandboxed) tools.
 */
export function assemblePrompt(options = {}) {
  const baseDir = options.baseDir || process.cwd()
  const maxPromptBytes = options.maxPromptBytes ?? DEFAULTS.maxPromptBytes
  const maxEvidenceBytes = options.inlineEvidenceMaxBytes ?? DEFAULTS.inlineEvidenceMaxBytes
  const parts = []
  const sources = []
  if (options.promptText && String(options.promptText).trim()) {
    parts.push(String(options.promptText).trim())
    sources.push({ kind: 'inline', name: 'prompt' })
  }
  if (options.promptFile) {
    const file = resolveInputPath(options.promptFile, baseDir)
    if (!existsSync(file)) throw new Error(`prompt_file_not_found: ${file}`)
    parts.push(readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim())
    sources.push({ kind: 'file', path: file })
  }
  for (const entry of options.evidenceFiles || []) {
    const file = resolveInputPath(entry, baseDir)
    if (!existsSync(file)) throw new Error(`evidence_not_found: ${file}`)
    const size = statSync(file).size
    if (size > maxEvidenceBytes) {
      throw new Error(`evidence_too_large: ${file} is ${size} bytes (limit ${maxEvidenceBytes})`)
    }
    const content = readFileSync(file, 'utf8')
    parts.push(`\n\n===== ATTACHED FILE: ${file} =====\n${content}\n===== END FILE: ${file} =====`)
    sources.push({ kind: 'file', path: file, bytes: size })
  }
  const text = parts.join('\n\n').trim()
  if (!text) throw new Error('empty_prompt: pass prompt, promptFile or evidenceFiles')
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > maxPromptBytes) throw new Error(`prompt_too_large: ${bytes} bytes (limit ${maxPromptBytes})`)
  return { text, sources, bytes }
}

export function createCallId(kind = 'consult') {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `codex-${kind}-${stamp}-${randomUUID().slice(0, 6)}`
}

export function appendCallIndex(stateDir, record) {
  ensureDir(stateDir)
  appendFileSync(join(stateDir, 'calls-index.jsonl'), `${JSON.stringify(record)}\n`, 'utf8')
}

export function readCallIndex(stateDir, limit = 20) {
  const file = join(stateDir, 'calls-index.jsonl')
  if (!existsSync(file)) return []
  const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
  const records = []
  for (const line of lines.slice(-Math.max(1, limit * 4))) {
    try {
      records.push(JSON.parse(line))
    } catch {
      /* ignore torn tail lines */
    }
  }
  return records.slice(-Math.max(1, limit)).reverse()
}

/** Keep the call log bounded; returns the number of pruned call directories. */
export function pruneCalls(stateDir, keepCalls = DEFAULTS.keepCalls) {
  const callsRoot = join(stateDir, 'calls')
  if (!existsSync(callsRoot) || !keepCalls || keepCalls < 1) return 0
  const dirs = readdirSync(callsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(callsRoot, entry.name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  let pruned = 0
  for (const dir of dirs.slice(keepCalls)) {
    try {
      rmSync(dir, { recursive: true, force: true })
      pruned += 1
    } catch {
      /* best effort */
    }
  }
  return pruned
}
