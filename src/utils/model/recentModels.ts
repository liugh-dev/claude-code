import {
  getSettings_DEPRECATED,
  updateSettingsForSource,
} from '../settings/settings.js'

const MAX_RECENT_MODELS = 6

// [1m]/[2m] are client-side context-window markers, not part of the model
// id. The recent list stores raw model names only so the /model picker's
// dedup against the provider list keeps each model in a single section.
function normalizeRecentModel(model: string): string {
  return model.replace(/\[(1|2)m\]$/i, '').trim()
}

/**
 * Return recently used model strings, most recent first. Entries are
 * normalized on read — legacy stored values carrying a [1m]/[2m] suffix
 * are stripped and deduped.
 */
export function getRecentModels(): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const entry of getSettings_DEPRECATED()?.recentModels ?? []) {
    const normalized = normalizeRecentModel(entry)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

/**
 * Record a model as recently used. Moves it to the front of the list and
 * trims to MAX_RECENT_MODELS. Any [1m]/[2m] marker is stripped before
 * storing — re-picking a recent entry never re-applies the 1M flag.
 */
export function pushRecentModel(model: string): void {
  const normalized = normalizeRecentModel(model)
  if (!normalized) return
  const current = getRecentModels().filter(m => m !== normalized)
  const updated = [normalized, ...current].slice(0, MAX_RECENT_MODELS)
  updateSettingsForSource('userSettings', { recentModels: updated })
}
