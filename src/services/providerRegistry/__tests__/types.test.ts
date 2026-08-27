import { describe, expect, test } from 'bun:test'
import {
  ProviderConfigSchema,
  ProvidersFileSchema,
  ProvidersFileV1Schema,
  resolveApiKey,
} from '../types.js'

describe('ProviderConfigSchema', () => {
  test('accepts all four provider kinds', () => {
    for (const kind of ['openai-compat', 'gemini', 'grok', 'anthropic']) {
      const result = ProviderConfigSchema.safeParse({
        id: 'test-provider',
        kind,
        baseUrl: 'https://api.example.com',
      })
      expect(result.success).toBe(true)
    }
  })

  test('rejects unknown kind', () => {
    const result = ProviderConfigSchema.safeParse({
      id: 'test-provider',
      kind: 'bedrock',
      baseUrl: 'https://api.example.com',
    })
    expect(result.success).toBe(false)
  })

  test('rejects non-kebab-case id', () => {
    const result = ProviderConfigSchema.safeParse({
      id: 'My_Provider',
      kind: 'openai-compat',
      baseUrl: 'https://api.example.com',
    })
    expect(result.success).toBe(false)
  })

  test('compatRule/models/apiKey/apiKeyEnv are optional', () => {
    const result = ProviderConfigSchema.safeParse({
      id: 'minimal',
      kind: 'openai-compat',
      baseUrl: 'https://api.example.com/v1',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.compatRule).toBeUndefined()
      expect(result.data.models).toBeUndefined()
      expect(result.data.apiKey).toBeUndefined()
      expect(result.data.apiKeyEnv).toBeUndefined()
    }
  })

  test('accepts full v2 fields', () => {
    const result = ProviderConfigSchema.safeParse({
      id: 'full',
      kind: 'openai-compat',
      name: 'Full Provider',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'sk-direct',
      apiKeyEnv: 'FULL_API_KEY',
      compatRule: 'permissive',
      models: [{ id: 'm1' }, { id: 'm2', name: 'Model 2' }],
      modelsFetchedAt: '2026-08-26T00:00:00.000Z',
    })
    expect(result.success).toBe(true)
  })
})

describe('ProvidersFileSchema / ProvidersFileV1Schema', () => {
  const entry = {
    id: 'p1',
    kind: 'openai-compat',
    baseUrl: 'https://api.example.com/v1',
  }

  test('v2 envelope parses', () => {
    const result = ProvidersFileSchema.safeParse({
      version: 2,
      providers: [entry],
    })
    expect(result.success).toBe(true)
  })

  test('v2 envelope rejects wrong version literal', () => {
    const result = ProvidersFileSchema.safeParse({
      version: 1,
      providers: [entry],
    })
    expect(result.success).toBe(false)
  })

  test('v1 bare array parses with v1 schema but not v2 schema', () => {
    expect(ProvidersFileV1Schema.safeParse([entry]).success).toBe(true)
    expect(ProvidersFileSchema.safeParse([entry]).success).toBe(false)
  })
})

describe('resolveApiKey', () => {
  test('prefers directly stored apiKey over apiKeyEnv', () => {
    process.env['TEST_RESOLVE_KEY'] = 'env-key'
    const key = resolveApiKey({
      id: 'p',
      kind: 'openai-compat',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'direct-key',
      apiKeyEnv: 'TEST_RESOLVE_KEY',
    })
    expect(key).toBe('direct-key')
    delete process.env['TEST_RESOLVE_KEY']
  })

  test('falls back to env var named by apiKeyEnv', () => {
    process.env['TEST_RESOLVE_KEY'] = 'env-key'
    const key = resolveApiKey({
      id: 'p',
      kind: 'openai-compat',
      baseUrl: 'https://api.example.com/v1',
      apiKeyEnv: 'TEST_RESOLVE_KEY',
    })
    expect(key).toBe('env-key')
    delete process.env['TEST_RESOLVE_KEY']
  })

  test('returns undefined when neither is available', () => {
    const key = resolveApiKey({
      id: 'p',
      kind: 'openai-compat',
      baseUrl: 'https://api.example.com/v1',
      apiKeyEnv: 'TEST_RESOLVE_KEY_UNSET',
    })
    expect(key).toBeUndefined()
  })
})
