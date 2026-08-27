import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import type { SettingsJson } from '../../settings/types.js'
// Captured BEFORE our mock is registered so afterAll can restore whatever
// was active when this file loaded (possibly another file's mock).
import * as prevSettingsModule from '../../../utils/settings/settings.js'

/**
 * Verifies settings.json modelSlots ({opus,sonnet,haiku}) take priority over
 * the env-var chain in getDefault*Model(). Slot values may be plain model
 * IDs or cross-provider refs ('providerId:modelId') — they are returned
 * verbatim; routing happens later in the query layer.
 *
 * Mock strategy (mirrors src/commands/poor/__tests__/poorMode.test.ts):
 * other test files mock.module('src/utils/settings/settings.js')
 * process-globally and Bun links static imports before our own mock.module
 * would run, so the module under test is pulled in via dynamic import AFTER
 * our full-surface mock is registered. The mock must be full-surface:
 * partial mocks cause link errors for unrelated modules in the chain.
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
  updateSettingsForSource: () => {},
}))

afterAll(() => {
  mock.restore()
  mock.module('src/utils/settings/settings.js', () => prevSettingsModule)
})

// Import AFTER the mock is registered. The query suffix gives this file its
// own module instance so cross-file model.js state cannot leak in. The path
// is kept in a variable (with a typeof cast) so tsc does not try to resolve
// the query-suffixed specifier — same pattern as poorMode.test.ts.
const modelModulePath = '../model.js?modelSlotsTest'
const { getDefaultHaikuModel, getDefaultOpusModel, getDefaultSonnetModel } =
  (await import(modelModulePath)) as typeof import('../model.js')
const configsModulePath = '../configs.js?modelSlotsTest'
const { ALL_MODEL_CONFIGS } = (await import(
  configsModulePath
)) as typeof import('../configs.js')
const { resetModelStringsForTestingOnly } = await import(
  'src/bootstrap/state.js'
)

const envKeys = [
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_GROK',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'OPENAI_DEFAULT_OPUS_MODEL',
  'GEMINI_DEFAULT_OPUS_MODEL',
] as const

const savedEnv: Record<string, string | undefined> = {}

describe('modelSlots priority', () => {
  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
    currentSettings = {}
    resetModelStringsForTestingOnly()
  })

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key]
      } else {
        delete process.env[key]
      }
    }
    currentSettings = {}
    resetModelStringsForTestingOnly()
  })

  test('opus slot wins over env vars and provider defaults', () => {
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'claude-opus-env'
    currentSettings = { modelSlots: { opus: 'opencode-go:glm-5.2' } }
    expect(getDefaultOpusModel()).toBe('opencode-go:glm-5.2')
  })

  test('sonnet slot wins over env vars and provider defaults', () => {
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'claude-sonnet-env'
    currentSettings = { modelSlots: { sonnet: 'deepseek:deepseek-chat' } }
    expect(getDefaultSonnetModel()).toBe('deepseek:deepseek-chat')
  })

  test('haiku slot wins over env vars and provider defaults', () => {
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'claude-haiku-env'
    currentSettings = { modelSlots: { haiku: 'my-gemini:gemini-2.5-flash' } }
    expect(getDefaultHaikuModel()).toBe('my-gemini:gemini-2.5-flash')
  })

  test('plain (non-ref) slot values are returned verbatim', () => {
    currentSettings = { modelSlots: { sonnet: 'claude-sonnet-custom' } }
    expect(getDefaultSonnetModel()).toBe('claude-sonnet-custom')
  })

  test('empty-string slot falls through to the env chain', () => {
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'claude-opus-env'
    currentSettings = { modelSlots: { opus: '   ' } }
    expect(getDefaultOpusModel()).toBe('claude-opus-env')
  })

  test('absent slot falls through to built-in defaults', () => {
    currentSettings = { modelSlots: { haiku: 'my-gemini:gemini-2.5-flash' } }
    expect(getDefaultOpusModel()).toBe(ALL_MODEL_CONFIGS.opus47.firstParty)
    expect(getDefaultHaikuModel()).toBe('my-gemini:gemini-2.5-flash')
  })

  test('missing modelSlots key keeps existing behavior', () => {
    currentSettings = {}
    expect(getDefaultOpusModel()).toBe(ALL_MODEL_CONFIGS.opus47.firstParty)
  })
})
