import {
  findProvider,
  isBuiltinDefaultProviderId,
  loadProviders,
  loadUserProviders,
} from './loader.js'
import { resolveApiKey, type ProviderConfig } from './types.js'

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
 * Returns a hit only when the first-colon prefix matches a configured
 * provider id in the registry. Otherwise returns null and the caller must
 * treat the model string as opaque (e.g. Bedrock ARNs, plain model names).
 *
 * The modelId is returned verbatim — callers must NOT run it through
 * provider-specific model mapping (resolveOpenAIModel etc.).
 *
 * Safety: a built-in default id (cerebras / groq / qwen / deepseek) is
 * ONLY treated as a hit when the user has EITHER explicitly configured it
 * in providers.json OR the matching apiKey env var is set in the current
 * process. This prevents a string like `qwen:7b` (an Ollama-style label,
 * Bedrock ARN fragment, or any other opaque token that happens to share
 * the built-in id prefix) from silently routing the conversation to a
 * third-party provider the user never opted into. User-defined ids and
 * user-overridden built-in ids are trusted unconditionally — explicit
 * opt-in takes precedence over the credential gate.
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

  // Built-in default ids are inert unless the user has explicitly opted in
  // (user override in providers.json) OR the matching apiKey env var is
  // resolvable. Anything else is treated as opaque text.
  if (isBuiltinDefaultProviderId(parsed.providerId)) {
    const userDefinedIds = new Set(loadUserProviders().map(p => p.id))
    if (userDefinedIds.has(parsed.providerId)) {
      // User explicitly overrode this built-in id — trust it.
      return { provider, modelId: parsed.modelId }
    }
    if (!resolveApiKey(provider)) {
      // Pure built-in default with no resolvable credentials — refuse to
      // route. The caller will fall back to the legacy path (which treats
      // the string as opaque and likely rejects it).
      return null
    }
  }

  return { provider, modelId: parsed.modelId }
}
