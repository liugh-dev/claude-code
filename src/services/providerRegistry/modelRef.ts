import { findProvider, loadProviders } from './loader.js'
import type { ProviderConfig } from './types.js'

export interface ParsedModelRef {
  providerId: string
  modelId: string
}

export interface ResolvedModelRef {
  provider: ProviderConfig
  modelId: string
}

/**
 * Pure syntactic parse of a cross-provider model reference.
 *
 * Splits on the FIRST colon: `opencode-go:glm-5.2` →
 * { providerId: 'opencode-go', modelId: 'glm-5.2' }.
 *
 * Returns null when there is no usable colon split (no colon, empty
 * providerId, or empty modelId). Does NOT consult the provider registry —
 * a non-null result does not mean the providerId is configured. Model
 * strings like Bedrock ARNs (`arn:aws:bedrock:...`) parse successfully here;
 * resolveModelRef() is responsible for rejecting them via registry lookup.
 */
export function parseModelRef(model: string): ParsedModelRef | null {
  const idx = model.indexOf(':')
  if (idx <= 0 || idx === model.length - 1) return null
  return {
    providerId: model.slice(0, idx),
    modelId: model.slice(idx + 1),
  }
}

/**
 * Resolve a model string to a configured provider instance + model id.
 *
 * Returns a hit only when the first-colon prefix matches a provider id
 * the user explicitly configured in providers.json. Otherwise returns
 * null and the caller must treat the model string as opaque (e.g.
 * Bedrock ARNs, plain model names) — every configured provider is an
 * explicit user opt-in, so no credential gating is needed.
 *
 * The modelId is returned verbatim — callers must NOT run it through
 * provider-specific model mapping (resolveOpenAIModel etc.).
 */
export function resolveModelRef(
  model: string,
  providers?: ProviderConfig[],
): ResolvedModelRef | null {
  const parsed = parseModelRef(model)
  if (!parsed) return null
  const merged = providers ?? loadProviders()
  const provider = findProvider(parsed.providerId, merged)
  if (!provider) return null
  return { provider, modelId: parsed.modelId }
}
