/**
 * Shared mock for src/utils/settings/settings.ts
 *
 * Cuts the settings→file-system bootstrap chain. Must be called via
 * mock.module("src/utils/settings/settings.js", settingsMock) BEFORE any
 * import that transitively depends on settings.ts.
 *
 * Exports every name that business code imports from this module, so a
 * partially-exported mock never leaks "Export named ... not found" into
 * later test files in the same process (Bun mock.module is process-global,
 * last-write-wins).
 *
 * Exported as a factory so each call produces a fresh object (mock.module requirement).
 */
export function settingsMock() {
  return {
    getInitialSettings: () => ({}),
    getSettings_DEPRECATED: () => ({}),
    getSettingsForSource: () => null,
    updateSettingsForSource: () => {},
  }
}
