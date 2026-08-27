import OpenAI from 'openai'
import { openaiAdapter } from 'src/services/providerUsage/adapters/openai.js'
import { updateProviderBuckets } from 'src/services/providerUsage/store.js'
import {
  resolveApiKey,
  type ProviderConfig,
} from 'src/services/providerRegistry/types.js'
import { getProxyFetchOptions } from 'src/utils/proxy.js'

/**
 * Environment variables:
 *
 * OPENAI_API_KEY: Required. API key for the OpenAI-compatible endpoint.
 * OPENAI_BASE_URL: Recommended. Base URL for the endpoint (e.g. http://localhost:11434/v1).
 * OPENAI_ORG_ID: Optional. Organization ID.
 * OPENAI_PROJECT_ID: Optional. Project ID.
 */

let cachedClient: OpenAI | null = null

/**
 * Wrap a fetch so that every response's rate-limit headers are fed into the
 * provider usage store. Errors in parsing must never break the request.
 *
 * The cast to `typeof fetch` is safe: OpenAI SDK only calls the function form,
 * not the static `preconnect` method that Bun/Node's `fetch` type declares.
 */
function wrapFetchForUsage(base: typeof fetch): typeof fetch {
  const wrapped = async (
    ...args: Parameters<typeof fetch>
  ): Promise<Response> => {
    const res = await base(...args)
    try {
      updateProviderBuckets('openai', openaiAdapter.parseHeaders(res.headers))
    } catch {
      // Ignore — usage tracking must not affect the request path.
    }
    return res
  }
  return wrapped as unknown as typeof fetch
}

export function getOpenAIClient(options?: {
  maxRetries?: number
  fetchOverride?: typeof fetch
  source?: string
}): OpenAI {
  if (cachedClient) return cachedClient

  const apiKey = process.env.OPENAI_API_KEY || ''
  const baseURL = process.env.OPENAI_BASE_URL

  const baseFetch = options?.fetchOverride ?? (globalThis.fetch as typeof fetch)
  const wrappedFetch = wrapFetchForUsage(baseFetch)

  const client = new OpenAI({
    apiKey,
    ...(baseURL && { baseURL }),
    maxRetries: options?.maxRetries ?? 0,
    timeout: parseInt(process.env.API_TIMEOUT_MS || String(600 * 1000), 10),
    dangerouslyAllowBrowser: true,
    ...(process.env.OPENAI_ORG_ID && {
      organization: process.env.OPENAI_ORG_ID,
    }),
    ...(process.env.OPENAI_PROJECT_ID && {
      project: process.env.OPENAI_PROJECT_ID,
    }),
    fetchOptions: getProxyFetchOptions({ forAnthropicAPI: false }),
    fetch: wrappedFetch,
  })

  if (!options?.fetchOverride) {
    cachedClient = client
  }

  return client
}

/** Clear the cached client (useful when env vars change). */
export function clearOpenAIClientCache(): void {
  cachedClient = null
}

/**
 * Instance pool for registry-based openai-compat providers:
 * providerId → OpenAI client. Separate from the env-driven singleton above
 * so the legacy path is unaffected.
 */
const providerClients = new Map<string, OpenAI>()

/** Clear the provider-instance client pool (tests / provider config change). */
export function clearOpenAIProviderClientCache(): void {
  providerClients.clear()
}

// When providers.json changes, cached clients keyed by providerId are
// stale (old apiKey/baseUrl). Subscribe once so saveProviders() clears.
import { onProvidersChanged } from '../../providerRegistry/loader.js'
onProvidersChanged(() => {
  providerClients.clear()
})

/**
 * Build (or reuse) an OpenAI client for a configured provider instance from
 * providers.json. baseUrl and apiKey come from the provider config, never
 * from OPENAI_BASE_URL / OPENAI_API_KEY env vars.
 *
 * A caller-scoped fetchOverride is never pooled (it belongs to the caller).
 */
export function getOpenAIClientForProvider(
  provider: ProviderConfig,
  options?: {
    maxRetries?: number
    fetchOverride?: typeof fetch
    source?: string
  },
): OpenAI {
  if (!options?.fetchOverride) {
    const cached = providerClients.get(provider.id)
    if (cached) return cached
  }

  const baseFetch = options?.fetchOverride ?? (globalThis.fetch as typeof fetch)
  const wrappedFetch = wrapFetchForUsage(baseFetch)

  const client = new OpenAI({
    apiKey: resolveApiKey(provider) ?? '',
    baseURL: provider.baseUrl,
    maxRetries: options?.maxRetries ?? 0,
    timeout: parseInt(process.env.API_TIMEOUT_MS || String(600 * 1000), 10),
    dangerouslyAllowBrowser: true,
    fetchOptions: getProxyFetchOptions({ forAnthropicAPI: false }),
    fetch: wrappedFetch,
  })

  if (!options?.fetchOverride) {
    providerClients.set(provider.id, client)
  }

  return client
}
