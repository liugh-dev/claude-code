import { describe, expect, test } from 'bun:test'
import type { ProviderConfig } from '../../../services/providerRegistry/types.js'
import {
  buildModelRef,
  formatProviderRow,
  formatProvidersTable,
  parseCompatRule,
  parseProviderKind,
  validateBaseUrl,
  validateProviderId,
} from '../logic.js'

const EXISTING: ProviderConfig[] = [
  {
    id: 'cerebras',
    kind: 'openai-compat',
    baseUrl: 'https://api.cerebras.ai/v1',
    apiKeyEnv: 'CEREBRAS_API_KEY',
    compatRule: 'cerebras',
  },
]

const CUSTOM: ProviderConfig = {
  id: 'my-openai',
  kind: 'openai-compat',
  baseUrl: 'https://my.example.com/v1',
  apiKey: 'sk-test',
  models: [{ id: 'm1' }, { id: 'm2' }],
}

describe('validateProviderId', () => {
  test('accepts kebab-case id', () => {
    expect(validateProviderId('my-provider-1', [])).toBeNull()
  })

  test('rejects empty id', () => {
    expect(validateProviderId('', [])).toBeTruthy()
  })

  test('rejects uppercase', () => {
    expect(validateProviderId('MyProvider', [])).toBeTruthy()
  })

  test('rejects underscore', () => {
    expect(validateProviderId('my_provider', [])).toBeTruthy()
  })

  test('rejects leading dash', () => {
    expect(validateProviderId('-lead', [])).toBeTruthy()
  })

  test('rejects trailing dash', () => {
    expect(validateProviderId('trail-', [])).toBeTruthy()
  })

  test('rejects duplicate id', () => {
    expect(validateProviderId('cerebras', EXISTING)).toBeTruthy()
  })
})

describe('validateBaseUrl', () => {
  test('accepts https URL', () => {
    expect(validateBaseUrl('https://api.example.com/v1')).toBeNull()
  })

  test('accepts http URL', () => {
    expect(validateBaseUrl('http://localhost:8080/v1')).toBeNull()
  })

  test('rejects empty', () => {
    expect(validateBaseUrl('')).toBeTruthy()
  })

  test('rejects non-URL', () => {
    expect(validateBaseUrl('not-a-url')).toBeTruthy()
  })

  test('rejects non-http scheme', () => {
    expect(validateBaseUrl('ftp://example.com')).toBeTruthy()
  })
})

describe('buildModelRef', () => {
  test('joins provider and model with colon', () => {
    expect(buildModelRef('openrouter', 'glm-5.2')).toBe('openrouter:glm-5.2')
  })
})

describe('formatProviderRow', () => {
  test('formats provider with env-var key as 有', () => {
    const row = formatProviderRow(EXISTING[0]!)
    expect(row.id).toBe('cerebras')
    expect(row.modelCount).toBe('0')
  })

  test('formats custom provider with key status', () => {
    const row = formatProviderRow(CUSTOM)
    expect(row.id).toBe('my-openai')
    expect(row.keyStatus).toBe('有')
    expect(row.modelCount).toBe('2')
  })

  test('formats custom provider without key as 无', () => {
    const noKey: ProviderConfig = { ...CUSTOM, apiKey: undefined }
    const row = formatProviderRow(noKey)
    expect(row.keyStatus).toBe('无')
  })
})

describe('formatProvidersTable', () => {
  test('produces header + rows', () => {
    const table = formatProvidersTable([...EXISTING, CUSTOM])
    const lines = table.split('\n')
    expect(lines.length).toBe(1 + 2)
    expect(lines[0]).toContain('id')
    expect(lines[0]).toContain('kind')
    expect(lines[1]).toContain('cerebras')
    expect(lines[2]).toContain('my-openai')
  })
})

describe('parseProviderKind', () => {
  test('accepts openai-compat', () => {
    expect(parseProviderKind('openai-compat')).toBe('openai-compat')
  })

  test('accepts gemini', () => {
    expect(parseProviderKind('gemini')).toBe('gemini')
  })

  test('rejects unknown kind', () => {
    expect(parseProviderKind('foo')).toBeNull()
  })
})

describe('parseCompatRule', () => {
  test('accepts permissive', () => {
    expect(parseCompatRule('permissive')).toBe('permissive')
  })

  test('accepts strict-openai', () => {
    expect(parseCompatRule('strict-openai')).toBe('strict-openai')
  })

  test('rejects unknown rule', () => {
    expect(parseCompatRule('unknown')).toBeNull()
  })
})
