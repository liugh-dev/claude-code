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
import { _invalidateProviderCache } from '../loader.js'
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

  // Run registry-backed tests in an isolated config dir so we control
  // whether providers.json exists and what env vars are set.
  function withIsolatedRegistry<T>(fn: () => T): T {
    const dir = mkdtempSync(join(tmpdir(), 'modelref-registry-test-'))
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

  test('falls back to loadProviders() when no list is passed', () => {
    withIsolatedRegistry(() => {
      writeFileSync(
        join(process.env['CLAUDE_CONFIG_DIR']!, 'providers.json'),
        JSON.stringify({
          version: 2,
          providers: [
            {
              id: 'my-deepseek',
              kind: 'openai-compat',
              baseUrl: 'https://api.deepseek.com/v1',
              apiKey: 'sk-deepseek',
            },
          ],
        }),
      )
      _invalidateProviderCache()
      const resolved = resolveModelRef('my-deepseek:deepseek-chat')
      expect(resolved?.provider.id).toBe('my-deepseek')
      expect(resolved?.modelId).toBe('deepseek-chat')
      expect(resolveModelRef('not-configured:some-model')).toBeNull()
    })
  })
})
