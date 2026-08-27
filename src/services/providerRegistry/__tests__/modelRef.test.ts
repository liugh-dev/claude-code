import { describe, test, expect, mock } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { logMock } from '../../../../tests/mocks/log.js'

// Must mock log before any import that transitively loads log.ts
mock.module('src/utils/log.ts', logMock)
mock.module('bun:bundle', () => ({ feature: () => false }))
mock.module('src/utils/settings/settings.js', () => ({
  getSettings_DEPRECATED: () => ({}),
  updateSettingsForSource: () => {},
}))

import { parseModelRef, resolveModelRef } from '../modelRef.js'
import { _invalidateProviderCache, loadUserProviders } from '../loader.js'
import type { ProviderConfig } from '../types.js'

const USER_PROVIDERS: ProviderConfig[] = [
  {
    id: 'opencode-go',
    kind: 'openai-compat',
    baseUrl: 'https://opencode.example.com/v1',
    apiKey: 'sk-ocg',
  },
  {
    id: 'my-gemini',
    kind: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com',
    apiKey: 'gemini-key',
  },
]

describe('parseModelRef', () => {
  test('splits provider:model at the first colon', () => {
    expect(parseModelRef('opencode-go:glm-5.2')).toEqual({
      providerId: 'opencode-go',
      modelId: 'glm-5.2',
    })
  })

  test('modelId keeps any further colons', () => {
    expect(parseModelRef('my-gemini:gemini-2.5-pro:beta')).toEqual({
      providerId: 'my-gemini',
      modelId: 'gemini-2.5-pro:beta',
    })
  })

  test('returns null when there is no colon', () => {
    expect(parseModelRef('claude-opus-4-1')).toBeNull()
  })

  test('returns null when providerId or modelId is empty', () => {
    expect(parseModelRef(':model')).toBeNull()
    expect(parseModelRef('provider:')).toBeNull()
    expect(parseModelRef(':')).toBeNull()
  })

  test('parses Bedrock ARN syntactically (registry check rejects it)', () => {
    const parsed = parseModelRef(
      'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-v2',
    )
    expect(parsed).toEqual({
      providerId: 'arn',
      modelId: 'aws:bedrock:us-east-1::foundation-model/anthropic.claude-v2',
    })
  })
})

describe('resolveModelRef', () => {
  test('resolves a user-defined provider id (no built-in match)', () => {
    const resolved = resolveModelRef('opencode-go:glm-5.2', USER_PROVIDERS)
    expect(resolved).not.toBeNull()
    expect(resolved?.provider.id).toBe('opencode-go')
    expect(resolved?.modelId).toBe('glm-5.2')
  })

  test('returns null for plain model names', () => {
    expect(resolveModelRef('claude-sonnet-4-5', USER_PROVIDERS)).toBeNull()
  })

  test('returns null when providerId is not configured (Bedrock ARN guard)', () => {
    const arn =
      'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-v2'
    expect(resolveModelRef(arn, USER_PROVIDERS)).toBeNull()
  })

  test('returns null for unknown provider prefix', () => {
    expect(
      resolveModelRef('not-configured:some-model', USER_PROVIDERS),
    ).toBeNull()
  })

  // ── Built-in default provider safety gate ─────────────────────────────────

  // Run built-in-default tests in an isolated config dir so we control
  // whether providers.json exists and what env vars are set.
  function withIsolatedRegistry<T>(fn: () => T): T {
    const dir = mkdtempSync(join(tmpdir(), 'modelref-builtin-test-'))
    const prev = process.env['CLAUDE_CONFIG_DIR']
    process.env['CLAUDE_CONFIG_DIR'] = dir
    _invalidateProviderCache()
    try {
      return fn()
    } finally {
      if (prev === undefined) delete process.env['CLAUDE_CONFIG_DIR']
      else process.env['CLAUDE_CONFIG_DIR'] = prev
      _invalidateProviderCache()
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test('built-in default id is inert when no providers.json and no env credentials', () => {
    withIsolatedRegistry(() => {
      const saved: Record<string, string | undefined> = {}
      for (const k of [
        'CEREBRAS_API_KEY',
        'GROQ_API_KEY',
        'DASHSCOPE_API_KEY',
        'DEEPSEEK_API_KEY',
      ]) {
        saved[k] = process.env[k]
        delete process.env[k]
      }
      try {
        // No user override → built-in defaults are visible but unauthenticated.
        expect(loadUserProviders()).toHaveLength(0)
        expect(resolveModelRef('qwen:7b')).toBeNull()
        expect(resolveModelRef('cerebras:llama-3.3-70b')).toBeNull()
        expect(resolveModelRef('groq:llama-3.3-70b-versatile')).toBeNull()
        expect(resolveModelRef('deepseek:deepseek-chat')).toBeNull()
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k]
          else process.env[k] = v
        }
      }
    })
  })

  test('built-in default id hits when matching env credential is set', () => {
    withIsolatedRegistry(() => {
      const saved: Record<string, string | undefined> = {}
      for (const k of [
        'CEREBRAS_API_KEY',
        'GROQ_API_KEY',
        'DASHSCOPE_API_KEY',
        'DEEPSEEK_API_KEY',
      ]) {
        saved[k] = process.env[k]
        delete process.env[k]
      }
      try {
        process.env['DASHSCOPE_API_KEY'] = 'sk-dashscope'
        const resolved = resolveModelRef('qwen:qwen-max')
        expect(resolved?.provider.id).toBe('qwen')
        expect(resolved?.provider.baseUrl).toBe(
          'https://dashscope.aliyuncs.com/compatible-mode/v1',
        )
        expect(resolved?.modelId).toBe('qwen-max')
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k]
          else process.env[k] = v
        }
      }
    })
  })

  test('built-in default id hits when user overrides it in providers.json', () => {
    withIsolatedRegistry(() => {
      const saved: Record<string, string | undefined> = {}
      for (const k of [
        'CEREBRAS_API_KEY',
        'GROQ_API_KEY',
        'DASHSCOPE_API_KEY',
        'DEEPSEEK_API_KEY',
      ]) {
        saved[k] = process.env[k]
        delete process.env[k]
      }
      // Write an explicit user override for cerebras (no env credentials set)
      writeFileSync(
        join(process.env['CLAUDE_CONFIG_DIR']!, 'providers.json'),
        JSON.stringify({
          version: 2,
          providers: [
            {
              id: 'cerebras',
              kind: 'openai-compat',
              baseUrl: 'https://custom-cerebras.example.com/v1',
              apiKey: 'cerebras-direct-key',
              defaultModel: 'custom-llama',
              compatRule: 'cerebras',
            },
          ],
        }),
      )
      try {
        // User override seeds both caches.
        expect(loadUserProviders().map(p => p.id)).toContain('cerebras')
        const resolved = resolveModelRef('cerebras:custom-llama')
        expect(resolved?.provider.id).toBe('cerebras')
        expect(resolved?.provider.baseUrl).toBe(
          'https://custom-cerebras.example.com/v1',
        )
        expect(resolved?.modelId).toBe('custom-llama')
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k]
          else process.env[k] = v
        }
      }
    })
  })

  test('user-defined id hits even without resolvable credentials (explicit opt-in)', () => {
    withIsolatedRegistry(() => {
      const saved: Record<string, string | undefined> = {}
      for (const k of [
        'CEREBRAS_API_KEY',
        'GROQ_API_KEY',
        'DASHSCOPE_API_KEY',
        'DEEPSEEK_API_KEY',
      ]) {
        saved[k] = process.env[k]
        delete process.env[k]
      }
      // User explicitly configures a custom id with no apiKey/apiKeyEnv. We
      // still hit because the user opted in; the actual request will 401
      // later, which is the user's choice.
      writeFileSync(
        join(process.env['CLAUDE_CONFIG_DIR']!, 'providers.json'),
        JSON.stringify({
          version: 2,
          providers: [
            {
              id: 'my-openai',
              kind: 'openai-compat',
              baseUrl: 'https://my-openai.example.com/v1',
              defaultModel: 'gpt-5',
            },
          ],
        }),
      )
      try {
        const resolved = resolveModelRef('my-openai:gpt-5')
        expect(resolved?.provider.id).toBe('my-openai')
        expect(resolved?.modelId).toBe('gpt-5')
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k]
          else process.env[k] = v
        }
      }
    })
  })

  test('built-in default id stays inert when env credential belongs to a DIFFERENT default', () => {
    withIsolatedRegistry(() => {
      const saved: Record<string, string | undefined> = {}
      for (const k of [
        'CEREBRAS_API_KEY',
        'GROQ_API_KEY',
        'DASHSCOPE_API_KEY',
        'DEEPSEEK_API_KEY',
      ]) {
        saved[k] = process.env[k]
        delete process.env[k]
      }
      try {
        // Only CEREBRAS_API_KEY is set, but user typed `qwen:...`.
        process.env['CEREBRAS_API_KEY'] = 'sk-cerebras'
        expect(resolveModelRef('qwen:7b')).toBeNull()
        expect(resolveModelRef('cerebras:llama-3.3-70b')).not.toBeNull()
      } finally {
        for (const [k, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[k]
          else process.env[k] = v
        }
      }
    })
  })

  test('falls back to loadProviders() when no list is passed', () => {
    withIsolatedRegistry(() => {
      const saved = process.env['DEEPSEEK_API_KEY']
      process.env['DEEPSEEK_API_KEY'] = 'sk-deepseek'
      try {
        const resolved = resolveModelRef('deepseek:deepseek-chat')
        expect(resolved?.provider.id).toBe('deepseek')
        expect(resolved?.modelId).toBe('deepseek-chat')
        expect(resolveModelRef('not-configured:some-model')).toBeNull()
      } finally {
        if (saved === undefined) delete process.env['DEEPSEEK_API_KEY']
        else process.env['DEEPSEEK_API_KEY'] = saved
      }
    })
  })
})
