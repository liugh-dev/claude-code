/**
 * Tests for the registry-override client path in getAnthropicClient()
 * (src/services/api/client.ts).
 *
 * Verifies that an anthropic-kind providers.json override client carries the
 * same standard custom request headers as the env-driven path
 * (ANTHROPIC_CUSTOM_HEADERS, container/remote-session ids, x-client-app,
 * SSH auth nonce, additional-protection) and never falls back to
 * process.env.ANTHROPIC_API_KEY.
 *
 * Mocked leaves only: auth.ts (OAuth chain), settings.js (provider
 * selection reads getInitialSettings), debug.ts + proxy.js (side-effecting
 * deps). http.js and bootstrap/state.js run for real (MACRO is set on
 * globalThis below so getUserAgent works).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { authMock } from '../../../../tests/mocks/auth'
import { debugMock } from '../../../../tests/mocks/debug'
import { logMock } from '../../../../tests/mocks/log'

mock.module('bun:bundle', () => ({ feature: () => false }))
mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/auth.js', authMock)
mock.module('src/utils/debug.ts', debugMock)
mock.module('src/utils/settings/settings.js', () => ({
  getSettings_DEPRECATED: () => ({}),
  getInitialSettings: () => ({}),
  getSettingsForSource: () => null,
  updateSettingsForSource: () => {},
}))
mock.module('src/utils/proxy.js', () => ({
  getProxyFetchOptions: () => ({}) as Record<string, never>,
}))

// MACRO is a build-time define (see scripts/dev.ts). Set it on globalThis so
// the bare `MACRO` identifier in src/utils/userAgent.ts resolves at runtime.
;(globalThis as unknown as { MACRO: { VERSION: string } }).MACRO = {
  VERSION: 'test',
}

import {
  buildFetch,
  clearAnthropicOverrideClientCache,
  CLIENT_REQUEST_ID_HEADER,
  getAnthropicClient,
} from '../client.js'
import type Anthropic from '@anthropic-ai/sdk'

const HEADER_ENV_KEYS = [
  'CLAUDE_CODE_CONTAINER_ID',
  'CLAUDE_CODE_REMOTE_SESSION_ID',
  'CLAUDE_AGENT_SDK_CLIENT_APP',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_AUTH_NONCE',
  'CLAUDE_CODE_ADDITIONAL_PROTECTION',
  'ANTHROPIC_API_KEY',
] as const

function getDefaultHeaders(client: Anthropic): Record<string, string> {
  // defaultHeaders is a public ClientOptions field stored verbatim on the
  // SDK instance; not on the public TS surface, hence the narrow cast.
  return (
    client as unknown as {
      _options: { defaultHeaders: Record<string, string> }
    }
  )._options.defaultHeaders
}

const OVERRIDE = {
  baseUrl: 'https://corp-anthropic.example.com',
  apiKey: 'sk-corp-key',
  providerId: 'corp-anthropic',
}

describe('getAnthropicClient override path default headers', () => {
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    clearAnthropicOverrideClientCache()
    for (const key of HEADER_ENV_KEYS) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    clearAnthropicOverrideClientCache()
    for (const key of HEADER_ENV_KEYS) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key]
      } else {
        delete process.env[key]
      }
    }
  })

  test('carries CLI identity headers', async () => {
    const client = await getAnthropicClient({
      maxRetries: 0,
      override: OVERRIDE,
    })
    const headers = getDefaultHeaders(client)
    expect(headers['x-app']).toBe('cli')
    expect(headers['User-Agent']).toMatch(/^claude-cli\/test /)
    expect(typeof headers['X-Claude-Code-Session-Id']).toBe('string')
    expect(headers['X-Claude-Code-Session-Id']!.length).toBeGreaterThan(0)
  })

  test('carries ANTHROPIC_CUSTOM_HEADERS entries', async () => {
    process.env.ANTHROPIC_CUSTOM_HEADERS =
      'X-Custom-Trace: abc123\nX-Team: platform'
    const client = await getAnthropicClient({
      maxRetries: 0,
      override: OVERRIDE,
    })
    const headers = getDefaultHeaders(client)
    expect(headers['X-Custom-Trace']).toBe('abc123')
    expect(headers['X-Team']).toBe('platform')
  })

  test('carries container id, remote session id, client app, and auth nonce', async () => {
    process.env.CLAUDE_CODE_CONTAINER_ID = 'container-1'
    process.env.CLAUDE_CODE_REMOTE_SESSION_ID = 'remote-9'
    process.env.CLAUDE_AGENT_SDK_CLIENT_APP = 'my-app/1.0.0'
    process.env.ANTHROPIC_AUTH_NONCE = 'nonce-xyz'
    const client = await getAnthropicClient({
      maxRetries: 0,
      override: OVERRIDE,
    })
    const headers = getDefaultHeaders(client)
    expect(headers['x-claude-remote-container-id']).toBe('container-1')
    expect(headers['x-claude-remote-session-id']).toBe('remote-9')
    expect(headers['x-client-app']).toBe('my-app/1.0.0')
    expect(headers['x-auth-nonce']).toBe('nonce-xyz')
  })

  test('carries additional-protection header when enabled', async () => {
    process.env.CLAUDE_CODE_ADDITIONAL_PROTECTION = '1'
    const client = await getAnthropicClient({
      maxRetries: 0,
      override: OVERRIDE,
    })
    expect(getDefaultHeaders(client)['x-anthropic-additional-protection']).toBe(
      'true',
    )
  })

  test('omits optional headers when their env vars are unset', async () => {
    const client = await getAnthropicClient({
      maxRetries: 0,
      override: OVERRIDE,
    })
    const headers = getDefaultHeaders(client)
    expect(headers['x-claude-remote-container-id']).toBeUndefined()
    expect(headers['x-claude-remote-session-id']).toBeUndefined()
    expect(headers['x-client-app']).toBeUndefined()
    expect(headers['x-auth-nonce']).toBeUndefined()
    expect(headers['x-anthropic-additional-protection']).toBeUndefined()
  })

  test('uses the override apiKey and never falls back to ANTHROPIC_API_KEY', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-env-key'
    const client = await getAnthropicClient({
      maxRetries: 0,
      override: OVERRIDE,
    })
    // apiKey is null so the SDK injects no x-api-key; auth is via Bearer in
    // defaultHeaders.
    expect(client.apiKey).toBeNull()
    expect(getDefaultHeaders(client)['Authorization']).toBe(
      'Bearer sk-corp-key',
    )
    expect(client.baseURL).toBe('https://corp-anthropic.example.com')

    clearAnthropicOverrideClientCache()
    const noKeyClient = await getAnthropicClient({
      maxRetries: 0,
      override: { ...OVERRIDE, apiKey: undefined },
    })
    // Explicit null — the SDK must not pick up process.env.ANTHROPIC_API_KEY.
    expect(noKeyClient.apiKey).toBeNull()
    expect(getDefaultHeaders(noKeyClient)['Authorization']).toBeUndefined()
  })
})

describe('buildFetch x-client-request-id injection gating', () => {
  const ENV_KEYS = [
    'CLAUDE_CODE_USE_OPENAI',
    'CLAUDE_CODE_USE_GROK',
    'CLAUDE_CODE_USE_GEMINI',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'ANTHROPIC_BASE_URL',
  ] as const
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key]
      } else {
        delete process.env[key]
      }
    }
  })

  /** Returns [wrappedFetch, getter for the headers the inner fetch saw]. */
  function captureInnerHeaders(): [
    NonNullable<Parameters<typeof buildFetch>[0]>,
    () => Headers | undefined,
  ] {
    let seen: Headers | undefined
    const inner = (async (_input: unknown, init?: { headers?: unknown }) => {
      seen = new Headers(init?.headers as HeadersInit)
      return new Response('{}', { status: 200 })
    }) as unknown as NonNullable<Parameters<typeof buildFetch>[0]>
    return [inner, () => seen]
  }

  test('injects a client request id on the env first-party path', async () => {
    const [inner, getHeaders] = captureInnerHeaders()
    const wrapped = buildFetch(inner, 'test')
    await wrapped!('https://api.anthropic.com/v1/messages', {})
    expect(getHeaders()?.get(CLIENT_REQUEST_ID_HEADER)).toMatch(
      /^[0-9a-f-]{36}$/,
    )
  })

  test('injectClientRequestId: false (registry override path) never injects', async () => {
    const [inner, getHeaders] = captureInnerHeaders()
    const wrapped = buildFetch(inner, 'test', { injectClientRequestId: false })
    await wrapped!('https://corp-anthropic.example.com/v1/messages', {})
    expect(getHeaders()?.get(CLIENT_REQUEST_ID_HEADER)).toBeNull()
  })

  test('does not inject for non-first-party env providers', async () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'
    const [inner, getHeaders] = captureInnerHeaders()
    const wrapped = buildFetch(inner, 'test')
    await wrapped!('https://api.anthropic.com/v1/messages', {})
    expect(getHeaders()?.get(CLIENT_REQUEST_ID_HEADER)).toBeNull()
  })

  test('preserves a caller-supplied client request id', async () => {
    const [inner, getHeaders] = captureInnerHeaders()
    const wrapped = buildFetch(inner, 'test')
    await wrapped!('https://api.anthropic.com/v1/messages', {
      headers: { [CLIENT_REQUEST_ID_HEADER]: 'caller-supplied-id' },
    })
    expect(getHeaders()?.get(CLIENT_REQUEST_ID_HEADER)).toBe(
      'caller-supplied-id',
    )
  })

  test('getAnthropicClient override path builds a non-injecting fetch', async () => {
    // Even on a first-party-looking env, the registry override client must
    // not inject the first-party correlation header. buildFetch captures
    // globalThis.fetch at client-construction time, so stub it first and
    // clear the provider-id client pool to force a fresh client.
    clearAnthropicOverrideClientCache()
    let seen: Headers | undefined
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (
      _input: unknown,
      init?: { headers?: unknown },
    ) => {
      seen = new Headers(init?.headers as HeadersInit)
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    try {
      const client = await getAnthropicClient({
        maxRetries: 0,
        override: OVERRIDE,
      })
      expect(client.baseURL).toBe('https://corp-anthropic.example.com')

      // Reach the fetch the client was constructed with (stored on the SDK
      // instance's private options; not on the public TS surface).
      const clientFetch = (
        client as unknown as {
          _options: { fetch?: (input: unknown, init?: unknown) => unknown }
        }
      )._options.fetch
      expect(typeof clientFetch).toBe('function')
      await clientFetch!('https://corp-anthropic.example.com/v1/messages', {})
      expect(seen?.get(CLIENT_REQUEST_ID_HEADER)).toBeNull()
    } finally {
      globalThis.fetch = originalFetch
      clearAnthropicOverrideClientCache()
    }
  })
})
