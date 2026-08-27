/**
 * Tests for gemini/client.ts — model-id URL path safety and request URL
 * construction.
 *
 * The model id is interpolated directly into the request URL path
 * (`${baseUrl}/models/<id>:streamGenerateContent`). A modelId containing
 * '..' path segments or a leading '/' (e.g. from a malicious or
 * misconfigured providers.json entry) could escape the `/models/` prefix
 * and hit arbitrary endpoints on the same origin.
 *
 * Mocks only the side-effecting leaf deps of the SSETransport import chain
 * (debug/proxy/bun:bundle) — the SSE parser itself is the real
 * implementation.
 */
import { describe, expect, mock, test } from 'bun:test'
import { debugMock } from '../../../../../tests/mocks/debug'

mock.module('bun:bundle', () => ({ feature: () => false }))
mock.module('src/utils/debug.ts', debugMock)
mock.module('src/utils/proxy.js', () => ({
  getProxyFetchOptions: () => ({}) as Record<string, never>,
}))

import {
  assertValidGeminiModelId,
  streamGeminiGenerateContent,
} from '../client.js'
import type { ProviderConfig } from '../../../providerRegistry/types.js'

describe('assertValidGeminiModelId', () => {
  test('accepts plain gemini model names', () => {
    expect(() => assertValidGeminiModelId('gemini-2.5-pro')).not.toThrow()
    expect(() => assertValidGeminiModelId('gemini-2.0-flash-001')).not.toThrow()
  })

  test('accepts model names with the models/ resource prefix', () => {
    expect(() =>
      assertValidGeminiModelId('models/gemini-2.5-pro'),
    ).not.toThrow()
  })

  test('rejects model ids containing .. path segments', () => {
    expect(() => assertValidGeminiModelId('../evil')).toThrow(
      /must not contain '\.\.' path segments/,
    )
    expect(() => assertValidGeminiModelId('models/../evil')).toThrow(
      /must not contain '\.\.' path segments/,
    )
    expect(() => assertValidGeminiModelId('models/../../etc/passwd')).toThrow(
      /must not contain '\.\.' path segments/,
    )
  })

  test('rejects model ids starting with /', () => {
    expect(() => assertValidGeminiModelId('/absolute/path')).toThrow(
      /must not start with '\/'/,
    )
    expect(() => assertValidGeminiModelId('/models/gemini-2.5-pro')).toThrow(
      /must not start with '\/'/,
    )
  })
})

describe('streamGeminiGenerateContent URL construction', () => {
  const provider: ProviderConfig = {
    id: 'my-gemini',
    kind: 'gemini',
    baseUrl: 'https://gemini.example.com',
    apiKey: 'test-key',
  }

  function captureFetch(urls: string[]): typeof fetch {
    return (async (input: unknown) => {
      urls.push(String(input))
      return new Response('data: {"candidates": []}\n\n')
    }) as unknown as typeof fetch
  }

  async function drain<T>(gen: AsyncGenerator<T, void>): Promise<T[]> {
    const out: T[] = []
    for await (const item of gen) out.push(item)
    return out
  }

  test('interpolates a plain model id under the /models/ prefix', async () => {
    const urls: string[] = []
    const events = await drain(
      streamGeminiGenerateContent({
        model: 'gemini-2.5-pro',
        body: {} as never,
        signal: new AbortController().signal,
        fetchOverride: captureFetch(urls),
        providerOverride: provider,
      }),
    )
    expect(urls).toEqual([
      'https://gemini.example.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse',
    ])
    expect(events).toEqual([{ candidates: [] }])
  })

  test('respects an existing models/ prefix without duplicating it', async () => {
    const urls: string[] = []
    await drain(
      streamGeminiGenerateContent({
        model: 'models/gemini-2.0-flash',
        body: {} as never,
        signal: new AbortController().signal,
        fetchOverride: captureFetch(urls),
        providerOverride: provider,
      }),
    )
    expect(urls[0]).toContain('/models/gemini-2.0-flash:streamGenerateContent')
  })

  test('keeps a baseUrl that already ends with an API version segment as-is', async () => {
    const urls: string[] = []
    await drain(
      streamGeminiGenerateContent({
        model: 'gemini-2.5-pro',
        body: {} as never,
        signal: new AbortController().signal,
        fetchOverride: captureFetch(urls),
        providerOverride: {
          ...provider,
          baseUrl: 'https://proxy.example.com/v1beta',
        },
      }),
    )
    expect(urls[0]).toBe(
      'https://proxy.example.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse',
    )
  })

  test('rejects a traversal model id before any fetch is issued', async () => {
    const urls: string[] = []
    await expect(
      drain(
        streamGeminiGenerateContent({
          model: '../../v1/admin',
          body: {} as never,
          signal: new AbortController().signal,
          fetchOverride: captureFetch(urls),
          providerOverride: provider,
        }),
      ),
    ).rejects.toThrow(/must not contain '\.\.' path segments/)
    expect(urls).toEqual([])
  })

  test('rejects an absolute-path model id before any fetch is issued', async () => {
    const urls: string[] = []
    await expect(
      drain(
        streamGeminiGenerateContent({
          model: '/v1/admin',
          body: {} as never,
          signal: new AbortController().signal,
          fetchOverride: captureFetch(urls),
          providerOverride: provider,
        }),
      ),
    ).rejects.toThrow(/must not start with '\/'/)
    expect(urls).toEqual([])
  })
})
