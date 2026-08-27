import { describe, expect, test } from 'bun:test'
import type { ProviderConfig } from '../../../services/providerRegistry/types.js'
import {
  buildModelRef,
  formatProviderRow,
  formatProvidersTable,
  isBuiltinProvider,
  parseCompatRule,
  parseProviderKind,
  validateBaseUrl,
  validateProviderId,
} from '../logic.js'

const BUILTIN: ProviderConfig[] = [
  {
    id: 'cerebras',
    kind: 'openai-compat',
    baseUrl: 'https://api.cerebras.ai/v1',
    apiKeyEnv: 'CEREBRAS_API_KEY',
    defaultModel: 'llama-3.3-70b',
    compatRule: 'cerebras',
  },
]

const CUSTOM: ProviderConfig = {
  id: 'my-openai',
  kind: 'openai-compat',
  baseUrl: 'https://my.example.com/v1',
  apiKey: 'sk-test',
  models: [{ id: 'm1' }, { id: 'm2' }],
  defaultModel: 'm1',
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
    expect(validateProviderId('cerebras', BUILTIN)).toBeTruthy()
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

describe('isBuiltinProvider', () => {
  test('returns true for built-in id', () => {
    expect(isBuiltinProvider(BUILTIN[0]!, BUILTIN)).toBe(true)
  })

  test('returns false for custom id', () => {
    expect(isBuiltinProvider(CUSTOM, BUILTIN)).toBe(false)
  })
})

describe('formatProviderRow', () => {
  test('formats builtin provider with 内置 badge', () => {
    const row = formatProviderRow(BUILTIN[0]!, BUILTIN)
    expect(row.id).toBe('cerebras')
    expect(row.builtinBadge).toBe('(内置)')
    expect(row.modelCount).toBe('0')
  })

  test('formats custom provider with key status', () => {
    const row = formatProviderRow(CUSTOM, BUILTIN)
    expect(row.id).toBe('my-openai')
    expect(row.keyStatus).toBe('有')
    expect(row.modelCount).toBe('2')
    expect(row.defaultModel).toBe('m1')
    expect(row.builtinBadge).toBe('')
  })

  test('formats custom provider without key as 无', () => {
    const noKey: ProviderConfig = { ...CUSTOM, apiKey: undefined }
    const row = formatProviderRow(noKey, BUILTIN)
    expect(row.keyStatus).toBe('无')
  })
})

describe('formatProvidersTable', () => {
  test('produces header + rows', () => {
    const table = formatProvidersTable([...BUILTIN, CUSTOM], BUILTIN)
    const lines = table.split('\n')
    expect(lines.length).toBe(1 + 2)
    expect(lines[0]).toContain('id')
    expect(lines[0]).toContain('kind')
    expect(lines[1]).toContain('cerebras')
    expect(lines[2]).toContain('my-openai')
  })

  test('marks builtin rows with 内置', () => {
    const table = formatProvidersTable([...BUILTIN, CUSTOM], BUILTIN)
    const lines = table.split('\n')
    expect(lines[1]).toContain('(内置)')
    expect(lines[2]).not.toContain('(内置)')
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
