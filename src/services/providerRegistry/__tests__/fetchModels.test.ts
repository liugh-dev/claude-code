import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { logMock } from '../../../../tests/mocks/log.js'
import { debugMock } from '../../../../tests/mocks/debug.js'

// Mock side-effectful modules before any import that transitively loads them
mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/debug.ts', debugMock)
mock.module('bun:bundle', () => ({ feature: () => false }))
mock.module('src/utils/settings/settings.js', () => ({
  getSettings_DEPRECATED: () => ({}),
  updateSettingsForSource: () => {},
}))

import { buildModelsUrl, fetchProviderModels } from '../fetchModels.js'
import type { ProviderConfig } from '../types.js'

const OPENAI_PROVIDER: ProviderConfig = {
  id: 'openai-a',
  kind: 'openai-compat',
  baseUrl: 'https://a.example.com/v1',
  apiKey: 'sk-openai-a',
}

const GROK_PROVIDER: ProviderConfig = {
  id: 'grok-1',
  kind: 'grok',
  baseUrl: 'https://api.x.ai/v1',
  apiKey: 'grok-key',
}

const GEMINI_PROVIDER: ProviderConfig = {
  id: 'my-gemini',
  kind: 'gemini',
  baseUrl: 'https://generativelanguage.googleapis.com',
  apiKey: 'gemini-key',
}

const ANTHROPIC_PROVIDER: ProviderConfig = {
  id: 'anthropic-1',
  kind: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  apiKey: 'sk-ant-test',
}

type FetchArgs = [url: string, init?: Record<string, unknown>]

let originalFetch: typeof fetch
let fetchCalls: FetchArgs[]

function stubFetch(response: Response): void {
  fetchCalls = []
  const stub = async (
    url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    fetchCalls.push([String(url), init as Record<string, unknown>])
    return response
  }
  globalThis.fetch = stub as unknown as typeof fetch
}

function lastCall(): FetchArgs {
  const call = fetchCalls[fetchCalls.length - 1]
  if (!call) throw new Error('fetch was not called')
  return call
}

beforeEach(() => {
  originalFetch = globalThis.fetch
  fetchCalls = []
  // Deterministic proxy behavior regardless of the host shell env
  delete process.env['https_proxy']
  delete process.env['HTTPS_PROXY']
  delete process.env['http_proxy']
  delete process.env['HTTP_PROXY']
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('buildModelsUrl', () => {
  test('openai-compat uses {baseUrl}/models', () => {
    expect(buildModelsUrl(OPENAI_PROVIDER)).toBe(
      'https://a.example.com/v1/models',
    )
  })

  test('grok uses {baseUrl}/models', () => {
    expect(buildModelsUrl(GROK_PROVIDER)).toBe('https://api.x.ai/v1/models')
  })

  test('gemini uses {baseUrl}/v1beta/models', () => {
    expect(buildModelsUrl(GEMINI_PROVIDER)).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models',
    )
  })

  test('anthropic uses {baseUrl}/v1/models', () => {
    expect(buildModelsUrl(ANTHROPIC_PROVIDER)).toBe(
      'https://api.anthropic.com/v1/models',
    )
  })

  test('trailing slashes on baseUrl do not produce double slashes', () => {
    expect(
      buildModelsUrl({
        ...OPENAI_PROVIDER,
        baseUrl: 'https://a.example.com/v1/',
      }),
    ).toBe('https://a.example.com/v1/models')
  })

  test('anthropic: baseUrl already ending in /v1 does not produce /v1/v1/models', () => {
    expect(
      buildModelsUrl({
        ...ANTHROPIC_PROVIDER,
        baseUrl: 'https://proxy.anthropic.com/v1',
      }),
    ).toBe('https://proxy.anthropic.com/v1/models')
  })

  test('gemini: baseUrl already ending in /v1beta is used as-is', () => {
    expect(
      buildModelsUrl({
        ...GEMINI_PROVIDER,
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      }),
    ).toBe('https://generativelanguage.googleapis.com/v1beta/models')
  })

  test('gemini: baseUrl ending in /v2beta is used as-is (not just /v1beta)', () => {
    expect(
      buildModelsUrl({
        ...GEMINI_PROVIDER,
        baseUrl: 'https://generativelanguage.googleapis.com/v2beta',
      }),
    ).toBe('https://generativelanguage.googleapis.com/v2beta/models')
  })

  test('openai-compat: baseUrl ending in /v1 still appends /models without doubling', () => {
    // openai-compat always uses /models without a version prefix; this is a
    // sanity check that the existing logic stays intact.
    expect(
      buildModelsUrl({
        ...OPENAI_PROVIDER,
        baseUrl: 'https://api.cerebras.ai/v1',
      }),
    ).toBe('https://api.cerebras.ai/v1/models')
  })

  test('grok: baseUrl already ending in /v1 stays clean', () => {
    expect(
      buildModelsUrl({
        ...GROK_PROVIDER,
        baseUrl: 'https://api.x.ai/v1',
      }),
    ).toBe('https://api.x.ai/v1/models')
  })
})

describe('fetchProviderModels', () => {
  test('openai-compat: sends Bearer auth and parses data[].id', async () => {
    stubFetch(
      new Response(
        JSON.stringify({ data: [{ id: 'model-1' }, { id: 'model-2' }] }),
        { status: 200 },
      ),
    )
    const models = await fetchProviderModels(OPENAI_PROVIDER)
    expect(models).toEqual(['model-1', 'model-2'])
    const [url, init] = lastCall()
    expect(url).toBe('https://a.example.com/v1/models')
    expect((init?.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer sk-openai-a',
    )
  })

  test('grok: sends Bearer auth', async () => {
    stubFetch(
      new Response(JSON.stringify({ data: [{ id: 'grok-4' }] }), {
        status: 200,
      }),
    )
    const models = await fetchProviderModels(GROK_PROVIDER)
    expect(models).toEqual(['grok-4'])
    const [, init] = lastCall()
    expect((init?.headers as Record<string, string>)['Authorization']).toBe(
      'Bearer grok-key',
    )
  })

  test('gemini: sends x-goog-api-key and strips models/ prefix', async () => {
    stubFetch(
      new Response(
        JSON.stringify({
          models: [
            { name: 'models/gemini-2.5-pro' },
            { name: 'models/gemini-2.5-flash' },
          ],
        }),
        { status: 200 },
      ),
    )
    const models = await fetchProviderModels(GEMINI_PROVIDER)
    expect(models).toEqual(['gemini-2.5-pro', 'gemini-2.5-flash'])
    const [url, init] = lastCall()
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models')
    expect((init?.headers as Record<string, string>)['x-goog-api-key']).toBe(
      'gemini-key',
    )
    expect(
      (init?.headers as Record<string, string>)['Authorization'],
    ).toBeUndefined()
  })

  test('anthropic: sends x-api-key and anthropic-version', async () => {
    stubFetch(
      new Response(
        JSON.stringify({
          data: [{ id: 'claude-opus-4-1' }, { id: 'claude-sonnet-4-5' }],
        }),
        { status: 200 },
      ),
    )
    const models = await fetchProviderModels(ANTHROPIC_PROVIDER)
    expect(models).toEqual(['claude-opus-4-1', 'claude-sonnet-4-5'])
    const [url, init] = lastCall()
    expect(url).toBe('https://api.anthropic.com/v1/models')
    const headers = init?.headers as Record<string, string>
    expect(headers['x-api-key']).toBe('sk-ant-test')
    expect(headers['anthropic-version']).toBe('2023-06-01')
  })

  test('non-2xx response throws with HTTP status', async () => {
    stubFetch(new Response('unauthorized', { status: 401 }))
    await expect(fetchProviderModels(OPENAI_PROVIDER)).rejects.toThrow(
      'HTTP 401',
    )
  })

  test('throws when no API key is configured', async () => {
    stubFetch(new Response('{}', { status: 200 }))
    await expect(
      fetchProviderModels({ ...OPENAI_PROVIDER, apiKey: undefined }),
    ).rejects.toThrow('no API key configured')
    expect(fetchCalls).toHaveLength(0)
  })

  test('abort (timeout) maps to a timeout error', async () => {
    const stub = async (): Promise<Response> => {
      const err = new Error('The operation was aborted')
      err.name = 'AbortError'
      throw err
    }
    globalThis.fetch = stub as unknown as typeof fetch
    await expect(fetchProviderModels(OPENAI_PROVIDER)).rejects.toThrow(
      'timed out after 10000ms',
    )
  })

  test('malformed response shape throws', async () => {
    stubFetch(
      new Response(JSON.stringify({ unexpected: true }), { status: 200 }),
    )
    await expect(fetchProviderModels(OPENAI_PROVIDER)).rejects.toThrow(
      'unexpected response shape',
    )
  })

  test('uses apiKeyEnv fallback for auth', async () => {
    process.env['FETCH_MODELS_TEST_KEY'] = 'env-fallback-key'
    stubFetch(
      new Response(JSON.stringify({ data: [{ id: 'm' }] }), { status: 200 }),
    )
    try {
      await fetchProviderModels({
        ...OPENAI_PROVIDER,
        apiKey: undefined,
        apiKeyEnv: 'FETCH_MODELS_TEST_KEY',
      })
      const [, init] = lastCall()
      expect((init?.headers as Record<string, string>)['Authorization']).toBe(
        'Bearer env-fallback-key',
      )
    } finally {
      delete process.env['FETCH_MODELS_TEST_KEY']
    }
  })
})
