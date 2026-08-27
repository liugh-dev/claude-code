import figures from 'figures';
import * as React from 'react';
import { useState } from 'react';
import { Box, Dialog, LoadingState, Text, useKeybinding } from '@anthropic/ink';
import { Select } from '../../components/CustomSelect/index.js';
import TextInput from '../../components/TextInput.js';
import { COMMON_HELP_ARGS } from '../../constants/xml.js';
import {
  addProvider,
  DEFAULT_PROVIDERS,
  findProvider,
  loadProviders,
  removeProvider,
} from '../../services/providerRegistry/loader.js';
import { fetchProviderModels } from '../../services/providerRegistry/fetchModels.js';
import type { CompatRule, ProviderConfig, ProviderKind } from '../../services/providerRegistry/types.js';
import type { LocalJSXCommandCall, LocalJSXCommandOnDone } from '../../types/command.js';
import { updateSettingsForSource } from '../../utils/settings/settings.js';
import {
  buildModelRef,
  COMPAT_RULE_OPTIONS,
  DEFAULT_BASE_URL,
  formatProvidersTable,
  PROVIDER_KIND_OPTIONS,
  validateBaseUrl,
  validateProviderId,
} from './logic.js';

// ──── /providers list ──────────────────────────────────────────────────────────

function ListProviders({ onDone }: { onDone: LocalJSXCommandOnDone }): React.ReactNode {
  React.useEffect(() => {
    const providers = loadProviders();
    if (providers.length === 0) {
      onDone('尚未配置任何 provider。运行 /providers add 添加。', {
        display: 'system',
      });
      return;
    }
    const table = formatProvidersTable(providers, DEFAULT_PROVIDERS);
    onDone(table, { display: 'system' });
    // onDone is stable across renders
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

// ──── /providers use ───────────────────────────────────────────────────────────

function UseProvider({ args, onDone }: { args: string; onDone: LocalJSXCommandOnDone }): React.ReactNode {
  const [error, setError] = useState<string | null>(null);

  React.useEffect(() => {
    const parts = args.trim().split(/\s+/).filter(Boolean);
    const providerId = parts[0];
    const modelId = parts[1];

    if (!providerId) {
      onDone('用法: /providers use <provider-id> [model-id]', {
        display: 'system',
      });
      return;
    }

    const providers = loadProviders();
    const provider = findProvider(providerId, providers);
    if (!provider) {
      onDone(`未找到 provider "${providerId}"。运行 /providers list 查看已配置的 provider。`, {
        display: 'system',
      });
      return;
    }

    const resolvedModel = modelId ?? provider.defaultModel;
    if (!resolvedModel) {
      onDone(`Provider "${providerId}" 未配置 defaultModel，请显式指定模型：/providers use ${providerId} <model-id>`, {
        display: 'system',
      });
      return;
    }

    const modelRef = buildModelRef(provider.id, resolvedModel);
    const { error: writeError } = updateSettingsForSource('userSettings', {
      model: modelRef,
    });
    if (writeError) {
      setError(`写入 settings.json 失败: ${writeError.message}`);
      return;
    }
    onDone(`已切换模型为 ${modelRef}。\n重启会话或在 /model 菜单中确认生效。`, { display: 'system' });
    // onDone is stable across renders
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) {
    return (
      <Text color="error" dimColor>
        {error}
      </Text>
    );
  }
  return null;
}

// ──── /providers remove ────────────────────────────────────────────────────────

function RemoveProvider({ args, onDone }: { args: string; onDone: LocalJSXCommandOnDone }): React.ReactNode {
  const [confirming, setConfirming] = useState<ProviderConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  const providers = loadProviders();

  function doRemove(provider: ProviderConfig): void {
    try {
      removeProvider(provider.id);
      onDone(`已删除 provider "${provider.id}"。`, { display: 'system' });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  // Direct arg path: /providers remove <id>
  const idFromArgs = args.trim().split(/\s+/)[0] ?? '';
  if (idFromArgs && !confirming) {
    const provider = findProvider(idFromArgs, providers);
    if (!provider) {
      onDone(`未找到 provider "${idFromArgs}"。运行 /providers list 查看。`, {
        display: 'system',
      });
      return null;
    }
    setConfirming(provider);
  }

  if (error) {
    return <Text color="error">{error}</Text>;
  }

  if (confirming) {
    const isBuiltin = DEFAULT_PROVIDERS.some(p => p.id === confirming.id);
    const warning = isBuiltin ? `\n注意："${confirming.id}" 是内置默认 provider，删除后会恢复为内置配置。` : '';
    return (
      <Dialog title={`删除 provider "${confirming.id}"?`} onCancel={() => onDone('已取消', { display: 'system' })}>
        <Box flexDirection="column" gap={1}>
          <Text>
            baseUrl: {confirming.baseUrl}
            {warning && <Text color="error">{warning}</Text>}
          </Text>
          <Select
            options={[
              { label: '删除', value: 'delete' },
              { label: '取消', value: 'cancel' },
            ]}
            onChange={value => {
              if (value === 'delete') doRemove(confirming);
              else onDone('已取消', { display: 'system' });
            }}
            onCancel={() => onDone('已取消', { display: 'system' })}
          />
        </Box>
      </Dialog>
    );
  }

  // Interactive pick path
  return (
    <Dialog title="选择要删除的 provider" onCancel={() => onDone('已取消', { display: 'system' })}>
      <Select
        options={providers.map(p => ({
          label: p.id,
          value: p.id,
          description: `${p.kind} · ${p.baseUrl}`,
        }))}
        onChange={value => {
          const provider = findProvider(value, providers);
          if (provider) setConfirming(provider);
        }}
        onCancel={() => onDone('已取消', { display: 'system' })}
      />
    </Dialog>
  );
}

// ──── /providers add ───────────────────────────────────────────────────────────

type AddStep =
  | { name: 'id' }
  | { name: 'kind' }
  | { name: 'baseUrl' }
  | { name: 'apiKey' }
  | { name: 'compatRule' }
  | { name: 'fetching-models' }
  | { name: 'fetch-failed' }
  | { name: 'manual-models' }
  | { name: 'select-default-model' }
  | { name: 'confirm' }
  | { name: 'saving' };

interface AddDraft {
  id: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  compatRule?: CompatRule;
  models: string[];
  defaultModel: string;
}

function AddProvider({ onDone }: { onDone: LocalJSXCommandOnDone }): React.ReactNode {
  const [step, setStep] = useState<AddStep>({ name: 'id' });
  const [draft, setDraft] = useState<AddDraft>({
    id: '',
    kind: 'openai-compat',
    baseUrl: DEFAULT_BASE_URL['openai-compat'],
    apiKey: '',
    models: [],
    defaultModel: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [cursorOffset, setCursorOffset] = useState(0);

  const providers = loadProviders();

  function goCancel(): void {
    onDone('已取消', { display: 'system' });
  }

  // ── Step handlers ──────────────────────────────────────────────────────────

  function handleIdSubmit(raw: string): void {
    const id = raw.trim().toLowerCase();
    const err = validateProviderId(id, providers);
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    setDraft(d => ({ ...d, id }));
    setCursorOffset(0);
    setStep({ name: 'kind' });
  }

  function handleKindSelect(kind: ProviderKind): void {
    setDraft(d => ({
      ...d,
      kind,
      baseUrl: DEFAULT_BASE_URL[kind],
    }));
    setCursorOffset(0);
    setStep({ name: 'baseUrl' });
  }

  function handleBaseUrlSubmit(raw: string): void {
    const baseUrl = raw.trim();
    const err = validateBaseUrl(baseUrl);
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    setDraft(d => ({ ...d, baseUrl }));
    setCursorOffset(0);
    setStep({ name: 'apiKey' });
  }

  function handleApiKeySubmit(raw: string): void {
    setError(null);
    setDraft(d => ({ ...d, apiKey: raw.trim() }));
    setCursorOffset(0);
    if (draft.kind === 'openai-compat') {
      setStep({ name: 'compatRule' });
    } else {
      void fetchAndProceed();
    }
  }

  function handleCompatRuleSelect(rule: CompatRule): void {
    setDraft(d => ({ ...d, compatRule: rule }));
    setCursorOffset(0);
    void fetchAndProceed();
  }

  async function fetchAndProceed(): Promise<void> {
    setStep({ name: 'fetching-models' });
    const providerDraft: ProviderConfig = {
      id: draft.id,
      kind: draft.kind,
      baseUrl: draft.baseUrl,
      ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
      ...(draft.compatRule ? { compatRule: draft.compatRule } : {}),
    };
    try {
      const models = await fetchProviderModels(providerDraft);
      setDraft(d => ({ ...d, models }));
      setFetchError(null);
      if (models.length > 0) {
        setStep({ name: 'select-default-model' });
      } else {
        setStep({ name: 'manual-models' });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setFetchError(msg);
      setStep({ name: 'fetch-failed' });
    }
  }

  function handleManualModelsSubmit(raw: string): void {
    const ids = raw
      .split(/[\s,，、]+/)
      .map(s => s.trim())
      .filter(Boolean);
    if (ids.length === 0) {
      setError('请至少输入一个模型 id');
      return;
    }
    setError(null);
    setDraft(d => ({ ...d, models: ids }));
    setCursorOffset(0);
    setStep({ name: 'select-default-model' });
  }

  function handleDefaultModelSelect(modelId: string): void {
    setDraft(d => ({ ...d, defaultModel: modelId }));
    setStep({ name: 'confirm' });
  }

  function handleConfirm(confirm: boolean): void {
    if (!confirm) {
      goCancel();
      return;
    }
    setStep({ name: 'saving' });
    const provider: ProviderConfig = {
      id: draft.id,
      kind: draft.kind,
      baseUrl: draft.baseUrl,
      ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
      ...(draft.compatRule ? { compatRule: draft.compatRule } : {}),
      ...(draft.models.length > 0 ? { models: draft.models.map(id => ({ id })) } : {}),
      ...(draft.defaultModel ? { defaultModel: draft.defaultModel } : {}),
      modelsFetchedAt: new Date().toISOString(),
    };
    try {
      addProvider(provider);
      const ref = draft.defaultModel ? buildModelRef(draft.id, draft.defaultModel) : draft.id;
      onDone(`已保存 provider "${draft.id}"。\n使用 /providers use ${ref} 切换模型。`, { display: 'system' });
    } catch (err) {
      onDone(`保存失败: ${err instanceof Error ? err.message : String(err)}`, { display: 'system' });
    }
  }

  // ── Render steps ───────────────────────────────────────────────────────────

  const isTextInputStep =
    step.name === 'id' || step.name === 'baseUrl' || step.name === 'apiKey' || step.name === 'manual-models';

  return (
    <Dialog title="添加 provider" onCancel={goCancel} isCancelActive={!isTextInputStep} hideInputGuide>
      <Box flexDirection="column" gap={1}>
        {step.name === 'id' && (
          <IdStep
            value={draft.id}
            onChange={v => setDraft(d => ({ ...d, id: v }))}
            onSubmit={handleIdSubmit}
            error={error}
            cursorOffset={cursorOffset}
            onChangeCursorOffset={setCursorOffset}
          />
        )}

        {step.name === 'kind' && (
          <Box flexDirection="column" gap={1}>
            <Text>选择协议类型：</Text>
            <Select
              options={PROVIDER_KIND_OPTIONS.map(o => ({
                label: o.label,
                value: o.value,
                description: o.description,
              }))}
              defaultValue={draft.kind}
              onChange={handleKindSelect}
              onCancel={goCancel}
            />
          </Box>
        )}

        {step.name === 'baseUrl' && (
          <BaseUrlStep
            value={draft.baseUrl}
            onChange={v => setDraft(d => ({ ...d, baseUrl: v }))}
            onSubmit={handleBaseUrlSubmit}
            error={error}
            cursorOffset={cursorOffset}
            onChangeCursorOffset={setCursorOffset}
          />
        )}

        {step.name === 'apiKey' && (
          <ApiKeyStep
            kind={draft.kind}
            value={draft.apiKey}
            onChange={v => setDraft(d => ({ ...d, apiKey: v }))}
            onSubmit={handleApiKeySubmit}
            error={error}
            cursorOffset={cursorOffset}
            onChangeCursorOffset={setCursorOffset}
          />
        )}

        {step.name === 'compatRule' && (
          <Box flexDirection="column" gap={1}>
            <Text>选择字段兼容规则（compatRule）：</Text>
            <Select
              options={COMPAT_RULE_OPTIONS.map(o => ({
                label: o.label,
                value: o.value,
                description: o.description,
              }))}
              onChange={handleCompatRuleSelect}
              onCancel={goCancel}
            />
          </Box>
        )}

        {step.name === 'fetching-models' && <LoadingState message="正在拉取模型列表…" />}

        {step.name === 'fetch-failed' && (
          <Box flexDirection="column" gap={1}>
            <Text color="error">拉取模型列表失败：{fetchError}</Text>
            <Text>你可以手动输入模型 id，或按 Esc 取消。</Text>
            <Select
              options={[
                { label: '手动输入模型 id', value: 'manual' },
                { label: '取消', value: 'cancel' },
              ]}
              onChange={value => {
                if (value === 'manual') {
                  setCursorOffset(0);
                  setStep({ name: 'manual-models' });
                } else {
                  goCancel();
                }
              }}
              onCancel={goCancel}
            />
          </Box>
        )}

        {step.name === 'manual-models' && (
          <ManualModelsStep
            value={draft.models.join(' ')}
            onChange={v => setDraft(d => ({ ...d, models: v.split(/\s+/).filter(Boolean) }))}
            onSubmit={handleManualModelsSubmit}
            error={error}
            cursorOffset={cursorOffset}
            onChangeCursorOffset={setCursorOffset}
          />
        )}

        {step.name === 'select-default-model' && (
          <Box flexDirection="column" gap={1}>
            <Text>选择默认模型（共 {draft.models.length} 个）：</Text>
            <Select
              options={draft.models.map(m => ({ label: m, value: m }))}
              onChange={handleDefaultModelSelect}
              onCancel={goCancel}
              visibleOptionCount={Math.min(draft.models.length, 8)}
            />
          </Box>
        )}

        {step.name === 'confirm' && (
          <Box flexDirection="column" gap={1}>
            <Text>确认添加以下 provider？</Text>
            <Box flexDirection="column" paddingLeft={2}>
              <Text>id: {draft.id}</Text>
              <Text>kind: {draft.kind}</Text>
              <Text>baseUrl: {draft.baseUrl}</Text>
              <Text>apiKey: {draft.apiKey ? '••••••••' : '(未设置)'}</Text>
              {draft.compatRule && <Text>compatRule: {draft.compatRule}</Text>}
              <Text>defaultModel: {draft.defaultModel}</Text>
              <Text>模型数: {draft.models.length}</Text>
            </Box>
            <Select
              options={[
                { label: '保存', value: 'yes' },
                { label: '取消', value: 'no' },
              ]}
              onChange={v => handleConfirm(v === 'yes')}
              onCancel={goCancel}
            />
          </Box>
        )}

        {step.name === 'saving' && <LoadingState message="正在保存…" />}
      </Box>
    </Dialog>
  );
}

// ──── Step sub-components ──────────────────────────────────────────────────────

function IdStep({
  value,
  onChange,
  onSubmit,
  error,
  cursorOffset,
  onChangeCursorOffset,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  error: string | null;
  cursorOffset: number;
  onChangeCursorOffset: (n: number) => void;
}): React.ReactNode {
  useKeybinding('confirm:no', () => onSubmit(''), { context: 'Settings' });
  return (
    <Box flexDirection="column" gap={1}>
      <Text>输入 provider id（小写字母/数字/中划线，用于模型引用前缀）：</Text>
      <Box flexDirection="row" gap={1}>
        <Text>{figures.pointer}</Text>
        <TextInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          focus
          showCursor
          placeholder="e.g. openrouter, my-groq"
          columns={60}
          cursorOffset={cursorOffset}
          onChangeCursorOffset={onChangeCursorOffset}
        />
      </Box>
      {error && <Text color="error">{error}</Text>}
      <Text dimColor>Esc 取消</Text>
    </Box>
  );
}

function BaseUrlStep({
  value,
  onChange,
  onSubmit,
  error,
  cursorOffset,
  onChangeCursorOffset,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  error: string | null;
  cursorOffset: number;
  onChangeCursorOffset: (n: number) => void;
}): React.ReactNode {
  useKeybinding('confirm:no', () => onSubmit(''), { context: 'Settings' });
  return (
    <Box flexDirection="column" gap={1}>
      <Text>输入 baseUrl（包含 /v1 等路径前缀）：</Text>
      <Box flexDirection="row" gap={1}>
        <Text>{figures.pointer}</Text>
        <TextInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          focus
          showCursor
          placeholder="https://api.example.com/v1"
          columns={60}
          cursorOffset={cursorOffset}
          onChangeCursorOffset={onChangeCursorOffset}
        />
      </Box>
      {error && <Text color="error">{error}</Text>}
      <Text dimColor>Esc 取消</Text>
    </Box>
  );
}

function ApiKeyStep({
  kind,
  value,
  onChange,
  onSubmit,
  error,
  cursorOffset,
  onChangeCursorOffset,
}: {
  kind: ProviderKind;
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  error: string | null;
  cursorOffset: number;
  onChangeCursorOffset: (n: number) => void;
}): React.ReactNode {
  useKeybinding('confirm:no', () => onSubmit(''), { context: 'Settings' });
  return (
    <Box flexDirection="column" gap={1}>
      {kind === 'anthropic' && <Text dimColor>Anthropic 支持 OAuth token，直接粘贴即可（存入 apiKey 字段）。</Text>}
      <Text>输入 API key（留空可稍后通过环境变量配置）：</Text>
      <Box flexDirection="row" gap={1}>
        <Text>{figures.pointer}</Text>
        <TextInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          focus
          showCursor
          mask="*"
          placeholder="sk-..."
          columns={60}
          cursorOffset={cursorOffset}
          onChangeCursorOffset={onChangeCursorOffset}
        />
      </Box>
      {error && <Text color="error">{error}</Text>}
      <Text dimColor>留空直接回车跳过 · Esc 取消</Text>
    </Box>
  );
}

function ManualModelsStep({
  value,
  onChange,
  onSubmit,
  error,
  cursorOffset,
  onChangeCursorOffset,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  error: string | null;
  cursorOffset: number;
  onChangeCursorOffset: (n: number) => void;
}): React.ReactNode {
  useKeybinding('confirm:no', () => onSubmit(''), { context: 'Settings' });
  return (
    <Box flexDirection="column" gap={1}>
      <Text>手动输入模型 id（空格或逗号分隔）：</Text>
      <Box flexDirection="row" gap={1}>
        <Text>{figures.pointer}</Text>
        <TextInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          focus
          showCursor
          placeholder="model-a model-b, model-c"
          columns={60}
          cursorOffset={cursorOffset}
          onChangeCursorOffset={onChangeCursorOffset}
        />
      </Box>
      {error && <Text color="error">{error}</Text>}
      <Text dimColor>Esc 取消</Text>
    </Box>
  );
}

// ──── Entry ────────────────────────────────────────────────────────────────────

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  const trimmed = args?.trim() ?? '';
  const [sub, ...rest] = trimmed.split(/\s+/);
  const restArgs = rest.join(' ');

  if (!trimmed || sub === 'list') {
    return <ListProviders onDone={onDone} />;
  }

  if (COMMON_HELP_ARGS.includes(trimmed)) {
    onDone(
      [
        '用法：',
        '  /providers              列出所有 provider',
        '  /providers list         列出所有 provider',
        '  /providers add          交互式添加 provider',
        '  /providers remove [id]  删除 provider（无 id 时交互选择）',
        '  /providers use <id> [model]  切换模型到 provider:model',
      ].join('\n'),
      { display: 'system' },
    );
    return null;
  }

  if (sub === 'add') {
    return <AddProvider onDone={onDone} />;
  }

  if (sub === 'remove') {
    return <RemoveProvider args={restArgs} onDone={onDone} />;
  }

  if (sub === 'use') {
    return <UseProvider args={restArgs} onDone={onDone} />;
  }

  onDone(`未知子命令 "${sub}"。支持: list / add / remove / use`, {
    display: 'system',
  });
  return null;
};
