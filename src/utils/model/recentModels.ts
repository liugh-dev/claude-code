import {
  getSettings_DEPRECATED,
  updateSettingsForSource,
} from '../settings/settings.js'

const MAX_RECENT_MODELS = 6

/**
 * Return recently used model strings, most recent first.
 */
export function getRecentModels(): string[] {
  return getSettings_DEPRECATED()?.recentModels ?? []
}

/**
 * Record a model as recently used. Moves it to the front of the list and
 * trims to MAX_RECENT_MODELS.
 */
export function pushRecentModel(model: string): void {
  if (!model || model.trim() === '') return
  const current = getRecentModels().filter(m => m !== model)
  const updated = [model, ...current].slice(0, MAX_RECENT_MODELS)
  updateSettingsForSource('userSettings', { recentModels: updated })
}
