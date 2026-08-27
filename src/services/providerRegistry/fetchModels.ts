import { getProxyFetchOptions } from '../../utils/proxy.js'
import { resolveApiKey, type ProviderConfig } from './types.js'

const FETCH_MODELS_TIMEOUT_MS = 10_000

/**
 * If the baseUrl already ends with an `/vN` or `/vNbeta` / `/vNalpha`
 * segment, return it unchanged. Otherwise return `${trimmed}/vN`. This
 * mirrors gemini client's `getGeminiProviderBaseUrl` and prevents
 * `/v1/v1/models` doubling when users paste a baseUrl that already
 * includes the API version.
 */
function withVersionSuffix(trimmed: string, version: string): string {
  return /\/v\d+(beta|alpha)?$/i.test(trimmed)
    ? trimmed
    : `${trimmed}/${version}`
}

/**
 * Build the /models endpoint URL for a provider, per protocol kind:
 * - openai-compat / grok: {baseUrl}/models
 * - gemini:               {baseUrl}/v1beta/models
 * - anthropic:            {baseUrl}/v1/models
 *
 * If baseUrl already ends with `/vN` (or `/vNbeta` / `/vNalpha`), the
 * version segment is not duplicated.
 */
export function buildModelsUrl(provider: ProviderConfig): string {
  const base = provider.baseUrl.replace(/\/+$/, '')
  switch (provider.kind) {
    case 'gemini':
      return `${withVersionSuffix(base, 'v1beta')}/models`
    case 'anthropic':
      return `${withVersionSuffix(base, 'v1')}/models`
    default:
      return `${base}/models`
  }
}

/**
 * Build auth headers per protocol kind:
 * - openai-compat / grok: Authorization: Bearer <key>
 * - gemini:               x-goog-api-key: <key>
 * - anthropic:            x-api-key: <key> + anthropic-version
 */
function buildModelsHeaders(provider: ProviderConfig): Record<string, string> {
  const apiKey = resolveApiKey(provider)
  if (!apiKey) {
    throw new Error(
      `fetchProviderModels: no API key configured for provider "${provider.id}"`,
    )
  }
  switch (provider.kind) {
    case 'gemini':
      return { 'x-goog-api-key': apiKey }
    case 'anthropic':
      return {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      }
    default:
      return { Authorization: `Bearer ${apiKey}` }
  }
}

interface OpenAIModelsResponse {
  data?: Array<{ id?: unknown }>
}

interface GeminiModelsResponse {
  models?: Array<{ name?: unknown }>
}

/**
 * Extract model ids from the per-protocol response shape.
 * Gemini returns `models[].name` as `models/<id>` — the prefix is stripped.
 */
function extractModelIds(
  kind: ProviderConfig['kind'],
  body: unknown,
): string[] {
  if (kind === 'gemini') {
    const data = body as GeminiModelsResponse
    if (!Array.isArray(data.models)) {
      throw new Error(
        'fetchProviderModels: unexpected response shape (missing "models" array)',
      )
    }
    return data.models
      .map(m => (typeof m.name === 'string' ? m.name : ''))
      .filter(Boolean)
      .map(name =>
        name.startsWith('models/') ? name.slice('models/'.length) : name,
      )
  }
  const data = body as OpenAIModelsResponse
  if (!Array.isArray(data.data)) {
    throw new Error(
      'fetchProviderModels: unexpected response shape (missing "data" array)',
    )
  }
  return data.data
    .map(m => (typeof m.id === 'string' ? m.id : ''))
    .filter(Boolean)
}

/**
 * Fetch the remote model list for a provider.
 *
 * - 10s timeout (AbortController)
 * - Honors HTTP(S)_PROXY / mTLS config via getProxyFetchOptions()
 * - Throws with the HTTP status on non-2xx responses
 *
 * Returns the list of model ids (display names are not provided by the
 * remote endpoints).
 */
export async function fetchProviderModels(
  provider: ProviderConfig,
): Promise<string[]> {
  const url = buildModelsUrl(provider)
  const headers = buildModelsHeaders(provider)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_MODELS_TIMEOUT_MS)
  try {
    const proxyOptions = getProxyFetchOptions()
    const res = await fetch(url, {
      headers,
      signal: controller.signal,
      ...proxyOptions,
    })
    if (!res.ok) {
      throw new Error(
        `fetchProviderModels: provider "${provider.id}" returned HTTP ${res.status}`,
      )
    }
    const body: unknown = await res.json()
    return extractModelIds(provider.kind, body)
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(
        `fetchProviderModels: provider "${provider.id}" timed out after ${FETCH_MODELS_TIMEOUT_MS}ms`,
      )
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}
