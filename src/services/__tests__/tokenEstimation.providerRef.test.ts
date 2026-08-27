/**
 * Tests for cross-provider model refs ('providerId:modelId') in
 * countMessagesTokensWithAPI (src/services/tokenEstimation.ts).
 *
 * - anthropic-kind ref: countTokens goes to the provider's endpoint via the
 *   override client with the stripped modelId.
 * - non-anthropic ref (openai-compat etc.): no countTokens endpoint exists —
 *   skip the API call and use the local rough estimate.
 * - plain model string: legacy env-driven Anthropic path, unchanged.
 *
 * Mocks side-effecting leaves only (log/debug/analytics/auth). The Anthropic
 * client runs for real against a stubbed globalThis.fetch.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { logMock } from '../../../tests/mocks/log'
import { debugMock } from '../../../tests/mocks/debug'

mock.module('bun:bundle', () => ({ feature: () => false }))
mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/debug.ts', debugMock)
mock.module('src/services/analytics/index.js', () => ({
  logEvent: () => {},
  logEventAsync: async () => {},
  stripProtoFields: <V>(v: V) => v,
  attachAnalyticsSink: () => {},
  _resetForTesting: () => {},
}))

// MACRO is a build-time define (see scripts/dev.ts). Set it on globalThis so
// the bare `MACRO` identifier in src/utils/http.ts (getUserAgent) resolves.
;(globalThis as unknown as { MACRO: { VERSION: string } }).MACRO = {
  VERSION: 'test',
}

const ENV_KEYS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_GROK',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'DEEPSEEK_API_KEY',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_TEST_FIXTURES_ROOT',
  'VCR_RECORD',
] as const

// ── Full-suite pollution guards ─────────────────────────────────────────────
// mock.module is process-global and last-write-wins; collection order across
// files is not guaranteed. Two existing mocks break this file in a full-suite
// run (both pass in isolation):
//  1. src/utils/__tests__/tokens.test.ts dummies out the module under test
//     itself ('src/services/tokenEstimation.ts', countMessagesTokensWithAPI:
//     () => 0). Bypassed by importing the real module through a query-string
//     specifier, which Bun registers as a distinct module identity.
//  2. src/services/MagicDocs|SessionMemory/__tests__/prompts.test.ts mock
//     'src/utils/model/model.js' with a fixed getMainLoopModel that ignores
//     ANTHROPIC_MODEL. Countered by re-registering an env-driven model.js at
//     test time (beforeEach runs after all files have been collected, so this
//     registration wins) — the fresh module instance from (1) binds to it.
// The env-driven semantics below follow the MagicDocs mock's good-neighbor
// pattern so later files that lazily import model.js keep working.
// firstPartyNameToCanonical / getDefaultOpusModel are asserted on by
// model.test.ts / getDefaultOpusModel.test.ts in the same process, so their
// real semantics are inlined here (copied from the MagicDocs mock, which
// documents the same constraint — keep in sync with src/utils/model/model.ts).
function realFirstPartyNameToCanonical(name: string): string {
  name = name.toLowerCase()
  if (name.includes('claude-opus-4-7')) return 'claude-opus-4-7'
  if (name.includes('claude-opus-4-6')) return 'claude-opus-4-6'
  if (name.includes('claude-opus-4-5')) return 'claude-opus-4-5'
  if (name.includes('claude-opus-4-1')) return 'claude-opus-4-1'
  if (name.includes('claude-opus-4')) return 'claude-opus-4'
  if (name.includes('claude-sonnet-4-6')) return 'claude-sonnet-4-6'
  if (name.includes('claude-sonnet-4-5')) return 'claude-sonnet-4-5'
  if (name.includes('claude-sonnet-4')) return 'claude-sonnet-4'
  if (name.includes('claude-haiku-4-5')) return 'claude-haiku-4-5'
  if (name.includes('claude-3-7-sonnet')) return 'claude-3-7-sonnet'
  if (name.includes('claude-3-5-sonnet')) return 'claude-3-5-sonnet'
  if (name.includes('claude-3-5-haiku')) return 'claude-3-5-haiku'
  if (name.includes('claude-3-opus')) return 'claude-3-opus'
  if (name.includes('claude-3-sonnet')) return 'claude-3-sonnet'
  if (name.includes('claude-3-haiku')) return 'claude-3-haiku'
  const m = name.match(/(claude-(\d+-\d+-)?\w+)/)
  if (m && m[1]) return m[1]
  return name
}

function resolveDefaultOpusModelForTests(): string {
  if (process.env.CLAUDE_CODE_USE_OPENAI === '1') {
    if (process.env.OPENAI_DEFAULT_OPUS_MODEL)
      return process.env.OPENAI_DEFAULT_OPUS_MODEL
  }
  if (process.env.CLAUDE_CODE_USE_GEMINI === '1') {
    if (process.env.GEMINI_DEFAULT_OPUS_MODEL)
      return process.env.GEMINI_DEFAULT_OPUS_MODEL
  }
  if (process.env.ANTHROPIC_DEFAULT_OPUS_MODEL)
    return process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
  if (process.env.CLAUDE_CODE_USE_BEDROCK === '1')
    return 'us.anthropic.claude-opus-4-7-v1'
  if (process.env.CLAUDE_CODE_USE_VERTEX === '1') return 'claude-opus-4-7'
  if (process.env.CLAUDE_CODE_USE_FOUNDRY === '1') return 'claude-opus-4-7'
  return 'claude-opus-4-7'
}

function registerEnvDrivenModelMock(): void {
  mock.module('src/utils/model/model.js', () => ({
    getMainLoopModel: () => process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-7',
    getRuntimeMainLoopModel: () =>
      process.env.ANTHROPIC_MODEL ?? 'claude-opus-4-7',
    getSmallFastModel: () =>
      process.env.ANTHROPIC_SMALL_FAST_MODEL ?? 'claude-haiku-4-5',
    getUserSpecifiedModelSetting: () => undefined,
    getBestModel: () => 'claude-opus-4-7',
    getDefaultOpusModel: () => resolveDefaultOpusModelForTests(),
    getDefaultSonnetModel: () => 'claude-sonnet-4-5',
    getDefaultHaikuModel: () => 'claude-haiku-4-5',
    getDefaultMainLoopModelSetting: () => 'claude-opus-4-7',
    getDefaultMainLoopModel: () => 'claude-opus-4-7',
    firstPartyNameToCanonical: (n: string) => realFirstPartyNameToCanonical(n),
    getCanonicalName: (n: string) => n,
    getClaudeAiUserDefaultModelDescription: () => '',
    renderDefaultModelSetting: () => '',
    getOpusPricingSuffix: () => '',
    isOpus1mMergeEnabled: () => false,
    renderModelSetting: (s: string) => s,
    getPublicModelDisplayName: () => null,
    renderModelName: (n: string) => n,
    getPublicModelName: (n: string) => n,
    parseUserSpecifiedModel: (m: string) => m,
    resolveSkillModelOverride: () => undefined,
    isLegacyModelRemapEnabled: () => false,
    modelDisplayString: () => '',
    getMarketingNameForModel: () => undefined,
    normalizeModelStringForAPI: (m: string) => m,
    isNonCustomOpusModel: () => false,
  }))
}

// Non-literal specifier: Bun resolves the query string to a fresh instance of
// the real module, bypassing tokens.test.ts's plain-specifier mock. TS cannot
// type-check query imports, so cast back to the real module's type.
const REAL_TOKEN_ESTIMATION_SPEC = '../tokenEstimation.js?providerRef=real'
function importRealTokenEstimation() {
  return import(REAL_TOKEN_ESTIMATION_SPEC) as Promise<
    typeof import('../tokenEstimation.js')
  >
}

type Captured = {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

const savedEnv: Record<string, string | undefined> = {}
let tmpDir: string
let captured: Captured | null
let originalFetch: typeof globalThis.fetch

function installFetchStub(responseBody: Record<string, unknown>): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    const raw = init?.headers
    if (raw instanceof Headers) {
      raw.forEach((v, k) => {
        headers[k] = v
      })
    } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw as Record<string, string>)) {
        headers[k] = v
      }
    }
    captured = {
      url: String(input),
      headers,
      body:
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : {},
    }
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

beforeEach(async () => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
  tmpDir = mkdtempSync(join(tmpdir(), 'token-est-ref-test-'))
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  // withTokenCountVCR is active under bun test (NODE_ENV=test): record into a
  // throwaway fixtures dir so CI never hits the missing-fixture error.
  process.env.CLAUDE_CODE_TEST_FIXTURES_ROOT = tmpDir
  process.env.VCR_RECORD = '1'
  process.env.ANTHROPIC_API_KEY = 'sk-test'
  captured = null
  originalFetch = globalThis.fetch
  registerEnvDrivenModelMock()
  const { _invalidateProviderCache } = await import(
    '../providerRegistry/loader.js'
  )
  _invalidateProviderCache()
  const { clearAnthropicOverrideClientCache } = await import('../api/client.js')
  clearAnthropicOverrideClientCache()
})

afterEach(async () => {
  globalThis.fetch = originalFetch
  for (const key of ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(tmpDir, { recursive: true, force: true })
  const { _invalidateProviderCache } = await import(
    '../providerRegistry/loader.js'
  )
  _invalidateProviderCache()
  const { clearAnthropicOverrideClientCache } = await import('../api/client.js')
  clearAnthropicOverrideClientCache()
})

const MESSAGES = [{ role: 'user' as const, content: 'hello world' }]
// Note: withTokenCountVCR caches by message content — each test must use a
// distinct content string or it will replay another test's fixture.
const MESSAGES_NON_ANTHROPIC = [
  { role: 'user' as const, content: 'goodbye worlds' },
]
const MESSAGES_PLAIN = [{ role: 'user' as const, content: 'a plain model' }]

describe('countMessagesTokensWithAPI provider-ref routing', () => {
  test('anthropic-kind ref uses override client with stripped modelId', async () => {
    writeFileSync(
      join(tmpDir, 'providers.json'),
      JSON.stringify({
        version: 2,
        providers: [
          {
            id: 'my-anthropic',
            kind: 'anthropic',
            baseUrl: 'https://anthropic-override.example.com',
            apiKey: 'sk-override-key',
          },
        ],
      }),
    )
    process.env.ANTHROPIC_MODEL = 'my-anthropic:claude-sonnet-4-5'
    installFetchStub({ input_tokens: 42 })

    const { countMessagesTokensWithAPI } = await importRealTokenEstimation()
    const result = await countMessagesTokensWithAPI(MESSAGES, [])

    expect(result).toBe(42)
    expect(captured).not.toBeNull()
    expect(captured!.url).toContain('anthropic-override.example.com')
    expect(captured!.url).toContain('/v1/messages/count_tokens')
    expect(captured!.body.model).toBe('claude-sonnet-4-5')
    expect(captured!.headers['authorization']).toBe('Bearer sk-override-key')
    expect(captured!.headers['x-api-key']).toBeUndefined()
  })

  test('non-anthropic ref falls back to local estimation without API call', async () => {
    // Registry entry written by the test (no built-in providers anymore) —
    // an openai-compat provider is non-anthropic, so token counting must
    // stay local instead of probing the Anthropic count_tokens endpoint.
    writeFileSync(
      join(tmpDir, 'providers.json'),
      JSON.stringify({
        version: 2,
        providers: [
          {
            id: 'my-deepseek',
            kind: 'openai-compat',
            baseUrl: 'https://api.deepseek.com/v1',
            apiKey: 'sk-deepseek-test',
          },
        ],
      }),
    )
    process.env.ANTHROPIC_MODEL = 'my-deepseek:deepseek-chat'
    installFetchStub({ input_tokens: 42 })

    const { countMessagesTokensWithAPI } = await importRealTokenEstimation()
    const result = await countMessagesTokensWithAPI(MESSAGES_NON_ANTHROPIC, [])

    // roughTokenCountEstimation('goodbye worlds') = Math.round(14 / 4) = 4
    expect(result).toBe(4)
    expect(captured).toBeNull()
  })

  test('plain model string keeps the env-driven Anthropic path', async () => {
    process.env.ANTHROPIC_MODEL = 'claude-haiku-4-5'
    installFetchStub({ input_tokens: 7 })

    const { countMessagesTokensWithAPI } = await importRealTokenEstimation()
    const result = await countMessagesTokensWithAPI(MESSAGES_PLAIN, [])

    expect(result).toBe(7)
    expect(captured).not.toBeNull()
    expect(captured!.url).toContain('api.anthropic.com')
    expect(captured!.url).toContain('/v1/messages/count_tokens')
    expect(captured!.body.model).toBe('claude-haiku-4-5')
  })
})
