import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import type { ProviderConfig } from '../types.js'
import { logMock } from '../../../../tests/mocks/log.js'

mock.module('src/utils/log.ts', logMock)
mock.module('bun:bundle', () => ({ feature: () => false }))
mock.module('src/utils/settings/settings.js', () => ({
  getSettings_DEPRECATED: () => ({}),
  updateSettingsForSource: () => {},
}))

const TEST_PROVIDERS: ProviderConfig[] = [
  {
    id: 'cerebras',
    kind: 'openai-compat',
    baseUrl: 'https://api.cerebras.ai/v1',
    apiKeyEnv: 'CEREBRAS_API_KEY',
    compatRule: 'cerebras',
  },
  {
    id: 'groq',
    kind: 'openai-compat',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
    compatRule: 'groq',
  },
]

beforeEach(() => {
  // Clean OpenAI env vars before each test
  delete process.env['CLAUDE_CODE_USE_OPENAI']
  delete process.env['OPENAI_API_KEY']
  delete process.env['OPENAI_BASE_URL']
  delete process.env['ANTHROPIC_API_KEY']
  delete process.env['CEREBRAS_API_KEY']
  delete process.env['GROQ_API_KEY']
})

afterEach(() => {
  delete process.env['CLAUDE_CODE_USE_OPENAI']
  delete process.env['OPENAI_API_KEY']
  delete process.env['OPENAI_BASE_URL']
  delete process.env['ANTHROPIC_API_KEY']
})

describe('switchProvider', () => {
  test('switching to cerebras returns correct env vars', async () => {
    const { switchProvider } = await import('../switcher.js')
    const result = switchProvider('cerebras', TEST_PROVIDERS)
    expect(result.env['CLAUDE_CODE_USE_OPENAI']).toBe('1')
    expect(result.env['OPENAI_BASE_URL']).toBe('https://api.cerebras.ai/v1')
    expect(result.provider.id).toBe('cerebras')
  })

  test('switching to groq returns correct env vars', async () => {
    const { switchProvider } = await import('../switcher.js')
    const result = switchProvider('groq', TEST_PROVIDERS)
    expect(result.env['OPENAI_BASE_URL']).toBe('https://api.groq.com/openai/v1')
  })

  test('throws for non-existent provider id', async () => {
    const { switchProvider } = await import('../switcher.js')
    expect(() => switchProvider('nonexistent', TEST_PROVIDERS)).toThrow(
      'provider "nonexistent" not found',
    )
  })

  test('warns when provider API key env var is not set', async () => {
    const { switchProvider } = await import('../switcher.js')
    const result = switchProvider('cerebras', TEST_PROVIDERS)
    expect(result.warnings.length).toBeGreaterThan(0)
    expect(result.warnings[0]).toContain('CEREBRAS_API_KEY')
  })

  test('no warning when provider API key env var is set', async () => {
    process.env['GROQ_API_KEY'] = 'test-key'
    const { switchProvider } = await import('../switcher.js')
    const result = switchProvider('groq', TEST_PROVIDERS)
    expect(result.warnings).toHaveLength(0)
    delete process.env['GROQ_API_KEY']
  })

  test('does not mutate process.env', async () => {
    const { switchProvider } = await import('../switcher.js')
    const before = process.env['OPENAI_BASE_URL']
    switchProvider('cerebras', TEST_PROVIDERS)
    expect(process.env['OPENAI_BASE_URL']).toBe(before)
  })
})

describe('buildShellExportBlock', () => {
  test('produces correct shell export lines for cerebras', async () => {
    const { switchProvider, buildShellExportBlock } = await import(
      '../switcher.js'
    )
    const result = switchProvider('cerebras', TEST_PROVIDERS)
    const block = buildShellExportBlock(result)
    expect(block).toContain('export CLAUDE_CODE_USE_OPENAI=1')
    expect(block).toContain('export OPENAI_BASE_URL=https://api.cerebras.ai/v1')
    expect(block).toContain('export OPENAI_API_KEY=$CEREBRAS_API_KEY')
  })

  test('api key line uses variable reference not literal value', async () => {
    process.env['CEREBRAS_API_KEY'] = 'sk-secret-key'
    const { switchProvider, buildShellExportBlock } = await import(
      '../switcher.js'
    )
    const result = switchProvider('cerebras', TEST_PROVIDERS)
    const block = buildShellExportBlock(result)
    // Must NOT contain the literal key value
    expect(block).not.toContain('sk-secret-key')
    // Must use variable reference
    expect(block).toContain('$CEREBRAS_API_KEY')
    delete process.env['CEREBRAS_API_KEY']
  })

  test('when apiKey is set on provider, no OPENAI_API_KEY export is emitted (only a comment)', async () => {
    const { switchProvider, buildShellExportBlock } = await import(
      '../switcher.js'
    )
    const result = switchProvider('cerebras', [
      {
        id: 'cerebras',
        kind: 'openai-compat',
        baseUrl: 'https://api.cerebras.ai/v1',
        apiKey: 'cerebras-direct-key',
        compatRule: 'cerebras',
      },
    ])
    const block = buildShellExportBlock(result)
    // No literal export of OPENAI_API_KEY (only a comment was added).
    expect(block).not.toMatch(/^export OPENAI_API_KEY=/m)
    // The comment explaining where the key lives IS present.
    expect(block).toContain('read from ~/.claude/providers.json')
    // The literal key must never be echoed.
    expect(block).not.toContain('cerebras-direct-key')
  })
})
