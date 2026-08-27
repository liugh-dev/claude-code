import type { Tools } from '../../Tool.js'
import type {
  AssistantMessage,
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
} from '../../types/message.js'
import type { SystemPrompt } from '../../utils/systemPromptType.js'
import type { ThinkingConfig } from '../../utils/thinking.js'
import { getAPIProvider } from '../../utils/model/providers.js'
import type { ResolvedModelRef } from '../providerRegistry/modelRef.js'
import type { Options } from './claude.js'
import type { AnthropicClientOverride } from './client.js'

/**
 * Arguments shared by all per-provider dispatch branches. Mirrors the values
 * available at the dispatch point in queryModel() (claude.ts), after shared
 * preprocessing (message normalization, tool filtering, media stripping).
 */
export interface ProviderDispatchArgs {
  /** Normalized messages (shared preprocessing already applied). */
  messagesForAPI: Message[]
  systemPrompt: SystemPrompt
  /** Full tool pool — the OpenAI path needs it for client-side tool search. */
  tools: Tools
  /** Deferred-tool-filtered pool — used by the Gemini/Grok paths. */
  filteredTools: Tools
  signal: AbortSignal
  options: Options
  thinkingConfig: ThinkingConfig
}

/**
 * Decide whether a resolved model ref should be dispatched to a provider
 * adapter. 'anthropic'-kind refs stay on the native Anthropic path (with a
 * client override); unresolved model strings (null) keep the legacy
 * env-driven routing unchanged.
 */
export function shouldDispatchToProvider(
  ref: ResolvedModelRef | null,
): ref is ResolvedModelRef {
  return ref !== null && ref.provider.kind !== 'anthropic'
}

/**
 * How env-driven provider configuration applies to a request on the native
 * Anthropic code path in queryModel() (claude.ts).
 */
export interface EnvProviderRouting {
  /**
   * Env-selected provider adapter to dispatch to ('openai' | 'gemini' |
   * 'grok'), or null to continue on the native Anthropic path.
   */
  envProvider: 'openai' | 'gemini' | 'grok' | null
  /**
   * True when the environment selects Bedrock (CLAUDE_CODE_USE_BEDROCK) AND
   * no registry anthropic-kind client override is active. Gates all
   * Bedrock-specific request shaping (inference-profile model resolution,
   * extra-body beta params).
   */
  isBedrock: boolean
}

/**
 * Resolve env-driven provider routing for a request, accounting for a
 * registry anthropic-kind client override.
 *
 * When `anthropicClientOverride` is set (the model string resolved to a
 * providers.json entry with kind 'anthropic'), the request is pinned to the
 * native Anthropic path and the override wins over environment variables:
 * CLAUDE_CODE_USE_OPENAI / CLAUDE_CODE_USE_GEMINI / CLAUDE_CODE_USE_GROK
 * routing is disabled (the request must NOT be sent to OPENAI_BASE_URL etc.),
 * and Bedrock-specific request fields are never computed — custom
 * Anthropic-compatible endpoints are treated as firstParty.
 */
export function resolveEnvProviderRouting(
  anthropicClientOverride: AnthropicClientOverride | undefined,
): EnvProviderRouting {
  if (anthropicClientOverride) {
    return { envProvider: null, isBedrock: false }
  }
  const provider = getAPIProvider()
  return {
    envProvider:
      provider === 'openai' || provider === 'gemini' || provider === 'grok'
        ? provider
        : null,
    isBedrock: provider === 'bedrock',
  }
}

/**
 * Dispatch a query to a configured provider instance from providers.json
 * (a resolved 'providerId:modelId' cross-provider reference).
 *
 * Handles the non-Anthropic kinds. 'anthropic'-kind refs stay on the native
 * Anthropic path in claude.ts (with a client override) — calling this with
 * an anthropic ref is a programming error.
 *
 * The modelId is passed verbatim via options.model — env-based model mapping
 * (resolveOpenAIModel / resolveGeminiModel / resolveGrokModel) is skipped
 * inside the per-provider query functions when a providerOverride is given.
 */
export async function* dispatchToProviderInstance(
  ref: ResolvedModelRef,
  args: ProviderDispatchArgs,
): AsyncGenerator<
  StreamEvent | AssistantMessage | SystemAPIErrorMessage,
  void
> {
  const options: Options = { ...args.options, model: ref.modelId }
  switch (ref.provider.kind) {
    case 'openai-compat': {
      const { queryModelOpenAI } = await import('./openai/index.js')
      yield* queryModelOpenAI(
        args.messagesForAPI,
        args.systemPrompt,
        args.tools,
        args.signal,
        options,
        ref.provider,
      )
      return
    }
    case 'gemini': {
      const { queryModelGemini } = await import('./gemini/index.js')
      yield* queryModelGemini(
        args.messagesForAPI,
        args.systemPrompt,
        args.filteredTools,
        args.signal,
        options,
        args.thinkingConfig,
        ref.provider,
      )
      return
    }
    case 'grok': {
      const { queryModelGrok } = await import('./grok/index.js')
      yield* queryModelGrok(
        args.messagesForAPI,
        args.systemPrompt,
        args.filteredTools,
        args.signal,
        options,
        ref.provider,
      )
      return
    }
    case 'anthropic':
      throw new Error(
        'dispatchToProviderInstance: anthropic-kind refs must stay on the native Anthropic path',
      )
  }
}
