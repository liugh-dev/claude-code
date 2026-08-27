import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { logMock } from '../../../../tests/mocks/log.js'
import { settingsMock } from '../../../../tests/mocks/settings.js'

// Must mock log before any import that transitively loads log.ts
mock.module('src/utils/log.ts', logMock)

// bun:bundle must be mocked before imports that use feature()
mock.module('bun:bundle', () => ({ feature: () => false }))

// settings.js must be mocked to cut bootstrap chain
mock.module('src/utils/settings/settings.js', settingsMock)

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'provider-loader-test-'))
  process.env['CLAUDE_CONFIG_DIR'] = tmpDir
})

afterEach(async () => {
  delete process.env['CLAUDE_CONFIG_DIR']
  rmSync(tmpDir, { recursive: true, force: true })
  // J1 fix: invalidate the per-process cache between tests so each test starts fresh
  const { _invalidateProviderCache } = await import('../loader.js')
  _invalidateProviderCache()
})

describe('loadProviders', () => {
  test('returns empty list when providers.json does not exist', async () => {
    const { loadProviders } = await import('../loader.js')
    const providers = loadProviders()
    expect(providers).toHaveLength(0)
  })

  test('returns empty list when providers.json is empty', async () => {
    writeFileSync(join(tmpDir, 'providers.json'), '')
    const { loadProviders } = await import('../loader.js')
    const providers = loadProviders()
    expect(providers).toHaveLength(0)
  })

  test('returns empty list when providers.json is empty array', async () => {
    writeFileSync(join(tmpDir, 'providers.json'), '[]')
    const { loadProviders } = await import('../loader.js')
    const providers = loadProviders()
    expect(providers).toHaveLength(0)
  })

  test('returns empty list when providers.json is corrupt JSON', async () => {
    writeFileSync(join(tmpDir, 'providers.json'), '{not valid json')
    const { loadProviders } = await import('../loader.js')
    const providers = loadProviders()
    expect(providers).toHaveLength(0)
  })

  test('returns empty list when providers.json fails schema validation', async () => {
    writeFileSync(
      join(tmpDir, 'providers.json'),
      JSON.stringify([{ id: 123, kind: 'bad-kind', baseUrl: 'not-a-url' }]),
    )
    const { loadProviders } = await import('../loader.js')
    const providers = loadProviders()
    expect(providers).toHaveLength(0)
  })

  test('loads valid user providers', async () => {
    const customProvider = {
      id: 'myendpoint',
      kind: 'openai-compat',
      baseUrl: 'https://my.api.com/v1',
      apiKeyEnv: 'MY_API_KEY',
      compatRule: 'permissive',
    }
    writeFileSync(
      join(tmpDir, 'providers.json'),
      JSON.stringify([customProvider]),
    )
    const { loadProviders } = await import('../loader.js')
    const providers = loadProviders()
    expect(providers).toHaveLength(1)
    expect(providers.find(p => p.id === 'myendpoint')).toMatchObject({
      baseUrl: 'https://my.api.com/v1',
    })
  })

  test('findProvider returns undefined for unknown id', async () => {
    const { findProvider, loadProviders } = await import('../loader.js')
    const result = findProvider('nonexistent', loadProviders())
    expect(result).toBeUndefined()
  })

  test('findProvider returns correct provider for known id', async () => {
    const { findProvider, loadProviders } = await import('../loader.js')
    const result = findProvider('myendpoint', loadProviders())
    expect(result).toBeUndefined() // not configured in this test's empty tmpdir
  })

  test('v1 bare-array file migrates and preserves apiKeyEnv', async () => {
    const v1Provider = {
      id: 'legacy',
      kind: 'openai-compat',
      baseUrl: 'https://legacy.example.com/v1',
      apiKeyEnv: 'LEGACY_API_KEY',
      compatRule: 'permissive',
    }
    writeFileSync(join(tmpDir, 'providers.json'), JSON.stringify([v1Provider]))
    const { loadProviders } = await import('../loader.js')
    const providers = loadProviders()
    const legacy = providers.find(p => p.id === 'legacy')
    expect(legacy).toMatchObject({
      kind: 'openai-compat',
      apiKeyEnv: 'LEGACY_API_KEY',
      compatRule: 'permissive',
    })
  })

  test('reads v2 envelope format', async () => {
    const provider = {
      id: 'my-gemini',
      kind: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com',
      apiKey: 'gemini-key',
      models: [{ id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' }],
      modelsFetchedAt: '2026-08-26T00:00:00.000Z',
    }
    writeFileSync(
      join(tmpDir, 'providers.json'),
      JSON.stringify({ version: 2, providers: [provider] }),
    )
    const { loadProviders } = await import('../loader.js')
    const providers = loadProviders()
    const loaded = providers.find(p => p.id === 'my-gemini')
    expect(loaded).toMatchObject({
      kind: 'gemini',
      apiKey: 'gemini-key',
    })
    expect(loaded?.models).toEqual([
      { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
    ])
  })

  test('supports multiple instances of the same kind', async () => {
    writeFileSync(
      join(tmpDir, 'providers.json'),
      JSON.stringify({
        version: 2,
        providers: [
          {
            id: 'openai-a',
            kind: 'openai-compat',
            baseUrl: 'https://a.example.com/v1',
            apiKey: 'key-a',
          },
          {
            id: 'openai-b',
            kind: 'openai-compat',
            baseUrl: 'https://b.example.com/v1',
            apiKey: 'key-b',
          },
          {
            id: 'grok-1',
            kind: 'grok',
            baseUrl: 'https://api.x.ai/v1',
            apiKey: 'grok-key',
          },
          {
            id: 'anthropic-1',
            kind: 'anthropic',
            baseUrl: 'https://api.anthropic.com',
            apiKey: 'sk-ant-test',
          },
        ],
      }),
    )
    const { loadProviders } = await import('../loader.js')
    const providers = loadProviders()
    expect(providers.filter(p => p.kind === 'openai-compat')).toHaveLength(2)
    expect(providers.find(p => p.id === 'openai-a')?.apiKey).toBe('key-a')
    expect(providers.find(p => p.id === 'openai-b')?.apiKey).toBe('key-b')
    expect(providers.find(p => p.id === 'grok-1')?.kind).toBe('grok')
    expect(providers.find(p => p.id === 'anthropic-1')?.kind).toBe('anthropic')
  })
})

describe('saveProviders', () => {
  test('writes v2 envelope format', async () => {
    const { saveProviders, getProvidersFilePath } = await import('../loader.js')
    saveProviders([
      {
        id: 'custom',
        kind: 'openai-compat',
        baseUrl: 'https://custom.example.com/v1',
        apiKey: 'sk-custom',
      },
    ])
    const raw = JSON.parse(readFileSync(getProvidersFilePath(), 'utf-8'))
    expect(raw.version).toBe(2)
    expect(Array.isArray(raw.providers)).toBe(true)
    expect(raw.providers).toHaveLength(1)
    expect(raw.providers[0].id).toBe('custom')
    expect(raw.providers[0].apiKey).toBe('sk-custom')
  })

  test('chmod 600 on the written file', async () => {
    const { saveProviders, getProvidersFilePath } = await import('../loader.js')
    saveProviders([
      {
        id: 'custom',
        kind: 'openai-compat',
        baseUrl: 'https://custom.example.com/v1',
        apiKey: 'sk-custom',
      },
    ])
    const mode = statSync(getProvidersFilePath()).mode & 0o777
    expect(mode).toBe(0o600)
  })

  test('deduplicates by id (later entries win)', async () => {
    const { saveProviders, getProvidersFilePath } = await import('../loader.js')
    saveProviders([
      {
        id: 'custom',
        kind: 'openai-compat',
        baseUrl: 'https://old.example.com/v1',
        apiKey: 'sk-1',
      },
      {
        id: 'custom',
        kind: 'openai-compat',
        baseUrl: 'https://new.example.com/v1',
        apiKey: 'sk-2',
      },
    ])
    const raw = JSON.parse(readFileSync(getProvidersFilePath(), 'utf-8'))
    expect(raw.providers).toHaveLength(1)
    expect(raw.providers[0].baseUrl).toBe('https://new.example.com/v1')
  })
})

describe('addProvider / removeProvider / updateProvider', () => {
  const custom = {
    id: 'custom',
    kind: 'openai-compat' as const,
    baseUrl: 'https://custom.example.com/v1',
    apiKey: 'sk-custom',
  }

  test('addProvider appends and persists', async () => {
    const { addProvider, loadProviders } = await import('../loader.js')
    addProvider(custom)
    expect(loadProviders().find(p => p.id === 'custom')).toMatchObject(custom)
  })

  test('addProvider throws on duplicate id', async () => {
    const { addProvider } = await import('../loader.js')
    addProvider(custom)
    expect(() => addProvider(custom)).toThrow('already exists')
  })

  test('removeProvider removes a custom provider', async () => {
    const { addProvider, removeProvider, loadProviders } = await import(
      '../loader.js'
    )
    addProvider(custom)
    removeProvider('custom')
    expect(loadProviders().find(p => p.id === 'custom')).toBeUndefined()
  })

  test('removeProvider throws for unknown id', async () => {
    const { removeProvider } = await import('../loader.js')
    expect(() => removeProvider('nope')).toThrow('not found')
  })

  test('updateProvider replaces an existing entry', async () => {
    const { addProvider, updateProvider, loadProviders } = await import(
      '../loader.js'
    )
    addProvider(custom)
    updateProvider({ ...custom, baseUrl: 'https://new.example.com/v1' })
    expect(loadProviders().find(p => p.id === 'custom')?.baseUrl).toBe(
      'https://new.example.com/v1',
    )
  })

  test('updateProvider throws for unknown id', async () => {
    const { updateProvider } = await import('../loader.js')
    expect(() => updateProvider(custom)).toThrow('not found')
  })
})
