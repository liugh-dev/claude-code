import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { _invalidateProviderCache } from 'src/services/providerRegistry/loader.js'
import type { ProviderConfig } from 'src/services/providerRegistry/types.js'
import {
  resetSettingsCache,
  setSessionSettingsCache,
} from 'src/utils/settings/settingsCache.js'
import { getModelOptions, getProviderModelOptions } from '../modelOptions.js'

const providerEnvKeys = [
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_GROK',
  'ANTHROPIC_CUSTOM_MODEL_OPTION',
] as const

const savedEnv: Record<string, string | undefined> = {}
let tmpDir = ''

function clearProviderEnv(): void {
  for (const key of providerEnvKeys) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }
}

function restoreProviderEnv(): void {
  for (const key of providerEnvKeys) {
    if (savedEnv[key] !== undefined) {
      process.env[key] = savedEnv[key]
    } else {
      delete process.env[key]
    }
  }
}

function resetSession(): void {
  resetSettingsCache()
  setSessionSettingsCache({ settings: {}, errors: [] })
  _invalidateProviderCache()
}

describe('getProviderModelOptions (pure)', () => {
  test('returns empty array for empty providers list', () => {
    expect(getProviderModelOptions([])).toEqual([])
  })

  test('skips providers without a models field', () => {
    const providers: ProviderConfig[] = [
      {
        id: 'cerebras',
        kind: 'openai-compat',
        baseUrl: 'https://api.cerebras.ai/v1',
      },
      {
        id: 'opencode-go',
        kind: 'openai-compat',
        baseUrl: 'https://api.opencode.ai/v1',
        models: [],
      },
    ]
    expect(getProviderModelOptions(providers)).toEqual([])
  })

  test('emits one option per model with value providerId:modelId', () => {
    const providers: ProviderConfig[] = [
      {
        id: 'opencode-go',
        kind: 'openai-compat',
        baseUrl: 'https://api.opencode.ai/v1',
        models: [{ id: 'glm-5.2' }, { id: 'kimi-k3' }],
      },
    ]
    const options = getProviderModelOptions(providers)
    expect(options.map(o => o.value)).toEqual([
      'opencode-go:glm-5.2',
      'opencode-go:kimi-k3',
    ])
  })

  test('label is prefixed with [providerId] and includes model id', () => {
    const options = getProviderModelOptions([
      {
        id: 'opencode-go',
        kind: 'openai-compat',
        baseUrl: 'https://api.opencode.ai/v1',
        models: [{ id: 'glm-5.2' }],
      },
    ])
    expect(options).toHaveLength(1)
    expect(options[0].label).toBe('[opencode-go] glm-5.2')
  })

  test('uses model.name and provider.name when provided', () => {
    const options = getProviderModelOptions([
      {
        id: 'my-gemini',
        kind: 'gemini',
        name: 'My Gemini Mirror',
        baseUrl: 'https://generativelanguage.googleapis.com',
        models: [{ id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' }],
      },
    ])
    expect(options).toHaveLength(1)
    expect(options[0].label).toBe('[my-gemini] Gemini 2.5 Pro')
    expect(options[0].description).toBe('My Gemini Mirror (gemini)')
    expect(options[0].descriptionForModel).toBe(
      'Gemini 2.5 Pro via My Gemini Mirror (my-gemini:gemini-2.5-pro)',
    )
  })

  test('emits one group per provider, multiple kinds supported', () => {
    const providers: ProviderConfig[] = [
      {
        id: 'openai-a',
        kind: 'openai-compat',
        baseUrl: 'https://a.example.com/v1',
        models: [{ id: 'gpt-x' }],
      },
      {
        id: 'grok-1',
        kind: 'grok',
        baseUrl: 'https://api.x.ai/v1',
        models: [{ id: 'grok-2-latest' }, { id: 'grok-3-mini' }],
      },
      {
        id: 'my-anthropic',
        kind: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        models: [{ id: 'claude-opus-4-6' }],
      },
    ]
    const options = getProviderModelOptions(providers)
    expect(options.map(o => o.value)).toEqual([
      'openai-a:gpt-x',
      'grok-1:grok-2-latest',
      'grok-1:grok-3-mini',
      'my-anthropic:claude-opus-4-6',
    ])
    expect(options[1].label.startsWith('[grok-1] ')).toBe(true)
    expect(options[3].description).toContain('anthropic')
  })
})

describe('getModelOptions provider grouping', () => {
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'modelOptions-providers-'))
    process.env['CLAUDE_CONFIG_DIR'] = tmpDir
    clearProviderEnv()
    resetSession()
  })

  afterEach(() => {
    restoreProviderEnv()
    delete process.env['CLAUDE_CONFIG_DIR']
    rmSync(tmpDir, { recursive: true, force: true })
    resetSession()
  })

  test('appends provider-grouped options when a provider has models', () => {
    writeFileSync(
      join(tmpDir, 'providers.json'),
      JSON.stringify({
        version: 2,
        providers: [
          {
            id: 'opencode-go',
            kind: 'openai-compat',
            baseUrl: 'https://api.opencode.ai/v1',
            name: 'OpenCode',
            models: [
              { id: 'glm-5.2', name: 'GLM 5.2' },
              { id: 'kimi-k3', name: 'Kimi K3' },
            ],
          },
        ],
      }),
    )
    resetSession()

    const options = getModelOptions()
    const opencodeGLM = options.find(o => o.value === 'opencode-go:glm-5.2')
    const opencodeKimi = options.find(o => o.value === 'opencode-go:kimi-k3')
    expect(opencodeGLM).toBeDefined()
    expect(opencodeGLM?.label).toBe('[opencode-go] GLM 5.2')
    expect(opencodeGLM?.description).toContain('OpenCode')
    expect(opencodeGLM?.description).toContain('openai-compat')
    expect(opencodeKimi).toBeDefined()
    expect(opencodeKimi?.label).toBe('[opencode-go] Kimi K3')
  })

  test('does not append provider-grouped options when no provider has models', () => {
    // No providers.json at all → only the 4 built-in defaults, none of
    // which carry a `models` list.
    resetSession()
    const options = getModelOptions()
    expect(options.some(o => o.label.startsWith('['))).toBe(false)
    expect(
      options.some(o => typeof o.value === 'string' && o.value.includes(':')),
    ).toBe(false)
  })

  test('does not append provider-grouped options when providers exist but none have models', () => {
    writeFileSync(
      join(tmpDir, 'providers.json'),
      JSON.stringify({
        version: 2,
        providers: [
          {
            id: 'my-anthropic',
            kind: 'anthropic',
            baseUrl: 'https://api.anthropic.com',
            // no models field
          },
        ],
      }),
    )
    resetSession()
    const options = getModelOptions()
    expect(options.some(o => o.label.startsWith('['))).toBe(false)
    expect(
      options.some(o => typeof o.value === 'string' && o.value.includes(':')),
    ).toBe(false)
  })
})
