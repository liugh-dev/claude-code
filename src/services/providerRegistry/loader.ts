import { chmodSync, existsSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { logError } from '../../utils/log.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { atomicWriteJson } from './atomicWrite.js'
import {
  ProvidersFileSchema,
  ProvidersFileV1Schema,
  type ProviderConfig,
} from './types.js'

/**
 * Returns the path to the providers.json file in the Claude config directory.
 */
export function getProvidersFilePath(): string {
  return join(getClaudeConfigHomeDir(), 'providers.json')
}

// ── J1: per-process memoization with stale-on-invalidate ─────────────────────

let _cachedProviders: ProviderConfig[] | null = null
let _cachedUserProviders: ProviderConfig[] | null = null

/** Invalidate the in-process provider cache (called after saveProviders). */
export function _invalidateProviderCache(): void {
  _cachedProviders = null
  _cachedUserProviders = null
}

// ── Providers-changed subscription ───────────────────────────────────────────
//
// Per-provider client pools in src/services/api/{client.ts,openai/client.ts,
// grok/client.ts} cache OpenAI/Anthropic SDK clients keyed by providerId.
// When saveProviders() updates an apiKey/baseUrl, those cached clients become
// stale (they still hold the old credentials). To avoid requiring callers to
// remember to invalidate every pool, modules register a callback here that
// runs after every successful save.
//
// We deliberately do NOT import the api/* client modules from this file — that
// would create a circular import. Instead the client modules import
// `onProvidersChanged` from here at module-load time.

const _providersChangedListeners: Array<() => void> = []

/**
 * Register a callback to be invoked after every successful saveProviders().
 * Returns an unsubscribe function. Listeners are called synchronously in
 * registration order. Exceptions thrown by listeners are caught and logged
 * so one bad subscriber cannot prevent others from running.
 */
export function onProvidersChanged(cb: () => void): () => void {
  _providersChangedListeners.push(cb)
  return () => {
    const idx = _providersChangedListeners.indexOf(cb)
    if (idx >= 0) _providersChangedListeners.splice(idx, 1)
  }
}

function _notifyProvidersChanged(): void {
  for (const cb of _providersChangedListeners) {
    try {
      cb()
    } catch (err) {
      logError(
        err instanceof Error
          ? err
          : new Error(`onProvidersChanged listener threw: ${String(err)}`),
      )
    }
  }
}

/**
 * Load provider configurations.
 *
 * Strategy:
 * 1. If ~/.claude/providers.json exists, parse and validate it with Zod.
 *    - v2 format: { version: 2, providers: [...] }
 *    - v1 format (bare array): auto-migrated — entries are treated as the
 *      v2 `providers` list. `apiKeyEnv` indirection is preserved.
 * 2. No file / empty file / corrupt file: return [] (no providers configured).
 *
 * A1 fix: returns load diagnostics so callers (ProviderView) can surface errors.
 * J1 fix: memoized per-process; invalidated after saveProviders().
 *
 * This function never throws — corrupt files produce a warning + fallback.
 */
export function loadProviders(): ProviderConfig[] {
  // J1: return cached result if available (prevents repeated disk reads on findProvider)
  if (_cachedProviders !== null) return _cachedProviders

  const result = _loadProvidersInternal()
  _cachedProviders = result.providers
  // Seed the user-providers cache from the same disk read so that
  // loadUserProviders() can answer "did the user define this id?" without
  // re-parsing providers.json.
  if (_cachedUserProviders === null) {
    const { userProviders } = _readUserProvidersFromDisk()
    _cachedUserProviders = userProviders ?? []
  }
  return result.providers
}

/**
 * Load providers with diagnostic information.
 * Returns { providers, error? } — callers can surface the error to the UI.
 * A1 fix: exposes parse errors to UI layer instead of only logError.
 */
export function loadProvidersWithDiagnostic(): {
  providers: ProviderConfig[]
  error?: string
} {
  const result = _loadProvidersInternal()
  _cachedProviders = result.providers
  // Also seed the user-providers cache so loadUserProviders() reflects
  // the same on-disk state.
  const { userProviders } = _readUserProvidersFromDisk()
  _cachedUserProviders = userProviders ?? []
  return result
}

/**
 * Parse raw JSON into the v2 providers list, accepting the legacy v1
 * bare-array format. Returns undefined if neither schema matches.
 */
function parseProvidersJson(parsed: unknown): ProviderConfig[] | undefined {
  const v2 = ProvidersFileSchema.safeParse(parsed)
  if (v2.success) return v2.data.providers
  const v1 = ProvidersFileV1Schema.safeParse(parsed)
  if (v1.success) return v1.data
  return undefined
}

function _loadProvidersInternal(): {
  providers: ProviderConfig[]
  error?: string
} {
  const filePath = getProvidersFilePath()

  if (!existsSync(filePath)) {
    return { providers: [] }
  }

  // Permission audit: providers.json may contain apiKey material. If the file
  // is group/other readable, attempt to chmod 0600 to shrink the exposure
  // window. Failure is non-fatal but surfaced via the diagnostic `error`
  // field so the UI can warn the user.
  const permissionWarning = _auditProvidersPermissions(filePath)
  if (permissionWarning) {
    logError(new Error(permissionWarning))
  }

  const { userProviders, error: parseError } = _readUserProvidersFromDisk()
  if (parseError) {
    logError(new Error(parseError))
  }

  if (userProviders === null || userProviders.length === 0) {
    return permissionWarning
      ? { providers: [], error: permissionWarning }
      : { providers: [] }
  }

  return permissionWarning
    ? { providers: userProviders, error: permissionWarning }
    : { providers: userProviders }
}

/**
 * Read and parse ~/.claude/providers.json into a list of user-defined
 * providers (without merging with built-in defaults).
 *
 * Returns:
 * - { userProviders: ProviderConfig[], error?: string } on a valid file
 *   (an empty array is valid: the user has no providers configured).
 * - { userProviders: null, error: string } when the file is unreadable,
 *   malformed JSON, or fails schema validation. Callers fall back to
 *   built-in defaults in that case.
 *
 * This function never throws. It is the shared core used by both
 * loadProviders() (which merges with defaults) and loadUserProviders()
 * (which returns only the user entries).
 */
function _readUserProvidersFromDisk(): {
  userProviders: ProviderConfig[] | null
  error?: string
} {
  const filePath = getProvidersFilePath()
  if (!existsSync(filePath)) {
    // No file → no user providers and no error. Defaults handle everything.
    return { userProviders: [] }
  }

  let raw: string
  try {
    raw = readFileSync(filePath, 'utf-8')
  } catch (err: unknown) {
    const msg = `loadProviders: failed to read ${filePath}: ${err instanceof Error ? err.message : String(err)}`
    return { userProviders: null, error: msg }
  }

  if (!raw.trim()) {
    // Empty file → equivalent to no user providers.
    return { userProviders: [] }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    const msg = `loadProviders: ${filePath} is not valid JSON. Using default providers.`
    return { userProviders: null, error: msg }
  }

  const userProviders = parseProvidersJson(parsed)
  if (userProviders === undefined) {
    const msg = `loadProviders: ${filePath} failed schema validation. Using default providers.`
    return { userProviders: null, error: msg }
  }

  return { userProviders }
}

/**
 * Load ONLY the user-defined provider list (parsed from
 * ~/.claude/providers.json, without the built-in defaults merged in).
 *
 * Used by resolveModelRef() to distinguish:
 * - a pure built-in default id (no user override) → must have explicit
 *   credentials to dispatch
 * - a user-overridden built-in id OR a user-defined id → user has
 *   explicitly opted in, dispatch unconditionally
 *
 * Returns an empty array when providers.json is absent or invalid
 * (the loader falls back to built-in defaults for normal lookups).
 *
 * J1 fix: memoized per-process; invalidated by saveProviders() via
 * _invalidateProviderCache().
 */
export function loadUserProviders(): ProviderConfig[] {
  if (_cachedUserProviders !== null) return _cachedUserProviders
  const { userProviders } = _readUserProvidersFromDisk()
  _cachedUserProviders = userProviders ?? []
  return _cachedUserProviders
}

/**
 * Audit a providers.json file's permissions. If group/other readable, attempt
 * chmod 0600. Returns a warning message if chmod fails, otherwise undefined.
 *
 * Exposed for testing so the chmod failure path can be exercised without
 * fighting Bun's built-in fs mocking. The production loader calls this
 * from _loadProvidersInternal.
 */
export function _auditProvidersPermissions(
  filePath: string,
  chmodFn: (path: string, mode: number) => void = chmodSync,
): string | undefined {
  let stat: { mode: number }
  try {
    stat = statSync(filePath)
  } catch {
    return undefined
  }
  const mode = stat.mode & 0o777
  if (!(mode & 0o077)) return undefined
  try {
    chmodFn(filePath, 0o600)
    return undefined
  } catch (chmodErr: unknown) {
    return `loadProviders: ${filePath} has mode 0${mode
      .toString(8)
      .padStart(3, '0')} (group/other readable); chmod 0600 failed: ${
      chmodErr instanceof Error ? chmodErr.message : String(chmodErr)
    }`
  }
}

/**
 * Find a provider by id in the loaded list. Returns undefined if not found.
 */
export function findProvider(
  id: string,
  providers?: ProviderConfig[],
): ProviderConfig | undefined {
  return (providers ?? loadProviders()).find(p => p.id === id)
}

/**
 * Write providers to ~/.claude/providers.json.
 *
 * If a provider with the same id exists, it is replaced.
 *
 * Writes the v2 envelope ({ version: 2, providers: [...] }) and chmods the
 * file to 0600 since it may contain apiKey material.
 *
 * Atomicity:
 * - The tmp file is created in the SAME directory as the destination
 *   (dirname(filePath)), NOT in os.tmpdir(). Cross-filesystem rename from
 *   os.tmpdir() to ~/.claude/ would raise EXDEV on macOS/Linux when the two
 *   paths are on different mounts.
 * - The tmp file is written with mode 0o600 from the start, so the window
 *   where the apiKey is in plaintext on disk is owner-readable at most.
 * - The final destination is chmod 0600 as a defensive fallback (some FS /
 *   umask combinations can still apply a wider mode after rename).
 *
 * C3 fix: uses atomic tmp+rename write.
 * J1 fix: invalidates cache after write.
 *
 * Returns the list that was written.
 */
export function saveProviders(providers: ProviderConfig[]): ProviderConfig[] {
  const filePath = getProvidersFilePath()

  // Deduplicate by id (later entries win)
  const merged = new Map<string, ProviderConfig>()
  for (const p of providers) {
    merged.set(p.id, p)
  }
  const toWrite = Array.from(merged.values())

  // C3: atomic write — tmp file + rename prevents lost-update on concurrent save.
  // The tmp file lives next to the destination (see atomicWriteJson) so
  // rename() is guaranteed intra-filesystem (no EXDEV).
  atomicWriteJson(
    filePath,
    JSON.stringify({ version: 2, providers: toWrite }, null, 2),
  )

  // J1: invalidate cache so next loadProviders() reads fresh data
  _invalidateProviderCache()

  // Notify subscribers that providers.json changed so any cached clients
  // (per-provider SDK pools) can be cleared. This MUST run after cache
  // invalidation so newly-created clients will reflect the new config.
  _notifyProvidersChanged()

  return Array.from(merged.values())
}

/**
 * Add a new provider. Throws if a provider with the same id already exists.
 */
export function addProvider(provider: ProviderConfig): ProviderConfig[] {
  const existing = loadProviders()
  if (existing.some(p => p.id === provider.id)) {
    throw new Error(`addProvider: provider "${provider.id}" already exists`)
  }
  return saveProviders([...existing, provider])
}

/**
 * Remove a provider by id. Throws if not found.
 * Removing a built-in default id only removes its user-level override
 * (the built-in default remains visible on next load).
 */
export function removeProvider(id: string): ProviderConfig[] {
  const existing = loadProviders()
  const found = findProvider(id, existing)
  if (!found) {
    throw new Error(`removeProvider: provider "${id}" not found`)
  }
  return saveProviders(existing.filter(p => p.id !== id))
}

/**
 * Update an existing provider (matched by provider.id, which cannot change).
 * Throws if not found.
 */
export function updateProvider(provider: ProviderConfig): ProviderConfig[] {
  const existing = loadProviders()
  if (!existing.some(p => p.id === provider.id)) {
    throw new Error(`updateProvider: provider "${provider.id}" not found`)
  }
  return saveProviders(existing.map(p => (p.id === provider.id ? provider : p)))
}
