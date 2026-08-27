import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

/**
 * Verifies that 'providerId:modelId' cross-provider strings pass through the
 * model-resolution layers untouched (the provider prefix is parsed later, at
 * the request dispatch point in claude.ts — never here).
 *
 * The settings module is mocked with an empty settings object because other
 * test files mock.module('src/utils/settings/settings.js') process-globally —
 * without our own registration, a polluted modelType could flip
 * getAPIProvider() and change parseUserSpecifiedModel's behavior.
 */
mock.module('src/utils/settings/settings.js', () => ({
  getSettings_DEPRECATED: () => ({}),
  getInitialSettings: () => ({}),
  getSettingsForSource: () => null,
  updateSettingsForSource: () => {},
}))

import { resetModelStringsForTestingOnly } from 'src/bootstrap/state.js'
import { getAgentModel } from '../agent.js'
import { parseUserSpecifiedModel } from '../model.js'

const envKeys = [
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_GROK',
  'CLAUDE_CODE_SUBAGENT_MODEL',
] as const

const savedEnv: Record<string, string | undefined> = {}

function resetState(): void {
  resetModelStringsForTestingOnly()
}

describe('parseUserSpecifiedModel passthrough', () => {
  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
    resetState()
  })

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key]
      } else {
        delete process.env[key]
      }
    }
    resetState()
  })

  test('provider:model strings are returned verbatim', () => {
    expect(parseUserSpecifiedModel('opencode-go:glm-5.2')).toBe(
      'opencode-go:glm-5.2',
    )
  })

  test('original case is preserved for provider:model strings', () => {
    expect(parseUserSpecifiedModel('MyProvider:GLM-5.2')).toBe(
      'MyProvider:GLM-5.2',
    )
  })

  test('modelId may contain further colons', () => {
    expect(parseUserSpecifiedModel('my-gemini:gemini-2.5-pro:beta')).toBe(
      'my-gemini:gemini-2.5-pro:beta',
    )
  })

  test('Bedrock ARNs pass through unchanged (registry guard is downstream)', () => {
    const arn =
      'arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-v2'
    expect(parseUserSpecifiedModel(arn)).toBe(arn)
  })
})

describe('getAgentModel passthrough', () => {
  beforeEach(() => {
    for (const key of envKeys) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }
    resetState()
  })

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key]
      } else {
        delete process.env[key]
      }
    }
    resetState()
  })

  test('agent-level provider:model string reaches the subagent query verbatim', () => {
    expect(getAgentModel('opencode-go:glm-5.2', 'claude-sonnet-4-6')).toBe(
      'opencode-go:glm-5.2',
    )
  })

  test('CLAUDE_CODE_SUBAGENT_MODEL provider:model string passes through', () => {
    process.env.CLAUDE_CODE_SUBAGENT_MODEL = 'deepseek:deepseek-reasoner'
    expect(getAgentModel(undefined, 'claude-sonnet-4-6')).toBe(
      'deepseek:deepseek-reasoner',
    )
  })
})
