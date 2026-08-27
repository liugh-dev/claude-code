/**
 * Tests for cross-provider request dispatch (providerRouting.ts).
 *
 * Verifies that a resolved 'providerId:modelId' ref routes to the matching
 * provider adapter by kind, that the modelId is passed verbatim via
 * options.model (no env-based model mapping), and that the provider config
 * is forwarded as providerOverride. Miss behavior (unresolved refs keep the
 * legacy env-driven path) is covered via shouldDispatchToProvider and by
 * src/services/providerRegistry/__tests__/modelRef.test.ts.
 *
 * Only the leaf provider adapter modules are mocked (openai/gemini/grok
 * index) — no upper-layer business modules.
 */
import { describe, expect, mock, test } from 'bun:test'
import type { ProviderConfig } from '../../providerRegistry/types.js'
import type { ResolvedModelRef } from '../../providerRegistry/modelRef.js'
import type { AnthropicClientOverride } from '../client.js'

// resolveEnvProviderRouting reads getAPIProvider() → getInitialSettings().
// Mock settings so a polluted modelType from other test files
// (mock.module is process-global) cannot flip the provider selection.
mock.module('src/utils/settings/settings.js', () => ({
  getSettings_DEPRECATED: () => ({}),
  getInitialSettings: () => ({}),
  getSettingsForSource: () => null,
  updateSettingsForSource: () => {},
}))

type RecordedCall = {
  messages: unknown
  systemPrompt: unknown
  tools: unknown
  signal: unknown
  options: { model: string }
  thinkingConfig?: unknown
  providerOverride?: ProviderConfig
}

const calls: Record<string, RecordedCall[]> = {
  openai: [],
  gemini: [],
  grok: [],
}

async function* emptyGen(): AsyncGenerator<never, void> {
  // yields nothing — dispatch-level test only cares about routing
}

mock.module('src/services/api/openai/index.ts', () => ({
  queryModelOpenAI: (
    messages: unknown,
    systemPrompt: unknown,
    tools: unknown,
    signal: unknown,
    options: { model: string },
    providerOverride?: ProviderConfig,
  ) => {
    calls.openai.push({
      messages,
      systemPrompt,
      tools,
      signal,
      options,
      providerOverride,
    })
    return emptyGen()
  },
}))

mock.module('src/services/api/gemini/index.ts', () => ({
  queryModelGemini: (
    messages: unknown,
    systemPrompt: unknown,
    tools: unknown,
    signal: unknown,
    options: { model: string },
    thinkingConfig: unknown,
    providerOverride?: ProviderConfig,
  ) => {
    calls.gemini.push({
      messages,
      systemPrompt,
      tools,
      signal,
      options,
      thinkingConfig,
      providerOverride,
    })
    return emptyGen()
  },
}))

mock.module('src/services/api/grok/index.ts', () => ({
  queryModelGrok: (
    messages: unknown,
    systemPrompt: unknown,
    tools: unknown,
    signal: unknown,
    options: { model: string },
    providerOverride?: ProviderConfig,
  ) => {
    calls.grok.push({
      messages,
      systemPrompt,
      tools,
      signal,
      options,
      providerOverride,
    })
    return emptyGen()
  },
}))

import {
  dispatchToProviderInstance,
  resolveEnvProviderRouting,
  shouldDispatchToProvider,
  type ProviderDispatchArgs,
} from '../providerRouting.js'

function makeProvider(
  id: string,
  kind: ProviderConfig['kind'],
): ProviderConfig {
  return {
    id,
    kind,
    baseUrl: `https://${id}.example.com/v1`,
    apiKey: `key-${id}`,
  }
}

function makeRef(id: string, kind: ProviderConfig['kind']): ResolvedModelRef {
  return { provider: makeProvider(id, kind), modelId: 'glm-5.2' }
}

function makeArgs(model: string): ProviderDispatchArgs {
  return {
    messagesForAPI: [],
    systemPrompt: ['sys'] as unknown as ProviderDispatchArgs['systemPrompt'],
    tools: [],
    filteredTools: [],
    signal: new AbortController().signal,
    // Only the fields dispatch touches are meaningful here.
    options: { model } as unknown as ProviderDispatchArgs['options'],
    thinkingConfig: { type: 'disabled' },
  }
}

async function drain<T>(gen: AsyncGenerator<T, void>): Promise<void> {
  for await (const _ of gen) {
    // discard
  }
}

describe('dispatchToProviderInstance', () => {
  test('routes openai-compat refs to queryModelOpenAI with verbatim modelId', async () => {
    calls.openai = []
    const ref = makeRef('opencode-go', 'openai-compat')
    await drain(
      dispatchToProviderInstance(ref, makeArgs('opencode-go:glm-5.2')),
    )
    expect(calls.openai).toHaveLength(1)
    const call = calls.openai[0]!
    expect(call.options.model).toBe('glm-5.2')
    expect(call.providerOverride?.id).toBe('opencode-go')
  })

  test('routes gemini refs to queryModelGemini with verbatim modelId', async () => {
    calls.gemini = []
    const ref = makeRef('my-gemini', 'gemini')
    await drain(dispatchToProviderInstance(ref, makeArgs('my-gemini:glm-5.2')))
    expect(calls.gemini).toHaveLength(1)
    const call = calls.gemini[0]!
    expect(call.options.model).toBe('glm-5.2')
    expect(call.providerOverride?.id).toBe('my-gemini')
    expect(call.thinkingConfig).toEqual({ type: 'disabled' })
  })

  test('routes grok refs to queryModelGrok with verbatim modelId', async () => {
    calls.grok = []
    const ref = makeRef('my-grok', 'grok')
    await drain(dispatchToProviderInstance(ref, makeArgs('my-grok:glm-5.2')))
    expect(calls.grok).toHaveLength(1)
    const call = calls.grok[0]!
    expect(call.options.model).toBe('glm-5.2')
    expect(call.providerOverride?.id).toBe('my-grok')
  })

  test('does not mutate the caller-provided options object', async () => {
    calls.openai = []
    const args = makeArgs('opencode-go:glm-5.2')
    await drain(
      dispatchToProviderInstance(makeRef('opencode-go', 'openai-compat'), args),
    )
    expect(args.options.model).toBe('opencode-go:glm-5.2')
  })

  test('strips [1m]/[2m] suffixes from the modelId before dispatch', async () => {
    calls.openai = []
    await drain(
      dispatchToProviderInstance(
        {
          provider: makeProvider('opencode-go', 'openai-compat'),
          modelId: 'glm-5.2[1m]',
        },
        makeArgs('opencode-go:glm-5.2[1m]'),
      ),
    )
    expect(calls.openai[0]!.options.model).toBe('glm-5.2')

    calls.gemini = []
    await drain(
      dispatchToProviderInstance(
        {
          provider: makeProvider('my-gemini', 'gemini'),
          modelId: 'gem-2.5-pro[1M]',
        },
        makeArgs('my-gemini:gem-2.5-pro[1M]'),
      ),
    )
    expect(calls.gemini[0]!.options.model).toBe('gem-2.5-pro')

    calls.grok = []
    await drain(
      dispatchToProviderInstance(
        { provider: makeProvider('my-grok', 'grok'), modelId: 'grok-4[2m]' },
        makeArgs('my-grok:grok-4[2m]'),
      ),
    )
    expect(calls.grok[0]!.options.model).toBe('grok-4')
  })

  test('throws for anthropic-kind refs (handled by the native path)', async () => {
    const ref = makeRef('corp-anthropic', 'anthropic')
    await expect(
      drain(
        dispatchToProviderInstance(ref, makeArgs('corp-anthropic:glm-5.2')),
      ),
    ).rejects.toThrow('anthropic-kind')
  })
})

describe('shouldDispatchToProvider', () => {
  test('returns true for openai-compat / gemini / grok refs', () => {
    expect(shouldDispatchToProvider(makeRef('a', 'openai-compat'))).toBe(true)
    expect(shouldDispatchToProvider(makeRef('b', 'gemini'))).toBe(true)
    expect(shouldDispatchToProvider(makeRef('c', 'grok'))).toBe(true)
  })

  test('returns false for anthropic-kind refs (native path + client override)', () => {
    expect(shouldDispatchToProvider(makeRef('d', 'anthropic'))).toBe(false)
  })

  test('returns false for unresolved model strings (legacy env-driven path)', () => {
    expect(shouldDispatchToProvider(null)).toBe(false)
  })
})

describe('resolveEnvProviderRouting', () => {
  const PROVIDER_ENV_KEYS = [
    'CLAUDE_CODE_USE_OPENAI',
    'CLAUDE_CODE_USE_GEMINI',
    'CLAUDE_CODE_USE_GROK',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
  ] as const

  const savedEnv: Record<string, string | undefined> = {}

  function withEnv<T>(env: Record<string, string>, fn: () => T): T {
    for (const key of PROVIDER_ENV_KEYS) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
    Object.assign(process.env, env)
    try {
      return fn()
    } finally {
      for (const key of PROVIDER_ENV_KEYS) {
        if (savedEnv[key] !== undefined) {
          process.env[key] = savedEnv[key]
        } else {
          delete process.env[key]
        }
      }
    }
  }

  const override: AnthropicClientOverride = {
    baseUrl: 'https://corp-anthropic.example.com',
    apiKey: 'sk-corp',
    providerId: 'corp-anthropic',
  }

  test('anthropic client override disables env routing even with CLAUDE_CODE_USE_OPENAI=1', () => {
    withEnv({ CLAUDE_CODE_USE_OPENAI: '1' }, () => {
      // Regression: an anthropic-kind ref + CLAUDE_CODE_USE_OPENAI=1 used to
      // dispatch the request to OPENAI_BASE_URL. The override must win.
      expect(resolveEnvProviderRouting(override)).toEqual({
        envProvider: null,
        isBedrock: false,
      })
    })
  })

  test('anthropic client override disables env routing for gemini/grok too', () => {
    withEnv({ CLAUDE_CODE_USE_GEMINI: '1' }, () => {
      expect(resolveEnvProviderRouting(override).envProvider).toBe(null)
    })
    withEnv({ CLAUDE_CODE_USE_GROK: '1' }, () => {
      expect(resolveEnvProviderRouting(override).envProvider).toBe(null)
    })
  })

  test('anthropic client override suppresses Bedrock-specific request fields', () => {
    withEnv({ CLAUDE_CODE_USE_BEDROCK: '1' }, () => {
      // Custom Anthropic-compatible endpoints are treated as firstParty:
      // no bedrock extra-body betas, no inference-profile resolution.
      const routing = resolveEnvProviderRouting(override)
      expect(routing.envProvider).toBe(null)
      expect(routing.isBedrock).toBe(false)
    })
  })

  test('without override, CLAUDE_CODE_USE_OPENAI=1 routes to the openai adapter', () => {
    withEnv({ CLAUDE_CODE_USE_OPENAI: '1' }, () => {
      expect(resolveEnvProviderRouting(undefined)).toEqual({
        envProvider: 'openai',
        isBedrock: false,
      })
    })
  })

  test('without override, CLAUDE_CODE_USE_GEMINI=1 / CLAUDE_CODE_USE_GROK=1 route to their adapters', () => {
    withEnv({ CLAUDE_CODE_USE_GEMINI: '1' }, () => {
      expect(resolveEnvProviderRouting(undefined).envProvider).toBe('gemini')
    })
    withEnv({ CLAUDE_CODE_USE_GROK: '1' }, () => {
      expect(resolveEnvProviderRouting(undefined).envProvider).toBe('grok')
    })
  })

  test('without override, CLAUDE_CODE_USE_BEDROCK=1 stays on the native path with bedrock shaping', () => {
    withEnv({ CLAUDE_CODE_USE_BEDROCK: '1' }, () => {
      expect(resolveEnvProviderRouting(undefined)).toEqual({
        envProvider: null,
        isBedrock: true,
      })
    })
  })

  test('without override and no env flags, stays on the native firstParty path', () => {
    withEnv({}, () => {
      expect(resolveEnvProviderRouting(undefined)).toEqual({
        envProvider: null,
        isBedrock: false,
      })
    })
  })
})
