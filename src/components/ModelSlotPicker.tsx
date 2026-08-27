import * as React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from '@anthropic/ink';
import { useKeybindings } from '../keybindings/useKeybinding.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import TextInput from './TextInput.js';
import { Select } from './CustomSelect/index.js';
import { Byline, KeyboardShortcutHint, Pane } from '@anthropic/ink';
import { loadProviders } from '../services/providerRegistry/loader.js';
import type { ProviderConfig } from '../services/providerRegistry/types.js';
import { fetchProviderModels } from '../services/providerRegistry/fetchModels.js';
import { getRecentModels, pushRecentModel } from '../utils/model/recentModels.js';
import { getSettings_DEPRECATED, updateSettingsForSource } from '../utils/settings/settings.js';
import { useSetAppState } from '../state/AppState.js';
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js';
import { has1mContext } from '../utils/context.js';

export type ModelSlotPickerProps = {
  onDone: (result?: string, options?: { display?: 'system' }) => void;
  onCancel?: () => void;
  isStandaloneCommand?: boolean;
};

type Mode = { type: 'input' } | { type: 'list'; slot: 'haiku' | 'main' };

// Strip a trailing [1m] suffix (case-insensitive) from a model string.
function strip1mSuffix(value: string): string {
  return value.replace(/\[1m\]$/i, '').trim();
}

/**
 * /model picker: two text inputs (main model = settings.model + session
 * override, light model = modelSlots.haiku), Tab to switch focus, Enter on
 * an empty field to open the provider model list for that slot.
 *
 * In the list, Space toggles a 1M-context flag (shown at the bottom of the
 * list); confirming a model with the flag on appends `[1m]` to the returned
 * model id (main slot only). Default is off.
 */
export function ModelSlotPicker({ onDone, onCancel, isStandaloneCommand }: ModelSlotPickerProps): React.ReactNode {
  const { columns } = useTerminalSize();
  const setAppState = useSetAppState();

  // Current values from settings
  const settings = getSettings_DEPRECATED();
  const initialHeavy = settings?.model ?? '';
  const [lightModel, setLightModel] = useState(settings?.modelSlots?.haiku ?? '');
  // Text field holds the raw model id. [1m] suffix from a prior setting is
  // preserved as-is in the text; the list-mode toggle only governs newly
  // picked models.
  const [heavyModel, setHeavyModel] = useState(initialHeavy);
  const [focusedSlot, setFocusedSlot] = useState<'haiku' | 'main'>('main');
  const [mode, setMode] = useState<Mode>({ type: 'input' });
  // 1M flag lives only in list mode — reset to off each time the list opens.
  const [listEnable1m, setListEnable1m] = useState(false);

  // Provider model list (fetched on mount)
  const [providerModels, setProviderModels] = useState<Array<{ value: string; label: string; description: string }>>(
    [],
  );
  const [loading, setLoading] = useState(true);
  const [fetchErrors, setFetchErrors] = useState<string[]>([]);

  const recentModels = useMemo(() => getRecentModels(), []);

  // Fetch models from all configured providers
  useEffect(() => {
    let cancelled = false;

    async function fetchAll(): Promise<void> {
      const providers = loadProviders();
      const results: Array<{
        value: string;
        label: string;
        description: string;
      }> = [];
      const errors: string[] = [];

      const fetchPromises = providers.map(async provider => {
        // Skip providers without a stored key (they can't be queried)
        if (!provider.apiKey) return;
        try {
          const models = await fetchProviderModels(provider);
          const label = provider.name ?? provider.id;
          for (const modelId of models) {
            results.push({
              value: `${provider.id}:${modelId}`,
              label: `[${provider.id}] ${modelId}`,
              description: `${label} (${provider.kind})`,
            });
          }
        } catch (err) {
          errors.push(`${provider.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      });

      await Promise.allSettled(fetchPromises);
      if (!cancelled) {
        setProviderModels(results);
        setFetchErrors(errors);
        setLoading(false);
      }
    }

    void fetchAll();
    return () => {
      cancelled = true;
    };
  }, []);

  // Recent and provider options are kept as separate lists so the list view
  // can render a visual separator between them and the focus can cross the
  // gap via onDownFromLastItem / onUpFromFirstItem.
  const recentOptions = useMemo(
    () =>
      recentModels.map(m => ({
        value: m,
        label: m,
        description: 'Recently used',
      })),
    [recentModels],
  );

  const providerOptions = useMemo(() => {
    const recentValues = new Set(recentModels);
    return providerModels.filter(m => !recentValues.has(m.value));
  }, [recentModels, providerModels]);

  // Which section owns focus in list mode: 'recent' or 'provider'. Recent is
  // empty until the user picks a model for the first time, so default to
  // whichever section has items. Recomputed each time the list opens.
  const [listSection, setListSection] = useState<'recent' | 'provider'>('recent');

  // Control focus across the two Select components. Each Select drives its
  // own internal focus; we tell it which value to focus on via focusValue, and
  // jump sections by switching listSection + setting the target value.
  const [recentFocusValue, setRecentFocusValue] = useState<string | undefined>(undefined);
  const [providerFocusValue, setProviderFocusValue] = useState<string | undefined>(undefined);

  // Handle list selection for a slot
  const handleListSelect = useCallback(
    (value: string) => {
      if (mode.type !== 'list') return;
      if (mode.slot === 'haiku') {
        setLightModel(value);
      } else {
        // Apply the list-mode 1M flag to the main model on confirm.
        setHeavyModel(listEnable1m ? `${strip1mSuffix(value)}[1m]` : value);
      }
      setMode({ type: 'input' });
    },
    [listEnable1m, mode],
  );

  // Save and exit
  const handleConfirm = useCallback(() => {
    const trimmedHeavy = heavyModel.trim();
    const trimmedLight = lightModel.trim();

    const slots: Record<string, string | undefined> = {
      ...getSettings_DEPRECATED()?.modelSlots,
    };
    if (trimmedLight) {
      slots.haiku = trimmedLight;
      pushRecentModel(trimmedLight);
    }

    // Main model: persist to settings.model and update the session override
    // so the change takes effect on the next request without a restart.
    if (trimmedHeavy) {
      updateSettingsForSource('userSettings', { model: trimmedHeavy });
      setAppState(prev => ({
        ...prev,
        mainLoopModel: trimmedHeavy,
        mainLoopModelForSession: null,
      }));
      pushRecentModel(trimmedHeavy);
    }
    updateSettingsForSource('userSettings', {
      modelSlots: slots as { opus?: string; sonnet?: string; haiku?: string },
    });

    const parts: string[] = [];
    if (trimmedHeavy) parts.push(`Main: ${trimmedHeavy}`);
    if (trimmedLight) parts.push(`Light: ${trimmedLight}`);
    if (parts.length === 0) parts.push('No changes');

    onDone(parts.join('\n'), { display: 'system' });
  }, [heavyModel, lightModel, onDone, setAppState]);

  // Cancel
  const handleCancel = useCallback(() => {
    onCancel?.() ?? onDone('Model unchanged', { display: 'system' });
  }, [onCancel, onDone]);

  // Open the model list for a slot, resetting the 1M flag and pointing focus
  // at the first section that has items (recent takes priority, then provider).
  const openList = useCallback(
    (slot: 'haiku' | 'main') => {
      setListEnable1m(false);
      setListSection(recentOptions.length > 0 ? 'recent' : 'provider');
      setRecentFocusValue(undefined);
      setProviderFocusValue(undefined);
      setMode({ type: 'list', slot });
    },
    [recentOptions.length],
  );

  // Keybindings for the input mode
  useKeybindings(
    {
      'modelPicker:toggleSlot': () => {
        setFocusedSlot(prev => (prev === 'main' ? 'haiku' : 'main'));
      },
      'modelPicker:openList': () => {
        openList(focusedSlot);
      },
    },
    { context: 'ModelPicker' },
  );

  // In list mode, Space toggles the 1M flag. Select's own useInput only
  // consumes Space for multi-select (this Select is single-choice), so the
  // keystroke falls through to this handler. Arrows/Enter/Esc are handled by
  // Select's keybindings (context: 'Select') and never reach here.
  useInput(
    (input, _key, event) => {
      if (mode.type !== 'list') return;
      if (input === ' ') {
        setListEnable1m(prev => !prev);
        event.stopImmediatePropagation();
      }
    },
    { isActive: mode.type === 'list' },
  );

  // In input mode, Up/Down switches focus between the two text fields. The
  // BaseTextInput handlers register first (child effects fire before parent)
  // and consume arrow keys as cursor movement, but on a single-line field
  // cursor.up()/down() is a no-op and does not stop propagation — so the
  // event reaches this handler.
  useInput(
    (_input, key, event) => {
      if (mode.type !== 'input') return;
      if (key.upArrow || key.downArrow) {
        setFocusedSlot(prev => (prev === 'main' ? 'haiku' : 'main'));
        event.stopImmediatePropagation();
      }
    },
    { isActive: mode.type === 'input' },
  );

  // List mode
  if (mode.type === 'list') {
    const slotLabel = mode.slot === 'haiku' ? 'Light model' : 'Main model';
    const hasRecent = recentOptions.length > 0;
    const hasProvider = providerOptions.length > 0;
    const showSeparator = hasRecent && hasProvider;

    return (
      <Pane color="permission">
        <Box flexDirection="column">
          <Box marginBottom={1} flexDirection="column">
            <Text color="remember" bold>
              Select {slotLabel}
            </Text>
            <Text dimColor>
              Choose a model for the {mode.slot === 'haiku' ? 'light (background tasks)' : 'main (heavy lifting)'} slot.
            </Text>
          </Box>
          {loading ? (
            <Text dimColor>Fetching models from providers…</Text>
          ) : !hasRecent && !hasProvider ? (
            <Box flexDirection="column">
              <Text dimColor>No models available. Configure providers with /providers add first.</Text>
              {fetchErrors.length > 0 && (
                <Box marginTop={1} flexDirection="column">
                  {fetchErrors.map((err, i) => (
                    <Text key={i} dimColor color="error">
                      {err}
                    </Text>
                  ))}
                </Box>
              )}
            </Box>
          ) : (
            <Box flexDirection="column">
              {hasRecent && (
                <Select
                  options={recentOptions}
                  onChange={handleListSelect}
                  onCancel={() => setMode({ type: 'input' })}
                  isDisabled={listSection !== 'recent'}
                  focusValue={listSection === 'recent' ? recentFocusValue : recentOptions[0]?.value}
                  onDownFromLastItem={
                    showSeparator
                      ? () => {
                          setListSection('provider');
                          setProviderFocusValue(providerOptions[0]?.value);
                        }
                      : undefined
                  }
                />
              )}
              {showSeparator && (
                <Box marginY={0}>
                  <Text dimColor>{'─'.repeat(Math.max(8, Math.min(columns - 4, 60)))}</Text>
                </Box>
              )}
              {hasProvider && (
                <Select
                  options={providerOptions}
                  onChange={handleListSelect}
                  onCancel={() => setMode({ type: 'input' })}
                  isDisabled={listSection !== 'provider'}
                  focusValue={listSection === 'provider' ? providerFocusValue : undefined}
                  onUpFromFirstItem={
                    showSeparator
                      ? () => {
                          setListSection('recent');
                          setRecentFocusValue(recentOptions[recentOptions.length - 1]?.value);
                        }
                      : undefined
                  }
                />
              )}
              {mode.slot === 'main' && (
                <Box marginTop={1} flexDirection="column">
                  <Text color={listEnable1m ? 'claude' : 'subtle'}>
                    {listEnable1m ? '●' : '○'} 1M context: {listEnable1m ? 'on' : 'off'}
                    <Text color="subtle"> · Space to toggle</Text>
                  </Text>
                  {listEnable1m && <Text dimColor>Confirming will append [1m] to the selected model id.</Text>}
                </Box>
              )}
            </Box>
          )}
        </Box>
      </Pane>
    );
  }

  // Input mode
  const inputWidth = columns - 20;

  return (
    <Pane color="permission">
      <Box flexDirection="column">
        <Box marginBottom={1} flexDirection="column">
          <Text color="remember" bold>
            Model Configuration
          </Text>
          <Text dimColor>
            Set the main model (primary conversation loop) and light model (background tasks: token counting, session
            search, memory extraction). Tab or ↑/↓ to switch field, Enter on empty field to browse models.
          </Text>
        </Box>

        {/* Main model input */}
        <Box marginBottom={1} flexDirection="column">
          <Text bold={focusedSlot === 'main'} color={focusedSlot === 'main' ? 'claude' : undefined}>
            Main model (primary)
          </Text>
          <Box borderDimColor borderStyle="round" paddingLeft={1}>
            <TextInput
              focus={focusedSlot === 'main'}
              showCursor={focusedSlot === 'main'}
              value={heavyModel}
              onChange={setHeavyModel}
              onSubmit={() => {
                if (focusedSlot !== 'main') return;
                if (heavyModel.trim() === '') {
                  openList('main');
                } else {
                  handleConfirm();
                }
              }}
              placeholder="provider-id:model-name, or Enter to browse"
              columns={inputWidth}
              cursorOffset={heavyModel.length}
              onChangeCursorOffset={() => {}}
            />
          </Box>
        </Box>

        {/* Light model input */}
        <Box marginBottom={1} flexDirection="column">
          <Text bold={focusedSlot === 'haiku'} color={focusedSlot === 'haiku' ? 'claude' : undefined}>
            Light model (background tasks)
          </Text>
          <Box borderDimColor borderStyle="round" paddingLeft={1}>
            <TextInput
              focus={focusedSlot === 'haiku'}
              showCursor={focusedSlot === 'haiku'}
              value={lightModel}
              onChange={setLightModel}
              onSubmit={() => {
                if (focusedSlot !== 'haiku') return;
                if (lightModel.trim() === '') {
                  openList('haiku');
                } else {
                  handleConfirm();
                }
              }}
              placeholder="provider-id:model-name, or Enter to browse"
              columns={inputWidth}
              cursorOffset={lightModel.length}
              onChangeCursorOffset={() => {}}
            />
          </Box>
        </Box>

        {/* Recent models hint */}
        {recentModels.length > 0 && (
          <Box marginBottom={1} flexDirection="column">
            <Text dimColor>Recent: {recentModels.slice(0, 3).join(' · ')}</Text>
          </Box>
        )}

        {loading && (
          <Box marginBottom={1}>
            <Text dimColor>Fetching models from providers…</Text>
          </Box>
        )}

        {isStandaloneCommand && (
          <Text dimColor italic>
            <Byline>
              <KeyboardShortcutHint shortcut="Enter" action="confirm / browse (empty field)" />
              <KeyboardShortcutHint shortcut="Tab / ↑↓" action="switch field" />
              <ConfigurableShortcutHint action="select:cancel" context="Select" fallback="Esc" description="exit" />
            </Byline>
          </Text>
        )}
      </Box>
    </Pane>
  );
}
