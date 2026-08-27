import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { SettingsJson } from '../../settings/types.js'
// Captured BEFORE our mock is registered so afterAll can restore whatever
// was active when this file loaded (possibly another file's mock).
import * as prevSettingsModule from '../../../utils/settings/settings.js'

/**
 * Verifies the recent-models store keeps raw model names: [1m]/[2m]
 * context-window markers are stripped on write and on read (legacy stored
 * entries), so the /model picker's dedup against the provider list keeps
 * each model in a single section.
 *
 * Mock strategy mirrors modelSlots.test.ts: other test files mock.module
 * settings.js process-globally, so the module under test is pulled in via
 * dynamic import AFTER a full-surface mock is registered.
 */

let currentSettings: SettingsJson = {}

mock.module('src/utils/settings/settings.js', () => ({
  loadManagedFileSettings: () => ({ settings: null, errors: [] }),
  getManagedFileSettingsPresence: () => ({ hasBase: false, hasDropIns: false }),
  parseSettingsFile: () => ({ settings: null, errors: [] }),
  getSettingsRootPathForSource: () => '',
  getSettingsFilePathForSource: () => undefined,
  getRelativeSettingsFilePathForSource: () => '',
  getInitialSettings: () => currentSettings,
  getSettingsForSource: () => null,
  getPolicySettingsOrigin: () => null,
  getSettingsWithErrors: () => ({ settings: currentSettings, errors: [] }),
  getSettingsWithSources: () => ({ effective: currentSettings, sources: [] }),
  getSettings_DEPRECATED: () => currentSettings,
  settingsMergeCustomizer: () => undefined,
  getManagedSettingsKeysForLogging: () => [],
  hasAutoModeOptIn: () => true,
  hasSkipDangerousModePermissionPrompt: () => false,
  getAutoModeConfig: () => undefined,
  getUseAutoModeDuringPlan: () => true,
  rawSettingsContainsKey: (key: string) => key in currentSettings,
  updateSettingsForSource: (_source: string, patch: Partial<SettingsJson>) => {
    currentSettings = { ...currentSettings, ...patch }
  },
}))

afterAll(() => {
  mock.restore()
  mock.module('src/utils/settings/settings.js', () => prevSettingsModule)
})

const modulePath = '../recentModels.js?recentModelsTest'
const { getRecentModels, pushRecentModel } = (await import(
  modulePath
)) as typeof import('../recentModels.js')

describe('pushRecentModel', () => {
  beforeEach(() => {
    currentSettings = {}
  })

  test('stores the raw model name, stripping a [1m] suffix', () => {
    pushRecentModel('glm:glm-5.3-flash[1m]')
    expect(currentSettings.recentModels).toEqual(['glm:glm-5.3-flash'])
    expect(getRecentModels()).toEqual(['glm:glm-5.3-flash'])
  })

  test('strips [2m] suffixes too, case-insensitively', () => {
    pushRecentModel('p:model[2M]')
    expect(getRecentModels()).toEqual(['p:model'])
  })

  test('moves an existing model to the front instead of duplicating', () => {
    pushRecentModel('a:m1')
    pushRecentModel('a:m2')
    pushRecentModel('a:m1')
    expect(getRecentModels()).toEqual(['a:m1', 'a:m2'])
  })

  test('re-picking a [1m] entry replaces the legacy stored entry', () => {
    currentSettings = { recentModels: ['glm:glm-5.3-flash[1m]'] }
    pushRecentModel('glm:glm-5.3-flash[1m]')
    expect(getRecentModels()).toEqual(['glm:glm-5.3-flash'])
  })

  test('trims the list to the 6 most recent entries', () => {
    for (let i = 0; i < 8; i++) pushRecentModel(`p:m${i}`)
    expect(getRecentModels()).toEqual([
      'p:m7',
      'p:m6',
      'p:m5',
      'p:m4',
      'p:m3',
      'p:m2',
    ])
  })

  test('ignores empty and marker-only input', () => {
    pushRecentModel('')
    pushRecentModel('   ')
    pushRecentModel('[1m]')
    expect(getRecentModels()).toEqual([])
  })
})

describe('getRecentModels normalization', () => {
  beforeEach(() => {
    currentSettings = {}
  })

  test('strips and dedupes legacy [1m] entries from stored settings', () => {
    currentSettings = {
      recentModels: [
        'glm:glm-5.3-flash[1m]',
        'opencode-go:glm-5.2',
        'glm:glm-5.3-flash',
      ],
    }
    // First occurrence wins; the later plain duplicate is dropped.
    expect(getRecentModels()).toEqual([
      'glm:glm-5.3-flash',
      'opencode-go:glm-5.2',
    ])
  })
})
