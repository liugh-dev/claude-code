import { z } from 'zod'

/**
 * Compat rule identifiers. Each maps to a CompatProfile in providerCompatMatrix.ts.
 * Only meaningful for 'openai-compat' providers.
 */
export const CompatRuleSchema = z.enum([
  'cerebras',
  'groq',
  'deepseek',
  'strict-openai',
  'permissive',
])

export type CompatRule = z.infer<typeof CompatRuleSchema>

/**
 * Supported provider protocol kinds. Multiple instances of the same kind are
 * allowed; zero instances of a kind is also fine.
 */
export const ProviderKindSchema = z.enum([
  'openai-compat',
  'gemini',
  'grok',
  'anthropic',
])
export type ProviderKind = z.infer<typeof ProviderKindSchema>

/**
 * A remotely-fetched or manually-added model entry.
 */
export const ProviderModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
})
export type ProviderModel = z.infer<typeof ProviderModelSchema>

/**
 * Zod schema for a single provider configuration entry (providers.json v2).
 *
 * Rules:
 * - id: kebab-case identifier, unique across providers. Used as the
 *   `providerId` prefix in cross-provider model refs (`providerId:modelId`).
 * - kind: protocol family, one of openai-compat | gemini | grok | anthropic
 * - name: optional display name for UI
 * - baseUrl: full base URL including /v1 suffix if needed
 * - apiKey: API key stored directly in providers.json (file is chmod 600)
 * - apiKeyEnv: legacy v1 indirection — name of env var holding the key.
 *   resolveApiKey() prefers apiKey over the env var.
 * - compatRule: selects CompatProfile from providerCompatMatrix
 *   (only meaningful for openai-compat)
 * - models: remotely fetched or manually added model list
 * - modelsFetchedAt: ISO date of the last successful /models fetch
 */
export const ProviderConfigSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, 'id must be kebab-case'),
  kind: ProviderKindSchema,
  name: z.string().min(1).optional(),
  baseUrl: z.string().url(),
  apiKey: z.string().min(1).optional(),
  apiKeyEnv: z.string().min(1).optional(),
  compatRule: CompatRuleSchema.optional(),
  models: z.array(ProviderModelSchema).optional(),
  modelsFetchedAt: z.string().min(1).optional(),
})

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>

/**
 * Schema for ~/.claude/providers.json in v2 format.
 */
export const ProvidersFileSchema = z.object({
  version: z.literal(2),
  providers: z.array(ProviderConfigSchema),
})
export type ProvidersFile = z.infer<typeof ProvidersFileSchema>

/**
 * Legacy v1 format: the top level was a bare array of provider configs.
 * Used only to detect and migrate old files on load.
 */
export const ProvidersFileV1Schema = z.array(ProviderConfigSchema)
export type ProvidersFileV1 = z.infer<typeof ProvidersFileV1Schema>

/**
 * Resolve the effective API key for a provider.
 * Directly-stored apiKey wins over the legacy apiKeyEnv indirection.
 */
export function resolveApiKey(provider: ProviderConfig): string | undefined {
  if (provider.apiKey) return provider.apiKey
  if (provider.apiKeyEnv) return process.env[provider.apiKeyEnv]
  return undefined
}
