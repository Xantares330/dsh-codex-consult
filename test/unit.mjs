/**
 * Unit tests for the pure helpers (no DSH runtime, no network).
 * Run with: node test/unit.mjs
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  appendCallIndex,
  assemblePrompt,
  chineseCharCount,
  evaluateQuotaGuard,
  formatQuotaShort,
  normalizeQuota,
  pruneCalls,
  readCallIndex,
  readQuotaSnapshot,
  resolveCodexExecutable,
  sha256,
} from '../lib/core.mjs'
import { assessFinal, consumeEvent } from '../lib/runner.mjs'

let passed = 0

function test(name, fn) {
  fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

async function testAsync(name, fn) {
  await fn()
  passed += 1
  console.log(`ok ${passed} - ${name}`)
}

test('chineseCharCount counts only Han characters', () => {
  assert.equal(chineseCharCount('你好 abc 世界'), 4)
  assert.equal(chineseCharCount(''), 0)
})

test('normalizeQuota + formatQuotaShort', () => {
  const quota = normalizeQuota({
    primary: { used_percent: 15, window_minutes: 300, resets_at: 1 },
    secondary: { used_percent: 22, window_minutes: 10080, resets_at: 2 },
    credits: { has_credits: false, unlimited: false, balance: null },
  })
  assert.equal(quota.primary.usedPercent, 15)
  assert.equal(quota.secondary.windowMinutes, 10080)
  assert.equal(formatQuotaShort(quota), '5h 15% · weekly 22%')
  assert.equal(formatQuotaShort(null), 'quota unknown')
})

test('evaluateQuotaGuard', () => {
  assert.equal(evaluateQuotaGuard(null).ok, true)
  assert.equal(evaluateQuotaGuard({ primary: { usedPercent: 5 }, secondary: { usedPercent: 10 } }).ok, true)
  assert.equal(evaluateQuotaGuard({ primary: { usedPercent: 95 }, secondary: { usedPercent: 10 } }).ok, false)
  assert.equal(evaluateQuotaGuard({ primary: { usedPercent: 5 }, secondary: { usedPercent: 90 } }).ok, false)
})

test('assemblePrompt inlines evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshcc-prompt-'))
  try {
    writeFileSync(join(dir, 'a.txt'), 'alpha-evidence')
    const prompt = assemblePrompt({ baseDir: dir, promptText: 'hello', evidenceFiles: ['a.txt'] })
    assert.match(prompt.text, /^hello/)
    assert.match(prompt.text, /ATTACHED FILE/)
    assert.match(prompt.text, /alpha-evidence/)
    assert.ok(prompt.bytes > 0)
    assert.equal(prompt.sources.length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('assemblePrompt rejects missing / oversized evidence', () => {
  assert.throws(() => assemblePrompt({ baseDir: process.cwd(), evidenceFiles: ['/no/such/file'] }), /evidence_not_found/)
  const dir = mkdtempSync(join(tmpdir(), 'dshcc-prompt2-'))
  try {
    writeFileSync(join(dir, 'big.txt'), 'x'.repeat(64))
    assert.throws(() => assemblePrompt({ baseDir: dir, evidenceFiles: ['big.txt'], inlineEvidenceMaxBytes: 8 }), /evidence_too_large/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sha256', () => {
  assert.equal(sha256('abc').length, 64)
  assert.equal(sha256('abc'), sha256('abc'))
})

test('consumeEvent + assessFinal', () => {
  const state = { errors: [], warnings: [] }
  consumeEvent(state, { type: 'thread.started', thread_id: 'thread-1' })
  consumeEvent(state, { type: 'item.completed', item: { type: 'agent_message', text: 'ok' } })
  consumeEvent(state, { type: 'turn.completed', usage: { input_tokens: 1 } })
  assert.equal(state.threadId, 'thread-1')
  assert.equal(state.agentText, 'ok')
  assert.equal(state.completed, true)

  const good = assessFinal({
    exitCode: 0, completed: true, failed: false, timedOut: false, text: '好', agentText: '好',
    effective: { model: 'm', effort: 'high' }, model: 'm', effort: 'high', requireModelVerification: true,
  })
  assert.equal(good.modelVerified, true)
  assert.equal(good.ok, true)

  const unverified = assessFinal({
    exitCode: 0, completed: true, failed: false, timedOut: false, text: '好', agentText: '好',
    effective: { model: 'other', effort: 'high' }, model: 'm', effort: 'high', requireModelVerification: true,
  })
  assert.equal(unverified.modelVerified, false)
  assert.equal(unverified.ok, false)
})

await testAsync('readQuotaSnapshot reads the latest rollout tail', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshcc-quota-'))
  try {
    const day = join(dir, 'sessions', '2026', '10', '22')
    mkdirSync(day, { recursive: true })
    const event = {
      timestamp: '2026-10-22T07:00:00.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        rate_limits: {
          primary: { used_percent: 3, window_minutes: 300, resets_at: 1 },
          secondary: { used_percent: 22, window_minutes: 10080, resets_at: 2 },
        },
      },
    }
    writeFileSync(join(day, 'rollout-test.jsonl'), `${JSON.stringify(event)}\n`)
    const quota = readQuotaSnapshot({ codexHome: dir })
    assert.equal(quota.primary.usedPercent, 3)
    assert.equal(quota.secondary.usedPercent, 22)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('call index append/read/prune', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dshcc-index-'))
  try {
    appendCallIndex(dir, { ts: 't1', status: 'ok', model: 'm' })
    appendCallIndex(dir, { ts: 't2', status: 'ok', model: 'm' })
    const list = readCallIndex(dir, 1)
    assert.equal(list.length, 1)
    assert.equal(list[0].ts, 't2')
    mkdirSync(join(dir, 'calls', 'one'), { recursive: true })
    mkdirSync(join(dir, 'calls', 'two'), { recursive: true })
    assert.equal(pruneCalls(dir, 1), 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveCodexExecutable explicit missing path', () => {
  assert.throws(() => resolveCodexExecutable({ codexPath: '/definitely/not/here' }), /codex_not_found/)
})

console.log(`\n${passed} tests passed`)
