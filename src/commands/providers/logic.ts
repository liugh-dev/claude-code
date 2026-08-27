/**
 * Pure helpers for the /providers command.
 *
 * Kept free of React/Ink imports so they can be unit-tested without a TTY.
 */
import {
  CompatRuleSchema,
  ProviderKindSchema,
  resolveApiKey,
  type CompatRule,
  type ProviderConfig,
  type ProviderKind,
} from '../../services/providerRegistry/types.js'

/** Kebab-case identifier used as the providerId prefix in model refs. */
export function validateProviderId(
  id: string,
  existing: readonly ProviderConfig[],
): string | null {
  if (!id) return 'id 不能为空'
  if (!/^[a-z0-9-]+$/.test(id)) {
    return 'id 只允许小写字母、数字和中划线（kebab-case）'
  }
  if (id.startsWith('-') || id.endsWith('-')) {
    return 'id 不能以中划线开头或结尾'
  }
  if (existing.some(p => p.id === id)) {
    return `id "${id}" 已存在，请换一个`
  }
  return null
}

/** Validate the baseUrl field (must parse as http(s) URL). */
export function validateBaseUrl(raw: string): string | null {
  if (!raw) return 'baseUrl 不能为空'
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return 'baseUrl 不是合法的 URL'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'baseUrl 必须是 http(s) URL'
  }
  return null
}

export interface ProviderKindOption {
  value: ProviderKind
  label: string
  description: string
}

export const PROVIDER_KIND_OPTIONS: readonly ProviderKindOption[] = [
  {
    value: 'openai-compat',
    label: 'openai-compat',
    description:
      'OpenAI Chat Completions 协议（DeepSeek、Cerebras、Groq、vLLM、Ollama 等）',
  },
  {
    value: 'gemini',
    label: 'gemini',
    description: 'Google Gemini API',
  },
  {
    value: 'grok',
    label: 'grok',
    description: 'xAI Grok API（OpenAI 兼容）',
  },
  {
    value: 'anthropic',
    label: 'anthropic',
    description: 'Anthropic Messages API（也支持 OAuth token）',
  },
]

/** Compat rule options for openai-compat providers. */
export const COMPAT_RULE_OPTIONS: readonly {
  value: CompatRule
  label: string
  description: string
}[] = [
  {
    value: 'strict-openai',
    label: 'strict-openai',
    description: '严格字段白名单（Cerebras、Qwen 等严格端点）',
  },
  {
    value: 'permissive',
    label: 'permissive',
    description: '宽松透传（大多数 vLLM/Ollama/OpenRouter）',
  },
  { value: 'cerebras', label: 'cerebras', description: 'Cerebras 端点' },
  { value: 'groq', label: 'groq', description: 'Groq 端点' },
  {
    value: 'deepseek',
    label: 'deepseek',
    description: 'DeepSeek 端点（含 reasoning_content 保留）',
  },
]

export const DEFAULT_KIND: ProviderKind = 'openai-compat'
export const DEFAULT_BASE_URL: Record<ProviderKind, string> = {
  'openai-compat': 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com',
  grok: 'https://api.x.ai/v1',
  anthropic: 'https://api.anthropic.com',
}

export function buildModelRef(providerId: string, modelId: string): string {
  return `${providerId}:${modelId}`
}

/** True when this provider id matches one of the built-in defaults. */
export function isBuiltinProvider(
  provider: ProviderConfig,
  builtin: readonly ProviderConfig[],
): boolean {
  return builtin.some(b => b.id === provider.id)
}

/** Whether the provider has a resolvable API key (direct or env). */
export function hasUsableKey(provider: ProviderConfig): boolean {
  return Boolean(resolveApiKey(provider))
}

/** Short summary used in list output. */
export function formatProviderRow(
  provider: ProviderConfig,
  builtin: readonly ProviderConfig[],
): {
  id: string
  kind: string
  baseUrl: string
  modelCount: string
  defaultModel: string
  keyStatus: string
  builtinBadge: string
} {
  const isBuiltin = isBuiltinProvider(provider, builtin)
  return {
    id: provider.id,
    kind: provider.kind,
    baseUrl: provider.baseUrl,
    modelCount: String(provider.models?.length ?? 0),
    defaultModel: provider.defaultModel ?? '-',
    keyStatus: hasUsableKey(provider) ? '有' : '无',
    builtinBadge: isBuiltin ? '(内置)' : '',
  }
}

/** Format the full provider table as plain text lines. */
export function formatProvidersTable(
  providers: readonly ProviderConfig[],
  builtin: readonly ProviderConfig[],
): string {
  const rows = providers.map(p => formatProviderRow(p, builtin))
  const headers = [
    'id',
    'kind',
    'baseUrl',
    '模型数',
    'defaultModel',
    'API key',
    '内置',
  ]
  const widths = rows.reduce(
    (acc, r) => ({
      id: Math.max(acc.id, r.id.length + (r.builtinBadge ? 4 : 0)),
      kind: Math.max(acc.kind, r.kind.length),
      baseUrl: Math.max(acc.baseUrl, r.baseUrl.length),
      modelCount: Math.max(acc.modelCount, r.modelCount.length),
      defaultModel: Math.max(acc.defaultModel, r.defaultModel.length),
      keyStatus: Math.max(acc.keyStatus, r.keyStatus.length),
    }),
    {
      id: headers[0]!.length,
      kind: headers[1]!.length,
      baseUrl: headers[2]!.length,
      modelCount: headers[3]!.length,
      defaultModel: headers[4]!.length,
      keyStatus: headers[5]!.length,
    },
  )

  const pad = (s: string, w: number): string =>
    s + ' '.repeat(Math.max(0, w - s.length))
  const lines: string[] = []
  lines.push(
    [
      pad(headers[0]!, widths.id),
      pad(headers[1]!, widths.kind),
      pad(headers[2]!, widths.baseUrl),
      pad(headers[3]!, widths.modelCount),
      pad(headers[4]!, widths.defaultModel),
      pad(headers[5]!, widths.keyStatus),
      headers[6]!,
    ].join('  '),
  )
  for (const r of rows) {
    lines.push(
      [
        pad(r.id + (r.builtinBadge ? ' (内置)' : ''), widths.id),
        pad(r.kind, widths.kind),
        pad(r.baseUrl, widths.baseUrl),
        pad(r.modelCount, widths.modelCount),
        pad(r.defaultModel, widths.defaultModel),
        pad(r.keyStatus, widths.keyStatus),
        r.builtinBadge,
      ].join('  '),
    )
  }
  return lines.join('\n')
}

/** Parse a provider kind string; returns null for invalid input. */
export function parseProviderKind(raw: string): ProviderKind | null {
  const result = ProviderKindSchema.safeParse(raw)
  return result.success ? result.data : null
}

/** Parse a compat rule string; returns null for invalid input. */
export function parseCompatRule(raw: string): CompatRule | null {
  const result = CompatRuleSchema.safeParse(raw)
  return result.success ? result.data : null
}
