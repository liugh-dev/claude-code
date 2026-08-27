import { parseSSEFrames } from 'src/cli/transports/SSETransport.js'
import { errorMessage } from 'src/utils/errors.js'
import { getProxyFetchOptions } from 'src/utils/proxy.js'
import {
  resolveApiKey,
  type ProviderConfig,
} from 'src/services/providerRegistry/types.js'
import type {
  GeminiGenerateContentRequest,
  GeminiStreamChunk,
} from '@ant/model-provider'

const DEFAULT_GEMINI_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta'

const STREAM_DECODE_OPTS: TextDecodeOptions = { stream: true }

function getGeminiBaseUrl(): string {
  return (process.env.GEMINI_BASE_URL || DEFAULT_GEMINI_BASE_URL).replace(
    /\/+$/,
    '',
  )
}

/**
 * Resolve the base URL for a provider-registry gemini instance.
 *
 * providers.json stores the API root for gemini providers (default
 * `https://generativelanguage.googleapis.com`); the streaming endpoint lives
 * under `/v1beta`. If the configured baseUrl already ends with an API version
 * segment (e.g. a proxy exposing `.../v1beta`), it is used as-is.
 */
function getGeminiProviderBaseUrl(provider: ProviderConfig): string {
  const trimmed = provider.baseUrl.replace(/\/+$/, '')
  return /\/v\d+(beta|alpha)?$/i.test(trimmed) ? trimmed : `${trimmed}/v1beta`
}

/**
 * Validate a Gemini model id before it is interpolated into the request URL
 * path. The model id becomes a URL path segment
 * (`${baseUrl}/models/<id>:streamGenerateContent`), so a malicious or
 * misconfigured providers.json entry containing '..' path segments or a
 * leading '/' could escape the `/models/` prefix and hit arbitrary endpoints
 * on the same origin (path traversal).
 *
 * Plain model names ('gemini-2.5-pro') and names that already carry the
 * 'models/' resource prefix ('models/gemini-2.5-pro') are accepted.
 */
export function assertValidGeminiModelId(model: string): void {
  if (model.startsWith('/')) {
    throw new Error(
      `Invalid Gemini model id ${JSON.stringify(model)}: must not start with '/'`,
    )
  }
  if (model.split('/').includes('..')) {
    throw new Error(
      `Invalid Gemini model id ${JSON.stringify(model)}: must not contain '..' path segments`,
    )
  }
}

function getGeminiModelPath(model: string): string {
  assertValidGeminiModelId(model)
  return model.startsWith('models/') ? model : `models/${model}`
}

export async function* streamGeminiGenerateContent(params: {
  model: string
  body: GeminiGenerateContentRequest
  signal: AbortSignal
  fetchOverride?: typeof fetch
  providerOverride?: ProviderConfig
}): AsyncGenerator<GeminiStreamChunk, void> {
  const fetchImpl = params.fetchOverride ?? fetch
  const baseUrl = params.providerOverride
    ? getGeminiProviderBaseUrl(params.providerOverride)
    : getGeminiBaseUrl()
  const apiKey = params.providerOverride
    ? (resolveApiKey(params.providerOverride) ?? '')
    : process.env.GEMINI_API_KEY || ''
  const url = `${baseUrl}/${getGeminiModelPath(params.model)}:streamGenerateContent?alt=sse`

  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify(params.body),
    signal: params.signal,
    ...getProxyFetchOptions({ forAnthropicAPI: false }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(
      `Gemini API request failed (${response.status} ${response.statusText}): ${body || 'empty response body'}`,
    )
  }

  if (!response.body) {
    throw new Error('Gemini API returned no response body')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, STREAM_DECODE_OPTS)
      const { frames, remaining } = parseSSEFrames(buffer)
      buffer = remaining

      for (const frame of frames) {
        if (!frame.data || frame.data === '[DONE]') continue
        try {
          yield JSON.parse(frame.data) as GeminiStreamChunk
        } catch (error) {
          throw new Error(
            `Failed to parse Gemini SSE payload: ${errorMessage(error)}`,
          )
        }
      }
    }

    buffer += decoder.decode()
    const { frames } = parseSSEFrames(buffer)
    for (const frame of frames) {
      if (!frame.data || frame.data === '[DONE]') continue
      try {
        yield JSON.parse(frame.data) as GeminiStreamChunk
      } catch (error) {
        throw new Error(
          `Failed to parse trailing Gemini SSE payload: ${errorMessage(error)}`,
        )
      }
    }
  } finally {
    reader.releaseLock()
  }
}
