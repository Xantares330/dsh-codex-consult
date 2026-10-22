/**
 * End-to-end smoke test with a fake DSH plugin context and a *real* Codex
 * call. Requires:
 *   - an installed + authenticated Codex CLI
 *   - network access (respects the configured proxy)
 *
 * Run with: node test/e2e.mjs
 */
import assert from 'node:assert/strict'

import { apply, name } from '../lib/index.mjs'

const registered = []
const ctx = {
  tools: {
    register(tool) {
      registered.push(tool)
    },
  },
}

apply(ctx, {
  model: process.env.DSH_CC_MODEL || 'gpt-6.1-sol',
  effort: 'low',
  transport: 'native',
  sandbox: 'read-only',
  timeoutSec: 180,
  keepCalls: 5,
  loadUserConfig: false,
  requireModelVerification: true,
  proxyUrl: process.env.DSH_CC_PROXY || 'http://127.0.0.1:7897',
  quota: { enabled: true, warnOnly: true, primaryMaxPercent: 90, weeklyMaxPercent: 85 },
})

console.log(`plugin ${name} registered ${registered.length} tools: ${registered.map((tool) => tool.name).join(', ')}`)
assert.equal(registered.length, 3)
assert.deepEqual(registered.map((tool) => tool.name).sort(), ['codex_calls', 'codex_consult', 'codex_quota'])

const quotaTool = registered.find((tool) => tool.name === 'codex_quota')
const consultTool = registered.find((tool) => tool.name === 'codex_consult')
const callsTool = registered.find((tool) => tool.name === 'codex_calls')

const quota = await quotaTool.execute({}, {})
console.log('codex_quota ->', JSON.stringify(quota))

const result = await consultTool.execute({
  prompt: '请只回复两个字符：OK',
  label: 'e2e-probe',
  minChineseChars: 0,
}, {})
console.log('codex_consult ->', JSON.stringify({
  status: result.status,
  model: result.model,
  effort: result.effort,
  modelVerified: result.modelVerified,
  elapsedSec: result.elapsedSec,
  finalText: result.finalText.slice(0, 120),
  quotaBefore: result.quotaBefore,
  quotaAfter: result.quotaAfter,
}))
assert.equal(result.status, 'ok')
assert.ok(result.finalText.length > 0)

const calls = await callsTool.execute({ limit: 5 }, {})
console.log('codex_calls ->', JSON.stringify(calls.calls.map((call) => ({ ts: call.ts, status: call.status, model: call.model }))))
assert.ok(calls.calls.length >= 1)

console.log('\ne2e ok')
