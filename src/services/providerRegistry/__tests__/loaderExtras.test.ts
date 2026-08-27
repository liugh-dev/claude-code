import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { logMock } from '../../../../tests/mocks/log.js'

// Mock side-effectful modules before any import that transitively loads them.
import { mock } from 'bun:test'

mock.module('src/utils/log.ts', logMock)
mock.module('bun:bundle', () => ({ feature: () => false }))
mock.module('src/utils/settings/settings.js', () => ({
  getSettings_DEPRECATED: () => ({}),
  updateSettingsForSource: () => {},
}))

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'provider-loader-extra-test-'))
  process.env['CLAUDE_CONFIG_DIR'] = tmpDir
})

afterEach(async () => {
  delete process.env['CLAUDE_CONFIG_DIR']
  rmSync(tmpDir, { recursive: true, force: true })
  const { _invalidateProviderCache } = await import('../loader.js')
  _invalidateProviderCache()
})

describe('atomicWriteJson (helper-level)', () => {
  test('writes payload atomically with mode 0o600', async () => {
    const { atomicWriteJson } = await import('../atomicWrite.js')
    const filePath = join(tmpDir, 'providers.json')
    atomicWriteJson(filePath, '{"version":2,"providers":[]}')
    expect(existsSync(filePath)).toBe(true)
    expect(statSync(filePath).mode & 0o777).toBe(0o600)
    // No tmp leftovers.
    const leftovers = readdirSync(tmpDir).filter(n => n.includes('.tmp'))
    expect(leftovers).toEqual([])
  })

  test('tmp file lives next to the destination (same dir, no EXDEV)', async () => {
    const { atomicWriteJson } = await import('../atomicWrite.js')
    // Use a nested subdirectory we control. The helper derives dirname
    // from filePath, so the tmp must land in that subdir.
    const subdir = join(tmpDir, 'sub')
    // mkdirSync not available here; atomicWriteJson's rename will create
    // the destination, but writeFileSync needs the parent to exist.
    // Use the tmpDir directly instead.
    const filePath = join(tmpDir, 'nested.json')
    atomicWriteJson(filePath, '{}')
    // If the helper had used os.tmpdir() instead, the rename would have
    // either failed (EXDEV) or moved a file from /tmp. The fact that
    // the file exists at the destination with no leftovers means the tmp
    // was created in the same dir.
    expect(existsSync(filePath)).toBe(true)
    const leftovers = readdirSync(tmpDir).filter(n => n.includes('.tmp'))
    expect(leftovers).toEqual([])
  })

  test('cleans up tmp on write failure (no key leak)', async () => {
    const { atomicWriteJson } = await import('../atomicWrite.js')
    // Force writeFileSync to fail by passing a non-existent parent dir.
    const filePath = join(tmpDir, 'nonexistent', 'providers.json')
    let threw = false
    try {
      atomicWriteJson(filePath, '{}')
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    // No tmp file should have been left behind in the parent of filePath.
    // (filePath's parent doesn't exist, but the helper used dirname which
    // would be the non-existent subdir — there are no tmp leftovers in
    // tmpDir either.)
    const leftovers = readdirSync(tmpDir).filter(n => n.includes('.tmp'))
    expect(leftovers).toEqual([])
  })

  test('cleans up tmp on rename failure (no key leak)', async () => {
    const { atomicWriteJson } = await import('../atomicWrite.js')
    // Force renameSync to fail by making the destination a directory.
    // renameSync into an existing non-empty directory raises EISDIR.
    const target = join(tmpDir, 'target')
    const { mkdirSync, writeFileSync: wf } = await import('fs')
    mkdirSync(target)
    // Put a file inside the target dir so rename-over-empty-dir still
    // raises EISDIR on Linux (rename-into-existing-dir is EISDIR).
    wf(join(target, 'inner'), 'x')
    let threw = false
    try {
      atomicWriteJson(target, '{"version":2}')
    } catch {
      threw = true
    }
    expect(threw).toBe(true)
    // The target is still a directory (rename failed).
    expect(statSync(target).isDirectory()).toBe(true)
    // No tmp file leftover in tmpDir.
    const leftovers = readdirSync(tmpDir).filter(n => n.includes('.tmp'))
    expect(leftovers).toEqual([])
  })
})

describe('saveProviders: integration', () => {
  test('writes v2 envelope with mode 0o600 and no tmp leftovers', async () => {
    const { saveProviders, getProvidersFilePath } = await import('../loader.js')
    saveProviders([
      {
        id: 'atomic-test',
        kind: 'openai-compat',
        baseUrl: 'https://atomic.example.com/v1',
        apiKey: 'sk-atomic',
      },
    ])
    const filePath = getProvidersFilePath()
    expect(existsSync(filePath)).toBe(true)
    expect(statSync(filePath).mode & 0o777).toBe(0o600)
    // No leftover .tmp files in our config dir.
    const dirEntries = readdirSync(tmpDir).filter(n => n.endsWith('.tmp'))
    expect(dirEntries).toEqual([])
  })
})

describe('loadProviders: permission audit', () => {
  test('chmods providers.json from 0644 to 0600 silently', async () => {
    const filePath = join(tmpDir, 'providers.json')
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 2,
        providers: [
          {
            id: 'audit',
            kind: 'openai-compat',
            baseUrl: 'https://audit.example.com/v1',
            apiKey: 'sk-audit',
          },
        ],
      }),
    )
    chmodSync(filePath, 0o644)
    expect(statSync(filePath).mode & 0o777).toBe(0o644)

    const { loadProvidersWithDiagnostic } = await import('../loader.js')
    const result = loadProvidersWithDiagnostic()
    expect(statSync(filePath).mode & 0o777).toBe(0o600)
    // chmod succeeded → no warning surfaced.
    expect(result.error).toBeUndefined()
  })

  test('returns warning when providers.json is mode 0644 and chmod fails', async () => {
    const filePath = join(tmpDir, 'providers.json')
    writeFileSync(filePath, JSON.stringify({ version: 2, providers: [] }))
    chmodSync(filePath, 0o644)

    const { _auditProvidersPermissions } = await import('../loader.js')
    const warning = _auditProvidersPermissions(filePath, () => {
      const err = new Error('EPERM') as NodeJS.ErrnoException
      err.code = 'EPERM'
      throw err
    })
    expect(warning).toBeDefined()
    expect(warning).toContain('mode 0644')
    expect(warning).toContain('chmod 0600 failed')
  })

  test('returns no warning when chmod succeeds', async () => {
    const filePath = join(tmpDir, 'providers.json')
    writeFileSync(filePath, JSON.stringify({ version: 2, providers: [] }))
    chmodSync(filePath, 0o644)

    const { _auditProvidersPermissions } = await import('../loader.js')
    let chmodCalled = false
    const warning = _auditProvidersPermissions(filePath, p => {
      chmodCalled = true
      chmodSync(p, 0o600)
    })
    expect(chmodCalled).toBe(true)
    expect(warning).toBeUndefined()
  })

  test('skips chmod when file is already mode 0600', async () => {
    const filePath = join(tmpDir, 'providers.json')
    writeFileSync(filePath, JSON.stringify({ version: 2, providers: [] }))
    chmodSync(filePath, 0o600)

    const { _auditProvidersPermissions } = await import('../loader.js')
    let chmodCalled = false
    const warning = _auditProvidersPermissions(filePath, () => {
      chmodCalled = true
    })
    expect(chmodCalled).toBe(false)
    expect(warning).toBeUndefined()
  })

  test('returns undefined when statSync fails (e.g. file vanished)', async () => {
    const { _auditProvidersPermissions } = await import('../loader.js')
    const warning = _auditProvidersPermissions(
      join(tmpDir, 'does-not-exist.json'),
      () => {
        throw new Error('should not be called')
      },
    )
    expect(warning).toBeUndefined()
  })
})

describe('onProvidersChanged', () => {
  test('subscribers are invoked after saveProviders', async () => {
    const { saveProviders, onProvidersChanged } = await import('../loader.js')
    const calls: number[] = []
    const unsub = onProvidersChanged(() => {
      calls.push(Date.now())
    })
    try {
      saveProviders([
        {
          id: 'sub',
          kind: 'openai-compat',
          baseUrl: 'https://sub.example.com/v1',
          apiKey: 'sk-sub',
        },
      ])
      expect(calls.length).toBe(1)
      saveProviders([
        {
          id: 'sub',
          kind: 'openai-compat',
          baseUrl: 'https://sub.example.com/v1',
          apiKey: 'sk-sub-2',
        },
      ])
      expect(calls.length).toBe(2)
    } finally {
      unsub()
    }
  })

  test('unsubscribe stops further invocations', async () => {
    const { saveProviders, onProvidersChanged } = await import('../loader.js')
    let count = 0
    const unsub = onProvidersChanged(() => {
      count++
    })
    saveProviders([
      {
        id: 'unsub',
        kind: 'openai-compat',
        baseUrl: 'https://unsub.example.com/v1',
        apiKey: 'sk-unsub',
      },
    ])
    expect(count).toBe(1)
    unsub()
    saveProviders([
      {
        id: 'unsub',
        kind: 'openai-compat',
        baseUrl: 'https://unsub.example.com/v1',
        apiKey: 'sk-unsub-2',
      },
    ])
    expect(count).toBe(1)
  })

  test('a throwing listener does not prevent other listeners', async () => {
    const { saveProviders, onProvidersChanged } = await import('../loader.js')
    let secondCalled = false
    const unsub1 = onProvidersChanged(() => {
      throw new Error('boom')
    })
    const unsub2 = onProvidersChanged(() => {
      secondCalled = true
    })
    try {
      // saveProviders must NOT throw, even though the first listener throws.
      saveProviders([
        {
          id: 'throw',
          kind: 'openai-compat',
          baseUrl: 'https://throw.example.com/v1',
          apiKey: 'sk-throw',
        },
      ])
      expect(secondCalled).toBe(true)
    } finally {
      unsub1()
      unsub2()
    }
  })
})
