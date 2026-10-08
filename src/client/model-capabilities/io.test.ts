/**
 * W1a 红灯用例：模型能力导入导出（契约 docs/specs/r3-io-and-move.md 第 1 节）。
 *
 * 覆盖契约 1.1–1.10：文件名与头注释、导出 schema（含密钥/请求头/默认键/_stash 的丢弃）、
 * parseModelConfig 的错误文案、previewModelImport 的 1.5 表格逐行判定、applyModelImport
 * 的合并规则，以及「导出 → 解析 → 预览 → 全选导入」的往返。
 *
 * 本文件只依赖 io.ts 的公开签名；io.ts 现在全是 not implemented 的桩，所以这些用例应该
 * 因为断言不通过或 not implemented 而失败，不能因为 import/语法错误而失败。
 */
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  applyModelImport,
  exportModelConfig,
  modelExportFilename,
  parseModelConfig,
  previewModelImport,
  type ImportContext,
  type ImportItem,
  type ModelImportPreview,
  type ParsedModelFile,
} from './io';
import { computeOps, draftFromNamespaces, previewText } from './ops';
import { DS_ROUTE_ID, NS_DS, NS_PI, type DraftState, type ProviderDraft } from './types';
import { deepClone, defaultCreds, draftModel, draftProvider, dsSlice, piSlice } from './test-fixtures';

/** 固定时间：本地时间 2026-09-30 08:00:00 → 文件名 wuyou-models-20260930-080000.yaml。 */
const FIXED_DATE = new Date(2026, 8, 30, 8, 0, 0);

const KIND = 'wuyou-model-capabilities';

/** 契约 1.9 的警告原文（previewModelImport 的 warning，也是对话框里那一段）。 */
const WARNING_TEXT =
  '文件不应包含密钥或请求头。这些字段会被丢弃，不会进入草稿。baseURL 和 apiKeyEnv 会随新提供方写入草稿，分享来的文件请先看过。';

const EMPTY_DRAFT: DraftState = { providers: {} };
const NO_DS: ImportContext = { hasDs: false };
const WITH_DS: ImportContext = { hasDs: true };

/* ---------------- 小工具 ---------------- */

function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

function asList(value: unknown): Array<Record<string, unknown>> {
  return value as Array<Record<string, unknown>>;
}

/** hasOwnProperty，用来区分「键被删掉」和「键存在但值是 undefined」。 */
function has(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

/** 递归收集导出文本里出现过的所有键名（用来断言敏感键一个都没写出去）。 */
function allKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, out);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out.push(key);
      allKeys(item, out);
    }
  }
  return out;
}

function parseExport(text: string): Record<string, unknown> {
  return asRecord(parse(text));
}

function previewOf(
  providers: Record<string, unknown>,
  draft: DraftState = EMPTY_DRAFT,
  ctx: ImportContext = NO_DS,
  deepseek?: Record<string, unknown>,
): ModelImportPreview {
  return previewModelImport(deepseek === undefined ? { providers } : { providers, deepseek }, draft, ctx);
}

function previewOne(file: ParsedModelFile, draft: DraftState = EMPTY_DRAFT, ctx: ImportContext = NO_DS): ImportItem {
  const { items } = previewModelImport(file, draft, ctx);
  expect(items, '应该只有一个预览项').toHaveLength(1);
  return items[0];
}

/** 只有 DeepSeek、没有自定义提供方的草稿。 */
function draftWithDs(over: Partial<ProviderDraft> = {}): DraftState {
  return {
    providers: {
      [DS_ROUTE_ID]: draftProvider({ id: DS_ROUTE_ID, ns: NS_DS, models: [], ...over }),
    },
  };
}

/* ---------------- 1.2 导出用的 base ---------------- */

/**
 * 契约 1.2 的 base：pi 提供方带请求头（Authorization / sk-SECRET）、extra 里的敏感键
 * （apiKey/authorization/token/password/secret/headers）和 6 个默认键；模型带 `_stash`
 * 和 `inputModalities`；容量写成 `128K`/`32K`。
 */
function exportBase(withDs = true): DraftState {
  const providers: Record<string, ProviderDraft> = {
    'pi-gateway': draftProvider({
      id: 'pi-gateway',
      api: 'openai-responses',
      displayName: 'PI 网关',
      baseURL: 'https://pi.example.com/v1',
      apiKeyEnv: 'PI_API_KEY',
      headers: [{ k: 'Authorization', v: 'Bearer sk-SECRET' }],
      models: [
        draftModel({
          id: 'pi-model-a',
          name: 'Model A',
          contextWindow: '128K',
          maxTokens: '32K',
          input: ['text'],
          inputModalities: ['text', 'image'],
          reasoningEfforts: { high: 'high', low: 'low' },
          _stash: { low: 'low' },
          extra: { apiKey: 'x', defaultInput: ['text'], keepMe: 'kept' },
        }),
        draftModel({
          id: 'pi-model-b',
          name: 'Model B',
          contextWindow: '   ',
          reasoningEfforts: false,
          extra: {},
        }),
      ],
      extra: {
        apiKey: 'x',
        authorization: 'Bearer sk-SECRET',
        ' token ': 't',
        password: 'p',
        secret: 's',
        headers: 'h',
        defaultInput: ['text'],
        reasoning: 'high',
        defaultContextWindow: 262144,
        defaultMaxTokens: 32768,
        keepVendor: 'v',
      },
    }),
  };
  if (withDs) {
    providers[DS_ROUTE_ID] = draftProvider({
      id: DS_ROUTE_ID,
      ns: NS_DS,
      thinking: 'enabled',
      reasoningEffort: 'high',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      headers: [{ k: 'Authorization', v: 'Bearer sk-SECRET' }],
      models: [
        draftModel({
          id: 'deepseek-flash',
          name: 'V41-Flash',
          contextWindow: '1M',
          maxTokens: '256K',
          input: ['text'],
          inputModalities: ['text', 'image'],
          reasoningEfforts: false,
          _stash: { low: 'low' },
          extra: { apiKey: 'x', defaultContextWindow: 1000000, keepDs: 'k' },
        }),
      ],
      extra: { maxTokens: 256000, keepDsVendor: 'v' },
    });
  }
  return { providers };
}

/* ================= 1.1 / 1.2 导出 ================= */

describe('exportModelConfig / modelExportFilename（1.1、1.2）', () => {
  it('文件名：wuyou-models-<本地时间>.yaml', () => {
    expect(modelExportFilename(FIXED_DATE)).toBe('wuyou-models-20260930-080000.yaml');
    expect(modelExportFilename()).toMatch(/^wuyou-models-\d{8}-\d{6}\.yaml$/);
  });

  it('头注释：4 行，时间行是 ISO 时间', () => {
    const lines = exportModelConfig(exportBase(), { date: FIXED_DATE }).split('\n');
    expect(lines[0]).toBe('# 无忧模型能力配置导出');
    expect(lines[1]).toMatch(/^# 导出时间: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(lines[1]).toBe(`# 导出时间: ${FIXED_DATE.toISOString()}`);
    expect(lines[2]).toBe('# 不含密钥，不含请求头。');
    expect(lines[3]).toBe('# baseURL 和 apiKeyEnv 属于接入信息，分享前请检查。');
  });

  it('根键依次为 kind/version/providers/deepseek，且不出现 deepseek-official', () => {
    const text = exportModelConfig(exportBase(), { date: FIXED_DATE });
    const root = parseExport(text);
    expect(Object.keys(root)).toEqual(['kind', 'version', 'providers', 'deepseek']);
    expect(root.kind).toBe(KIND);
    expect(root.version).toBe(1);
    expect(text).not.toContain('deepseek-official');
  });

  it('本机没有 DeepSeek 时根上没有 deepseek；没有自定义提供方时 providers 是 {}', () => {
    const withoutDs = parseExport(exportModelConfig(exportBase(false), { date: FIXED_DATE }));
    expect(Object.keys(withoutDs)).toEqual(['kind', 'version', 'providers']);
    expect(withoutDs.deepseek).toBeUndefined();

    const onlyDs: DraftState = { providers: { [DS_ROUTE_ID]: exportBase().providers[DS_ROUTE_ID] } };
    const root = parseExport(exportModelConfig(onlyDs, { date: FIXED_DATE }));
    expect(Object.keys(root)).toEqual(['kind', 'version', 'providers', 'deepseek']);
    expect(root.providers).toEqual({});
  });

  it('文本里没有密钥、请求头、_stash 和 6 个默认键，非敏感 extra 保留', () => {
    const text = exportModelConfig(exportBase(), { date: FIXED_DATE });
    for (const raw of ['sk-SECRET', 'Authorization', 'Bearer']) {
      expect(text, raw).not.toContain(raw);
    }
    expect(text).not.toMatch(/(^|\n)\s*headers\s*:/);

    const keys = allKeys(parseExport(text));
    for (const key of [
      'headers',
      'apiKey',
      'authorization',
      'token',
      'password',
      'secret',
      'secretSet',
      'credConfigured',
      'credWritable',
      '_stash',
      'defaultInput',
      'reasoning',
      'defaultContextWindow',
      'defaultMaxTokens',
    ]) {
      expect(keys, key).not.toContain(key);
    }
    // DS 的 maxTokens 默认键不导出（模型的容量键 maxTokens 应该还在，见 deepseek 节用例）
    expect(keys).toContain('maxTokens');
    for (const kept of ['keepVendor', 'keepMe', 'keepDs', 'keepDsVendor']) {
      expect(keys, kept).toContain(kept);
    }
  });

  it('提供方与模型的键顺序：已知字段在前，extra 居中/居后，models 最后', () => {
    const root = parseExport(exportModelConfig(exportBase(), { date: FIXED_DATE }));
    const providers = asRecord(root.providers);
    expect(Object.keys(providers)).toEqual(['pi-gateway']);
    const gw = asRecord(providers['pi-gateway']);
    expect(Object.keys(gw)).toEqual(['api', 'displayName', 'baseURL', 'apiKeyEnv', 'keepVendor', 'models']);
    expect(gw.api).toBe('openai-responses');
    expect(gw.displayName).toBe('PI 网关');
    expect(gw.baseURL).toBe('https://pi.example.com/v1');
    expect(gw.apiKeyEnv).toBe('PI_API_KEY');

    const models = asList(gw.models);
    expect(models).toHaveLength(2);
    expect(Object.keys(models[0])).toEqual([
      'id',
      'name',
      'contextWindow',
      'maxTokens',
      'input',
      'inputModalities',
      'reasoningEfforts',
      'keepMe',
    ]);
  });

  it('容量写成 number（128K → 128000），空白侧省略；inputModalities 原样保留', () => {
    const models = asList(asRecord(asRecord(parseExport(exportModelConfig(exportBase(), { date: FIXED_DATE })).providers)['pi-gateway']).models);
    const [a, b] = models;
    expect(a.contextWindow).toBe(128000);
    expect(typeof a.contextWindow).toBe('number');
    expect(a.maxTokens).toBe(32000);
    expect(typeof a.maxTokens).toBe('number');
    expect(a.inputModalities).toEqual(['text', 'image']);
    expect(a.input).toEqual(['text']);
    // reasoningEfforts 走 orderedEfforts（low 在 high 前）
    expect(asRecord(a.reasoningEfforts)).toEqual({ low: 'low', high: 'high' });
    expect(Object.keys(asRecord(a.reasoningEfforts))).toEqual(['low', 'high']);

    expect(b.reasoningEfforts).toBe(false);
    expect(b.contextWindow, '空白容量省略').toBeUndefined();
    expect(b.maxTokens, '缺失容量省略').toBeUndefined();
  });

  it('deepseek 节：不写 apiKeyEnv/input/reasoningEfforts，容量与 inputModalities 照写', () => {
    const root = parseExport(exportModelConfig(exportBase(), { date: FIXED_DATE }));
    const ds = asRecord(root.deepseek);
    expect(Object.keys(ds)).toEqual(['thinking', 'reasoningEffort', 'keepDsVendor', 'models']);
    expect(ds.thinking).toBe('enabled');
    expect(ds.reasoningEffort).toBe('high');
    expect(ds.apiKeyEnv).toBeUndefined();

    const models = asList(ds.models);
    expect(models).toHaveLength(1);
    expect(Object.keys(models[0])).toEqual(['id', 'name', 'contextWindow', 'maxTokens', 'inputModalities', 'keepDs']);
    expect(models[0].id).toBe('deepseek-flash');
    expect(models[0].contextWindow).toBe(1000000);
    expect(models[0].maxTokens).toBe(256000);
    expect(models[0].inputModalities).toEqual(['text', 'image']);
    expect(models[0].input).toBeUndefined();
    expect(models[0].reasoningEfforts).toBeUndefined();
  });
});

/* ================= 1.4 parseModelConfig ================= */

describe('parseModelConfig（1.4）', () => {
  const ERRORS: Array<[string, string, string]> = [
    ['根是数组', '[]\n', '文件内容不是 YAML 映射，无法识别为导出文件'],
    ['根是字符串', '"hello"\n', '文件内容不是 YAML 映射，无法识别为导出文件'],
    ['没有 kind', 'version: 1\nproviders: {}\n', '不是模型能力导出文件'],
    ['kind 不对', `kind: wuyou-subagents\nversion: 1\nproviders: {}\n`, '不是模型能力导出文件'],
    ['version 是字符串 "1"', `kind: ${KIND}\nversion: "1"\nproviders: {}\n`, '不支持的文件版本：1'],
    ['version 不是 1', `kind: ${KIND}\nversion: 2\nproviders: {}\n`, '不支持的文件版本：2'],
    ['providers 是数组', `kind: ${KIND}\nversion: 1\nproviders: []\n`, 'providers 必须是映射'],
    ['deepseek 是数组', `kind: ${KIND}\nversion: 1\nproviders: {}\ndeepseek: []\n`, 'deepseek 必须是映射'],
  ];

  it.each(ERRORS)('%s → 抛错', (_name, text, message) => {
    expect(() => parseModelConfig(text)).toThrowError(message);
  });

  it('根上的未知键忽略，providers 里的项按原样带出', () => {
    const parsed = parseModelConfig(`kind: ${KIND}\nversion: 1\nextra: 1\nproviders:\n  pi-a:\n    api: x\n`);
    expect(Object.keys(parsed.providers)).toEqual(['pi-a']);
    expect(asRecord(parsed.providers['pi-a']).api).toBe('x');
    expect(parsed.deepseek).toBeUndefined();
  });
});

/* ================= 1.5 previewModelImport ================= */

describe('previewModelImport：1.5 表格逐行（1.5、1.9）', () => {
  it('warning 是契约 1.9 的警告原文，空文件得到空 items', () => {
    const preview = previewOf({});
    expect(preview.warning).toBe(WARNING_TEXT);
    expect(preview.items).toEqual([]);
  });

  const INVALID: Array<[string, Record<string, unknown>, string]> = [
    ['ID 不匹配 ^[a-z0-9]+(?:-[a-z0-9]+)*$', { Bad_Id: { api: 'x', models: [] } }, "提供方 ID 'Bad_Id' 不合法"],
    ['ID 是 deepseek', { deepseek: { api: 'x', models: [] } }, "提供方 ID 'deepseek' 保留给 DeepSeek，不能作为自定义提供方"],
    [
      'ID 是 deepseek-official',
      { 'deepseek-official': { api: 'x', models: [] } },
      "提供方 ID 'deepseek-official' 保留给 DeepSeek，不能作为自定义提供方",
    ],
    ['值不是映射', { 'pi-str': 'nope' }, "提供方 'pi-str' 不是映射"],
    ['缺少 api', { 'pi-no-api': { models: [] } }, "提供方 'pi-no-api' 缺少 api"],
    ['api 是空串', { 'pi-blank-api': { api: '', models: [] } }, "提供方 'pi-blank-api' 缺少 api"],
    [
      '模型 ID 为空白',
      { 'pi-blank-model': { api: 'x', models: [{ id: '  ' }] } },
      "提供方 'pi-blank-model' 的模型 ID 不合法：模型 ID 不能为空",
    ],
    [
      '模型 ID 含空格',
      { 'pi-space': { api: 'x', models: [{ id: 'pi model' }] } },
      "提供方 'pi-space' 的模型 ID 不合法：模型 ID 'pi model' 不能包含空格",
    ],
    [
      '同一提供方内模型 ID 重复',
      { 'pi-dup': { api: 'x', models: [{ id: 'm1' }, { id: 'm1' }] } },
      "提供方 'pi-dup' 的模型 ID 不合法：模型 ID 'm1' 重复",
    ],
    [
      '容量键存在且 parseCap === null',
      { 'pi-cap': { api: 'x', models: [{ id: 'm1', contextWindow: 'abc' }] } },
      "提供方 'pi-cap' 的模型 'm1' 容量格式不正确",
    ],
    [
      'maxTokens 格式不正确',
      { 'pi-cap-mt': { api: 'x', models: [{ id: 'm1', maxTokens: '0' }] } },
      "提供方 'pi-cap-mt' 的模型 'm1' 容量格式不正确",
    ],
    [
      'reasoningEfforts 既不是 false 也不是普通对象',
      { 'pi-eff': { api: 'x', models: [{ id: 'm1', reasoningEfforts: 'high' }] } },
      "提供方 'pi-eff' 的模型 'm1' 的 reasoningEfforts 不合法",
    ],
    [
      'reasoningEfforts 是数组',
      { 'pi-eff-arr': { api: 'x', models: [{ id: 'm1', reasoningEfforts: [] }] } },
      "提供方 'pi-eff-arr' 的模型 'm1' 的 reasoningEfforts 不合法",
    ],
    [
      '只报第一个模型错误',
      { 'pi-first': { api: 'x', models: [{ id: 'm1', contextWindow: 'abc' }, { id: 'm2', maxTokens: 'zzz' }] } },
      "提供方 'pi-first' 的模型 'm1' 容量格式不正确",
    ],
  ];

  it.each(INVALID)('invalid：%s', (_name, providers, reason) => {
    const item = previewOne({ providers });
    expect(item.kind).toBe('invalid');
    expect(item.reason).toBe(reason);
    expect(item.checked).toBe(false);
    expect(item.checkable).toBe(false);
    expect(item.provider, '有错的提供方不进入载荷').toBeUndefined();
    expect(item.deepseek).toBeUndefined();
  });

  it('new：默认勾选，载荷丢掉请求头/敏感 extra，补 reasoningEfforts: false', () => {
    const item = previewOne({
      providers: {
        'pi-new': {
          api: 'openai-completions',
          displayName: 'New 网关',
          baseURL: 'https://new.example.com/v1',
          apiKeyEnv: 'NEW_API_KEY',
          headers: [{ k: 'Authorization', v: 'Bearer sk-SECRET' }],
          keepVendor: 'v',
          apiKey: 'x',
          ' token ': 't',
          models: [
            {
              id: 'pi-new-model',
              name: 'New Model',
              inputModalities: ['text', 'image'],
              keepMe: 'k',
              apiKey: 'x',
              _stash: { low: 'low' },
            },
          ],
        },
      },
    });

    expect(item.kind).toBe('new');
    expect(item.id).toBe('pi-new');
    expect(item.label).toBe('New 网关');
    expect(item.reason).toBe("将新增提供方 'pi-new'");
    expect(item.checked).toBe(true);
    expect(item.checkable).toBe(true);

    const provider = item.provider!;
    expect(provider.ns).toBe(NS_PI);
    expect(provider.id).toBe('pi-new');
    expect(provider.api).toBe('openai-completions');
    expect(provider.displayName).toBe('New 网关');
    expect(provider.baseURL).toBe('https://new.example.com/v1');
    expect(provider.apiKeyEnv).toBe('NEW_API_KEY');
    expect(provider.headers, '新提供方不带 headers').toBeUndefined();
    expect(provider.credConfigured).toBe(false);
    expect(provider.credWritable).toBe(true);
    expect(provider.extra).toEqual({ keepVendor: 'v' });

    expect(provider.models).toHaveLength(1);
    const model = provider.models[0];
    expect(model.id).toBe('pi-new-model');
    expect(model.name).toBe('New Model');
    expect(model.inputModalities).toEqual(['text', 'image']);
    expect(model.input, 'inputModalities 不迁移到 input').toBeUndefined();
    expect(model.reasoningEfforts, '缺少 reasoningEfforts 时补 false').toBe(false);
    expect(model.extra).toEqual({ keepMe: 'k' });
    expect(model._stash).toBeUndefined();

    expect(JSON.stringify(item)).not.toContain('sk-SECRET');
    expect(JSON.stringify(item)).not.toContain('Authorization');
  });

  it('conflict：草稿里已有同名 pi ID，默认不勾选', () => {
    const draft: DraftState = {
      providers: {
        'pi-existing': draftProvider({ id: 'pi-existing', displayName: '本地名', models: [draftModel({ id: 'old-model' })] }),
      },
    };
    const item = previewOne({ providers: { 'pi-existing': { api: 'anthropic-messages', models: [{ id: 'file-model' }] } } }, draft);
    expect(item.kind).toBe('conflict');
    expect(item.id).toBe('pi-existing');
    expect(item.label, '文件里没有 displayName 时用 ID').toBe('pi-existing');
    expect(item.reason).toBe("提供方 'pi-existing' 已存在");
    expect(item.checked).toBe(false);
    expect(item.checkable).toBe(true);
    expect(item.provider?.models.map((m) => m.id)).toEqual(['file-model']);
    expect(item.provider?.headers).toBeUndefined();
  });

  it('skip：文件有 deepseek 但本机没有（或草稿里没有 DS 路由）', () => {
    const file: ParsedModelFile = { providers: {}, deepseek: { thinking: 'enabled', models: [] } };

    const noHost = previewOne(file, EMPTY_DRAFT, NO_DS);
    expect(noHost.kind).toBe('skip');
    expect(noHost.id).toBe('deepseek');
    expect(noHost.label).toBe('DeepSeek 官方');
    expect(noHost.reason).toBe('本机没有 DeepSeek，已跳过');
    expect(noHost.checked).toBe(false);
    expect(noHost.checkable).toBe(false);
    expect(noHost.deepseek).toBeUndefined();

    // hasDs 为 true 但草稿里没有 DS_ROUTE_ID，同样跳过
    expect(previewOne(file, EMPTY_DRAFT, WITH_DS).kind).toBe('skip');
    expect(previewOne(file, EMPTY_DRAFT, WITH_DS).reason).toBe('本机没有 DeepSeek，已跳过');
  });

  const DS_INVALID: Array<[string, Record<string, unknown>, string]> = [
    ['模型 ID 为空白', { models: [{ id: '  ' }] }, 'DeepSeek 的模型 ID 不合法：模型 ID 不能为空'],
    ['模型 ID 含空格', { models: [{ id: 'deep seek' }] }, "DeepSeek 的模型 ID 不合法：模型 ID 'deep seek' 不能包含空格"],
    [
      '模型 ID 重复',
      { models: [{ id: 'deepseek-flash' }, { id: 'deepseek-flash' }] },
      "DeepSeek 的模型 ID 不合法：模型 ID 'deepseek-flash' 重复",
    ],
    [
      '容量格式不正确',
      { models: [{ id: 'deepseek-flash', contextWindow: 'abc' }] },
      "DeepSeek 的模型 'deepseek-flash' 容量格式不正确",
    ],
  ];

  it.each(DS_INVALID)('invalid（DeepSeek）：%s', (_name, deepseek, reason) => {
    const item = previewOne({ providers: {}, deepseek }, draftWithDs(), WITH_DS);
    expect(item.kind).toBe('invalid');
    expect(item.id).toBe('deepseek');
    expect(item.label).toBe('DeepSeek 官方');
    expect(item.reason).toBe(reason);
    expect(item.checked).toBe(false);
    expect(item.checkable).toBe(false);
    expect(item.deepseek, '有错的 DeepSeek 节不进入载荷').toBeUndefined();
  });

  it('conflict（DeepSeek）：载荷只留 id/name/容量/inputModalities/合法 extra', () => {
    const file: ParsedModelFile = {
      providers: {},
      deepseek: {
        thinking: 'enabled',
        reasoningEffort: 'high',
        apiKeyEnv: 'FILE_KEY',
        headers: [{ k: 'Authorization', v: 'Bearer sk-SECRET' }],
        maxTokens: 256000,
        keepDsVendor: 'v',
        models: [
          {
            id: 'deepseek-flash',
            name: 'Flash',
            contextWindow: '1M',
            maxTokens: '256K',
            inputModalities: ['text', 'image'],
            input: ['text'],
            reasoningEfforts: { low: 'low' },
            apiKeyEnv: 'X',
            headers: [{ k: 'Authorization', v: 'Bearer sk-SECRET' }],
            keepDs: 'k',
            apiKey: 'x',
          },
        ],
      },
    };
    const item = previewOne(file, draftWithDs({ thinking: 'disabled', models: [draftModel({ id: 'deepseek-chat' })] }), WITH_DS);

    expect(item.kind).toBe('conflict');
    expect(item.id).toBe('deepseek');
    expect(item.label).toBe('DeepSeek 官方');
    expect(item.reason).toBe('DeepSeek 已存在');
    expect(item.checked).toBe(false);
    expect(item.checkable).toBe(true);

    const payload = item.deepseek!;
    expect(payload.thinking).toBe('enabled');
    expect(payload.reasoningEffort).toBe('high');
    expect(payload.extra).toEqual({ keepDsVendor: 'v' });
    expect(payload.models).toHaveLength(1);
    expect(payload.models[0].id).toBe('deepseek-flash');
    expect(payload.models[0].name).toBe('Flash');
    expect(payload.models[0].contextWindow).toBe('1M');
    expect(payload.models[0].maxTokens).toBe('256K');
    expect(payload.models[0].inputModalities).toEqual(['text', 'image']);
    expect(payload.models[0].input).toBeUndefined();
    expect(payload.models[0].reasoningEfforts).toBeUndefined();
    expect(payload.models[0].extra).toEqual({ keepDs: 'k' });
    expect(JSON.stringify(item)).not.toContain('sk-SECRET');
    expect(JSON.stringify(item)).not.toContain('FILE_KEY');
  });

  it('按文件顺序逐项判定，DeepSeek 也有一项', () => {
    const items = previewOf(
      { 'pi-a': { api: 'x', models: [] }, 'pi-b': { api: 'y', models: [] } },
      EMPTY_DRAFT,
      NO_DS,
      { models: [] },
    ).items;
    expect(items.map((i) => i.id).slice(0, 2)).toEqual(['pi-a', 'pi-b']);
    expect(items.map((i) => i.id)).toContain('deepseek');
  });
});

/* ================= 1.6 applyModelImport ================= */

describe('applyModelImport（1.6）', () => {
  it('new：追加到 providers 末尾', () => {
    const draft: DraftState = {
      providers: {
        'pi-a': draftProvider({ id: 'pi-a', models: [draftModel({ id: 'm-a' })] }),
        [DS_ROUTE_ID]: draftProvider({ id: DS_ROUTE_ID, ns: NS_DS, models: [] }),
      },
    };
    const items = previewOf({ 'pi-new': { api: 'openai-completions', models: [{ id: 'm-new' }] } }).items;
    const next = applyModelImport(draft, items, new Set(['pi-new']));

    expect(Object.keys(next.providers)).toEqual(['pi-a', DS_ROUTE_ID, 'pi-new']);
    expect(next.providers['pi-new'].api).toBe('openai-completions');
    expect(next.providers['pi-new'].models.map((m) => m.id)).toEqual(['m-new']);
  });

  it('conflict：替换 models/api/displayName 与 extra，保留本地 baseURL/apiKeyEnv/headers', () => {
    const draft: DraftState = {
      providers: {
        'pi-gateway': draftProvider({
          id: 'pi-gateway',
          api: 'openai-responses',
          displayName: '本地名',
          baseURL: 'https://local.example.com/v1',
          apiKeyEnv: 'LOCAL_KEY',
          headers: [{ k: 'X-Local', v: '1' }],
          credConfigured: true,
          credWritable: false,
          models: [draftModel({ id: 'old-model' })],
          extra: { keepLocal: '1' },
        }),
      },
    };
    const file: ParsedModelFile = {
      providers: {
        'pi-gateway': {
          api: 'anthropic-messages',
          baseURL: 'https://file.example.com/v1',
          apiKeyEnv: 'FILE_KEY',
          models: [{ id: 'file-model', name: 'File Model' }],
          fromFile: 'f',
        },
      },
    };
    const items = previewModelImport(file, draft, NO_DS).items;
    expect(items[0].kind).toBe('conflict');
    const next = applyModelImport(draft, items, new Set(['pi-gateway']));

    const merged = next.providers['pi-gateway'];
    expect(merged.api).toBe('anthropic-messages');
    expect(merged.models.map((m) => m.id)).toEqual(['file-model']);
    expect(merged.models[0].name).toBe('File Model');
    expect(has(merged, 'displayName'), '文件里没有 displayName 就删掉该键').toBe(false);
    expect(merged.extra).toEqual({ fromFile: 'f' });
    expect(merged.baseURL).toBe('https://local.example.com/v1');
    expect(merged.apiKeyEnv).toBe('LOCAL_KEY');
    expect(merged.headers).toEqual([{ k: 'X-Local', v: '1' }]);
    expect(merged.id).toBe('pi-gateway');
    expect(merged.ns).toBe(NS_PI);
    expect(merged.credConfigured).toBe(true);
    expect(merged.credWritable).toBe(false);
  });

  it('conflict：文件里没有 extra 时 extra 变成空对象', () => {
    const draft: DraftState = {
      providers: { 'pi-gateway': draftProvider({ id: 'pi-gateway', models: [draftModel({ id: 'old' })], extra: { keepLocal: '1' } }) },
    };
    const items = previewOf({ 'pi-gateway': { api: 'openai-responses', models: [{ id: 'file-model' }] } }, draft).items;
    const next = applyModelImport(draft, items, new Set(['pi-gateway']));
    expect(next.providers['pi-gateway'].extra).toEqual({});
  });

  it('未勾选的项（含 invalid/skip 的 id）不生效', () => {
    const draft: DraftState = {
      providers: {
        'pi-gateway': draftProvider({ id: 'pi-gateway', models: [draftModel({ id: 'old' })] }),
        [DS_ROUTE_ID]: draftProvider({ id: DS_ROUTE_ID, ns: NS_DS, models: [draftModel({ id: 'deepseek-chat' })] }),
      },
    };
    const file: ParsedModelFile = {
      providers: {
        'pi-gateway': { api: 'anthropic-messages', models: [{ id: 'file-model' }] },
        'pi-new': { api: 'openai-completions', models: [{ id: 'm-new' }] },
        Bad_Id: { api: 'x', models: [] },
      },
      deepseek: { models: [{ id: 'deepseek-flash' }] },
    };
    const items = previewModelImport(file, draft, WITH_DS).items;
    const kindOf = new Map(items.map((item) => [item.id, item.kind]));
    expect(kindOf.get('pi-gateway')).toBe('conflict');
    expect(kindOf.get('pi-new')).toBe('new');
    expect(kindOf.get('Bad_Id')).toBe('invalid');
    expect(kindOf.get('deepseek')).toBe('conflict');
    // providers 里按文件顺序
    expect(items.map((i) => i.id).filter((id) => id !== 'deepseek')).toEqual(['pi-gateway', 'pi-new', 'Bad_Id']);

    // 什么都不选：草稿原样
    expect(applyModelImport(draft, items, new Set())).toEqual(draft);
    // 只勾 new：conflict 与 DS 都不动
    const onlyNew = applyModelImport(draft, items, new Set(['pi-new']));
    expect(onlyNew.providers['pi-gateway']).toEqual(draft.providers['pi-gateway']);
    expect(onlyNew.providers[DS_ROUTE_ID]).toEqual(draft.providers[DS_ROUTE_ID]);
    expect(Object.keys(onlyNew.providers)).toEqual(['pi-gateway', DS_ROUTE_ID, 'pi-new']);
    // invalid 的 id 即使被勾上也不生效
    expect(applyModelImport(draft, items, new Set(['Bad_Id']))).toEqual(draft);

    // skip 的 id 也不生效（本机没有 DeepSeek 时 DS 项是 skip，没有载荷）
    const skipped = previewModelImport(
      { providers: { 'pi-new': { api: 'openai-completions', models: [{ id: 'm-new' }] } }, deepseek: { models: [] } },
      draft,
      NO_DS,
    ).items;
    expect(skipped.map((item) => item.kind)).toEqual(['new', 'skip']);
    expect(applyModelImport(draft, skipped, new Set(['deepseek']))).toEqual(draft);
  });

  it('DeepSeek：models 整表替换，文件没有 thinking 时保留本地值，extra 按键合并', () => {
    const draft: DraftState = {
      providers: {
        [DS_ROUTE_ID]: draftProvider({
          id: DS_ROUTE_ID,
          ns: NS_DS,
          thinking: 'disabled',
          reasoningEffort: 'off',
          apiKeyEnv: 'DEEPSEEK_API_KEY',
          credConfigured: false,
          credWritable: true,
          models: [draftModel({ id: 'deepseek-chat' })],
          extra: { localOnly: 'l', shared: 'local' },
        }),
      },
    };
    const withoutThinking: ParsedModelFile = {
      providers: {},
      deepseek: { reasoningEffort: 'high', shared: 'file', fileOnly: 'f', models: [{ id: 'deepseek-flash', inputModalities: ['text'] }] },
    };
    const items = previewModelImport(withoutThinking, draft, WITH_DS).items;
    const next = applyModelImport(draft, items, new Set(['deepseek']));
    const merged = next.providers[DS_ROUTE_ID];

    expect(merged.models.map((m) => m.id)).toEqual(['deepseek-flash']);
    expect(merged.models[0].inputModalities).toEqual(['text']);
    expect(merged.thinking, '文件里没有 thinking 时保留本地值').toBe('disabled');
    expect(merged.reasoningEffort).toBe('high');
    expect(merged.extra).toEqual({ localOnly: 'l', shared: 'file', fileOnly: 'f' });
    expect(merged.apiKeyEnv).toBe('DEEPSEEK_API_KEY');
    expect(merged.id).toBe(DS_ROUTE_ID);
    expect(merged.ns).toBe(NS_DS);
    expect(merged.credConfigured).toBe(false);
    expect(merged.credWritable).toBe(true);

    // 文件里有 thinking 时替换
    const withThinking: ParsedModelFile = { providers: {}, deepseek: { thinking: 'enabled', models: [] } };
    const items2 = previewModelImport(withThinking, draft, WITH_DS).items;
    expect(applyModelImport(draft, items2, new Set(['deepseek'])).providers[DS_ROUTE_ID].thinking).toBe('enabled');
  });

  it('不修改入参（深比较前后对象）', () => {
    const draft: DraftState = {
      providers: {
        'pi-gateway': draftProvider({ id: 'pi-gateway', models: [draftModel({ id: 'old' })], extra: { keep: '1' } }),
        [DS_ROUTE_ID]: draftProvider({ id: DS_ROUTE_ID, ns: NS_DS, models: [draftModel({ id: 'deepseek-chat' })] }),
      },
    };
    const file: ParsedModelFile = {
      providers: {
        'pi-gateway': { api: 'anthropic-messages', models: [{ id: 'file-model' }] },
        'pi-new': { api: 'openai-completions', models: [{ id: 'm-new' }] },
      },
      deepseek: { thinking: 'enabled', models: [{ id: 'deepseek-flash' }] },
    };
    const items: ImportItem[] = previewModelImport(file, draft, WITH_DS).items;
    const draftBefore = deepClone(draft);
    const itemsBefore = deepClone(items);

    const next = applyModelImport(draft, items, new Set(['pi-gateway', 'pi-new', 'deepseek']));

    expect(draft).toEqual(draftBefore);
    expect(items).toEqual(itemsBefore);
    expect(next).not.toEqual(draft);
  });
});

/* ================= 往返与 1.10 安全 ================= */

describe('往返与安全（1.10）', () => {
  it('导出 → 解析 → 预览 → 全选导入：id/api/displayName 一致，且不产生 headers 的 op', () => {
    const base = exportBase();
    const file = parseModelConfig(exportModelConfig(base, { date: FIXED_DATE }));
    const preview = previewModelImport(file, base, WITH_DS);
    expect(new Set(preview.items.map((i) => i.id))).toEqual(new Set(['pi-gateway', 'deepseek']));
    for (const item of preview.items) {
      expect(item.kind).toBe('conflict');
      expect(item.checkable).toBe(true);
    }

    const selection = new Set(preview.items.map((i) => i.id));
    const next = applyModelImport(base, preview.items, selection);

    const ops = computeOps(base, next, {});
    const paths = [...ops.pi, ...ops.ds].map((op) => op.path.join('.'));
    expect(paths.filter((path) => path.includes('headers'))).toEqual([]);
    expect(previewText(ops, { pi: 7, ds: 11 })).not.toContain('sk-SECRET');

    const localPi = next.providers['pi-gateway'];
    expect(localPi.api).toBe(base.providers['pi-gateway'].api);
    expect(localPi.displayName).toBe(base.providers['pi-gateway'].displayName);
    expect(localPi.models.map((m) => m.id)).toEqual(base.providers['pi-gateway'].models.map((m) => m.id));
    expect(localPi.baseURL).toBe(base.providers['pi-gateway'].baseURL);
    expect(localPi.apiKeyEnv).toBe(base.providers['pi-gateway'].apiKeyEnv);
    expect(localPi.headers).toEqual(base.providers['pi-gateway'].headers);

    const localDs = next.providers[DS_ROUTE_ID];
    expect(localDs.models.map((m) => m.id)).toEqual(base.providers[DS_ROUTE_ID].models.map((m) => m.id));
    expect(localDs.thinking).toBe('enabled');
    expect(localDs.reasoningEffort).toBe('high');
  });

  it('带密钥的文件导入后，previewText 里也不出现密钥/请求头/_stash', () => {
    const base = exportBase();
    const file: ParsedModelFile = {
      providers: {
        'pi-secret': {
          api: 'openai-completions',
          headers: [{ k: 'Authorization', v: 'Bearer sk-SECRET' }],
          apiKey: 'x',
          models: [{ id: 'm1', _stash: { low: 'low' }, apiKey: 'x' }],
        },
      },
    };
    const preview = previewModelImport(file, base, NO_DS);
    const selection = new Set(preview.items.filter((item) => item.checked).map((item) => item.id));
    expect([...selection]).toEqual(['pi-secret']);

    const ops = computeOps(base, applyModelImport(base, preview.items, selection), {});
    const text = previewText(ops, { pi: 7, ds: 11 });
    expect(text).not.toContain('sk-SECRET');
    expect(text).not.toContain('Authorization');
    expect(text).not.toContain('_stash');
    expect(text).not.toMatch(/(^|\n)\s*headers\s*:/);
  });
});

/* ================= R3F 回归：原型污染与嵌套 extra 被误删 ================= */

/**
 * F1（medium，原型污染）：
 *   提供方 ID 允许 `constructor` 这种命中 Object.prototype 属性的字符串（PROVIDER_ID 能过）。
 *   validateProvider 用 `Boolean(draft.providers[id])` 判存在性，草稿里没有这个提供方却命中了
 *   继承来的 Object.prototype.constructor，于是被判成 conflict（io.ts:308）；确认覆盖后
 *   applyModelImport 执行 `local = next.providers.constructor`，拿到的是全局 Object，接着把
 *   api / models / extra 写到它身上（io.ts:365-371），也就是全局污染。
 *
 * F2（medium，嵌套字段被误删）：
 *   cleanExtra 递归处理嵌套对象时复用了顶层的已知键黑名单（MODEL_KNOWN_KEYS / PI_KNOWN_KEYS /
 *   6 个默认键），把嵌套里的 input / models / id / api / reasoning 一并删掉（io.ts:68-79、97-106、
 *   233-240）。契约规定的默认键只针对提供方或 DS 顶层，嵌套里的敏感键才是必须删的。
 *
 * 本块只追加用例，不改 io.ts，也不改其它测试文件。
 */

// 本块要用 afterEach；单独 import 一行，让对 io.test.ts 的改动保持纯追加。
import { afterEach } from 'vitest';

/** applyModelImport 在 id 命中 Object.prototype 属性名时可能写到全局 Object / Object.prototype 上的键。 */
const POLLUTION_KEYS = [
  'api',
  'displayName',
  'baseURL',
  'apiKeyEnv',
  'models',
  'extra',
  'id',
  'ns',
  'credConfigured',
  'credWritable',
  'thinking',
  'reasoningEffort',
];

/** 万一本用例把全局污染了，删掉被加上的属性，避免影响同文件里其它用例。 */
function cleanGlobals(): void {
  for (const key of POLLUTION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(Object, key)) Reflect.deleteProperty(Object, key);
    if (Object.prototype.hasOwnProperty.call(Object.prototype, key)) Reflect.deleteProperty(Object.prototype, key);
  }
}

/** 用给定 ID 造一个最小文件（api 合法，所以只有 ID 本身决定预览判定）。 */
function fileWithProviderIds(ids: string[]): ParsedModelFile {
  const providers: Record<string, unknown> = {};
  for (const id of ids) {
    providers[id] = { api: 'openai-responses', displayName: 'Evil', models: [{ id: 'evil-model' }] };
  }
  return { providers };
}

describe('R3F 回归：原型污染与嵌套 extra（F1、F2）', () => {
  afterEach(() => {
    cleanGlobals();
  });

  /* ---------------- F1：原型污染 ---------------- */

  it('F1：草稿里没有 constructor 时，previewModelImport 不能判成 conflict', () => {
    const item = previewOne(fileWithProviderIds(['constructor']), EMPTY_DRAFT, NO_DS);
    expect(
      item.kind,
      "draft.providers['constructor'] 命中的是 Object.prototype.constructor，不是草稿里的提供方",
    ).not.toBe('conflict');
  });

  it('F1：勾选 constructor 后 applyModelImport 不往全局 Object / Object.prototype 上写属性', () => {
    const preview = previewModelImport(fileWithProviderIds(['constructor']), EMPTY_DRAFT, NO_DS);
    applyModelImport(EMPTY_DRAFT, preview.items, new Set(['constructor']));

    expect(Object.prototype.hasOwnProperty.call(Object, 'api'), 'applyModelImport 把 api 写到了全局 Object 上').toBe(false);
    expect((Object as unknown as Record<string, unknown>).api).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object, 'models'), 'applyModelImport 把 models 写到了全局 Object 上').toBe(
      false,
    );
    expect((Object as unknown as Record<string, unknown>).models).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object, 'extra'), 'applyModelImport 把 extra 写到了全局 Object 上').toBe(false);
    expect((Object as unknown as Record<string, unknown>).extra).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'api')).toBe(false);
    expect((Object.prototype as unknown as Record<string, unknown>).api).toBeUndefined();
  });

  it('F1：prototype / toString / hasOwnProperty 同样不判 conflict，apply 后全局对象不变', () => {
    const ids = ['prototype', 'toString', 'hasOwnProperty'];
    const objectKeys = Object.getOwnPropertyNames(Object);
    const prototypeKeys = Object.getOwnPropertyNames(Object.prototype);

    const preview = previewModelImport(fileWithProviderIds(ids), EMPTY_DRAFT, NO_DS);
    expect(preview.items.map((item) => item.id).sort()).toEqual([...ids].sort());
    for (const item of preview.items) {
      expect(item.kind, `提供方 ID '${item.id}' 被判成了 conflict`).not.toBe('conflict');
    }

    applyModelImport(EMPTY_DRAFT, preview.items, new Set(ids));
    expect(Object.getOwnPropertyNames(Object)).toEqual(objectKeys);
    expect(Object.getOwnPropertyNames(Object.prototype)).toEqual(prototypeKeys);
  });

  /* ---------------- F2：嵌套 extra 被误删 ---------------- */

  /** 嵌套 extra 的键名正好都撞上顶层的已知键/默认键：cost 里有 input，compat 里有 models/id/api。 */
  function nestedExtraBase(): DraftState {
    return {
      providers: {
        'pi-vendor': draftProvider({
          id: 'pi-vendor',
          api: 'openai-responses',
          models: [draftModel({ id: 'vendor-model', extra: { cost: { input: 1, output: 2 }, reasoning: 'high' } })],
          extra: { compat: { models: 1, id: 'x', api: 'y' } },
        }),
      },
    };
  }

  function exportedProvider(): Record<string, unknown> {
    const root = parseExport(exportModelConfig(nestedExtraBase(), { date: FIXED_DATE }));
    return asRecord(asRecord(root.providers)['pi-vendor']);
  }

  it('F2：导出时提供方 extra 的嵌套对象 compat 完整保留', () => {
    expect(asRecord(exportedProvider().compat)).toEqual({ models: 1, id: 'x', api: 'y' });
  });

  it('F2：导出时模型 extra 的嵌套对象 cost 完整保留', () => {
    const model = asList(exportedProvider().models)[0];
    expect(asRecord(model.cost)).toEqual({ input: 1, output: 2 });
  });

  it('F2：导出时模型 extra 顶层的 reasoning 保留（6 个默认键只针对提供方 / DS 顶层）', () => {
    const model = asList(exportedProvider().models)[0];
    expect(model.reasoning).toBe('high');
  });

  it('F2 回归：嵌套里的敏感键仍然被删（cost.token 删、cost.input 留）', () => {
    const base: DraftState = {
      providers: {
        'pi-vendor': draftProvider({
          id: 'pi-vendor',
          api: 'openai-responses',
          models: [draftModel({ id: 'vendor-model', extra: { cost: { token: 'x', input: 1 } } })],
        }),
      },
    };
    const root = parseExport(exportModelConfig(base, { date: FIXED_DATE }));
    const model = asList(asRecord(asRecord(root.providers)['pi-vendor']).models)[0];
    expect(asRecord(model.cost)).toEqual({ input: 1 });
  });

  it('F2：导入时 previewModelImport 载荷里的嵌套 compat / cost / reasoning 保留', () => {
    const file: ParsedModelFile = {
      providers: {
        'pi-vendor': {
          api: 'openai-responses',
          compat: { models: 1, id: 'x', api: 'y' },
          models: [{ id: 'vendor-model', cost: { input: 3 }, reasoning: 'high' }],
        },
      },
    };
    const item = previewOne(file, EMPTY_DRAFT, NO_DS);
    expect(item.kind).toBe('new');
    expect(item.provider).toBeDefined();
    const provider = item.provider as ProviderDraft;
    expect(asRecord(provider.extra.compat)).toEqual({ models: 1, id: 'x', api: 'y' });
    expect(asRecord(provider.models[0].extra.cost)).toEqual({ input: 3 });
    expect(provider.models[0].extra.reasoning).toBe('high');
  });

  it('F2 往返：export → parse → preview → apply 后 cost / compat / reasoning 与原值一致', () => {
    const file = parseModelConfig(exportModelConfig(nestedExtraBase(), { date: FIXED_DATE }));
    expect(previewOne(file, EMPTY_DRAFT, NO_DS).kind).toBe('new');

    const preview = previewModelImport(file, EMPTY_DRAFT, NO_DS);
    const next = applyModelImport(EMPTY_DRAFT, preview.items, new Set(['pi-vendor']));
    const provider = next.providers['pi-vendor'];
    expect(asRecord(provider.extra.compat)).toEqual({ models: 1, id: 'x', api: 'y' });
    expect(asRecord(provider.models[0].extra.cost)).toEqual({ input: 1, output: 2 });
    expect(provider.models[0].extra.reasoning).toBe('high');
  });
});

/* ---------------- R3F-N1：Object.prototype 上的名字不能作为提供方 ID ---------------- */

describe('R3F-N1 提供方 ID 与 Object.prototype 同名时判 invalid', () => {
  it.each(['constructor', 'prototype'])('Given 文件里的提供方 ID 是 %s When previewModelImport Then 判 invalid，理由是保留名', (id) => {
    const item = previewOne(fileWithProviderIds([id]), EMPTY_DRAFT, NO_DS);
    expect(item.kind).toBe('invalid');
    expect(item.checkable).toBe(false);
    expect(item.reason).toBe(`提供方 ID '${id}' 是保留名，不能作为自定义提供方`);
  });

  it('Given 全选导入 constructor When apply 后 computeOps Then 不抛错，也不产出 constructor 的 op', () => {
    const preview = previewModelImport(fileWithProviderIds(['constructor']), EMPTY_DRAFT, NO_DS);
    const applied = applyModelImport(EMPTY_DRAFT, preview.items, new Set(['constructor']));
    expect(Object.prototype.hasOwnProperty.call(applied.providers, 'constructor')).toBe(false);
    expect(() => computeOps(EMPTY_DRAFT, applied, {})).not.toThrow();
    const ops = computeOps(EMPTY_DRAFT, applied, {});
    expect(JSON.stringify(ops.pi)).not.toContain('constructor');
  });
});

/* ==========================================================================
 * R4b 流空闲超时（docs/specs/r4b-stream-idle-timeout.md 第 5 节）：I1–I6。
 *
 * 只追加用例，不动 io.ts。timeoutText 与草稿 / 载荷的 streamIdleTimeoutMs
 * 现在还不是 ProviderDraft / ImportItem 的字段，用下面的小工具绕过类型，
 * 保证这些用例失败在断言上。
 * ========================================================================== */

const T_KEY = 'streamIdleTimeoutMs';
/** 契约 5 节的逐字 reason。 */
const T_PI_INVALID = "提供方 'pi-bad' 的 streamIdleTimeoutMs 不合法：应为 1000–2147483647 的毫秒数";
const T_DS_INVALID = 'DeepSeek 的 streamIdleTimeoutMs 不合法：应为 1000–2147483647 的毫秒数';

function timeoutOf(p: ProviderDraft | undefined): unknown {
  return p ? (p as unknown as Record<string, unknown>)[T_KEY] : undefined;
}

/** pi 草稿：在标准路由上补 R4b 的字段（还没进 ProviderDraft 的声明）。 */
function piDraft(over: Record<string, unknown> = {}): ProviderDraft {
  const base = draftProvider({ id: 'pi-gateway', api: 'openai-responses', apiKeyEnv: 'PI_API_KEY', models: [] });
  return { ...base, ...over } as ProviderDraft;
}

/** DS 草稿：thinking/reasoningEffort 齐备，补 R4b 的字段。 */
function dsDraft(over: Record<string, unknown> = {}): ProviderDraft {
  const base = draftProvider({ id: DS_ROUTE_ID, ns: NS_DS, thinking: 'enabled', reasoningEffort: 'high', models: [] });
  return { ...base, ...over } as ProviderDraft;
}

describe('R4b I1 导出只写显式值', () => {
  it('I1 pi 显式 1800000 → 在 apiKeyEnv 之后、extra 之前；未设置不写；extra 残留 300000 不导出', () => {
    const withValue = piDraft({ [T_KEY]: 1800000, extra: { keepVendor: 'v' } });
    const text = exportModelConfig({ providers: { 'pi-gateway': withValue } }, { date: FIXED_DATE });
    expect(text).toContain('streamIdleTimeoutMs: 1800000');
    const gw = asRecord(asRecord(parseExport(text).providers)['pi-gateway']);
    const keys = Object.keys(gw);
    expect(gw[T_KEY]).toBe(1800000);
    expect(keys.indexOf(T_KEY)).toBeGreaterThan(keys.indexOf('apiKeyEnv'));
    expect(keys.indexOf(T_KEY)).toBeLessThan(keys.indexOf('keepVendor'));
    expect(keys.indexOf(T_KEY)).toBeLessThan(keys.indexOf('models'));

    // 未设置 → 一个字节都不写
    const none = exportModelConfig({ providers: { 'pi-gateway': piDraft() } }, { date: FIXED_DATE });
    expect(none).not.toContain(T_KEY);

    // value 层的 300000 曾经泄露进 extra：不再导出（known 集合已含这个键）
    const leaked = exportModelConfig({ providers: { 'pi-gateway': piDraft({ extra: { [T_KEY]: 300000 } }) } }, { date: FIXED_DATE });
    expect(leaked).not.toContain(T_KEY);
  });

  it('I1 DS 同理：显式值在 reasoningEffort 之后，未设置不写', () => {
    const text = exportModelConfig({ providers: { [DS_ROUTE_ID]: dsDraft({ [T_KEY]: 1800000 }) } }, { date: FIXED_DATE });
    const ds = asRecord(parseExport(text).deepseek);
    expect(ds[T_KEY]).toBe(1800000);
    const keys = Object.keys(ds);
    expect(keys.indexOf(T_KEY)).toBeGreaterThan(keys.indexOf('reasoningEffort'));
    expect(keys.indexOf(T_KEY)).toBeLessThan(keys.indexOf('models'));

    const none = exportModelConfig({ providers: { [DS_ROUTE_ID]: dsDraft() } }, { date: FIXED_DATE });
    expect(none).not.toContain(T_KEY);
  });
});

describe('R4b I2 导入 new：没有键补 1800000，有合法值用文件值', () => {
  it('I2 无键 → 1800000；600000 → 600000；extra 里都不留这个键', () => {
    const missing = previewOne({ providers: { 'pi-new': { api: 'openai-completions', models: [] } } });
    expect(missing.kind).toBe('new');
    expect(timeoutOf(missing.provider)).toBe(1800000);
    expect(missing.provider!.extra).not.toHaveProperty(T_KEY);

    const explicit = previewOne({
      providers: { 'pi-new': { api: 'openai-completions', streamIdleTimeoutMs: 600000, models: [] } },
    });
    expect(explicit.kind).toBe('new');
    expect(timeoutOf(explicit.provider)).toBe(600000);
    expect(explicit.provider!.extra).not.toHaveProperty(T_KEY);
  });
});

describe('R4b I3 导入 invalid：整项 invalid，reason 逐字', () => {
  it.each([[0], ['1800000'], [2147483648], [999]])('I3 pi 文件 streamIdleTimeoutMs=%s → invalid', (bad) => {
    const item = previewOne({ providers: { 'pi-bad': { api: 'openai-completions', streamIdleTimeoutMs: bad, models: [] } } });
    expect(item.kind).toBe('invalid');
    expect(item.reason).toBe(T_PI_INVALID);
    expect(item.checked).toBe(false);
    expect(item.checkable).toBe(false);
    expect(item.provider, '有错的提供方不进入载荷').toBeUndefined();
  });

  it.each([[0], ['1800000'], [2147483648], [999]])('I3 DS 文件 streamIdleTimeoutMs=%s → invalid', (bad) => {
    const item = previewOne({ providers: {}, deepseek: { streamIdleTimeoutMs: bad, models: [] } }, draftWithDs(), WITH_DS);
    expect(item.kind).toBe('invalid');
    expect(item.reason).toBe(T_DS_INVALID);
    expect(item.checkable).toBe(false);
    expect(item.deepseek, '有错的 DeepSeek 节不进入载荷').toBeUndefined();
  });
});

describe('R4b I4 conflict 合并：载荷有值就覆盖并删掉输入原文，没值就保留本地', () => {
  const localDraft = (): DraftState => ({
    providers: {
      'pi-existing': piDraft({
        models: [draftModel({ id: 'old-model' })],
        [T_KEY]: 1800000,
        timeoutText: '30',
      }),
    },
  });

  it('I4 文件 600000 → 本地改为 600000、timeoutText 删除、reason 带后缀', () => {
    const draft = localDraft();
    const item = previewOne(
      { providers: { 'pi-existing': { api: 'openai-completions', streamIdleTimeoutMs: 600000, models: [{ id: 'file-model' }] } } },
      draft,
    );
    expect(item.kind).toBe('conflict');
    expect(item.reason).toBe("提供方 'pi-existing' 已存在；流空闲超时将改为 10 分钟");

    const merged = applyModelImport(draft, [item], new Set(['pi-existing'])).providers['pi-existing'];
    expect(timeoutOf(merged)).toBe(600000);
    expect(has(merged, 'timeoutText')).toBe(false);
  });

  it('I4 文件没有该键 → 本地保留，reason 与 R3 原文逐字相同', () => {
    const draft = localDraft();
    const item = previewOne(
      { providers: { 'pi-existing': { api: 'openai-completions', models: [{ id: 'file-model' }] } } },
      draft,
    );
    expect(item.kind).toBe('conflict');
    expect(item.reason).toBe("提供方 'pi-existing' 已存在");

    const merged = applyModelImport(draft, [item], new Set(['pi-existing'])).providers['pi-existing'];
    expect(timeoutOf(merged)).toBe(1800000);
  });

  it('I4 文件值与本地显式值相同 → reason 仍与 R3 原文逐字相同', () => {
    const item = previewOne(
      { providers: { 'pi-existing': { api: 'openai-completions', streamIdleTimeoutMs: 1800000, models: [{ id: 'file-model' }] } } },
      localDraft(),
    );
    expect(item.reason).toBe("提供方 'pi-existing' 已存在");
  });
});

describe('R4b I5 DS conflict 合并：文件 1800000 → 草稿值 1800000，产出一条 ds set', () => {
  it('I5 DS 合并后 computeOps 产出 ds set [streamIdleTimeoutMs]', () => {
    const draft: DraftState = {
      providers: { [DS_ROUTE_ID]: dsDraft({ models: [draftModel({ id: 'deepseek-chat' })] }) },
    };
    const file: ParsedModelFile = { providers: {}, deepseek: { streamIdleTimeoutMs: 1800000, models: [] } };
    const item = previewOne(file, draft, WITH_DS);
    expect(item.kind).toBe('conflict');
    // 本地未设置也算「不同」，要有后缀
    expect(item.reason).toBe('DeepSeek 已存在；流空闲超时将改为 30 分钟');

    const next = applyModelImport(draft, [item], new Set(['deepseek']));
    expect(timeoutOf(next.providers[DS_ROUTE_ID])).toBe(1800000);

    const ops = computeOps(draft, next, {});
    expect(ops.ds.filter((op) => op.path.join('.') === T_KEY)).toEqual([
      { op: 'set', path: [T_KEY], value: 1800000 },
    ]);
  });
});

describe('R4b I6 往返：新 fixture 导出 → 解析 → 预览 → 全选 apply 后没有 timeout op', () => {
  it('I6 base 的显式值在草稿字段上，往返之后两侧都不产 timeout op', () => {
    const base = draftFromNamespaces({ pi: piSlice(7), ds: dsSlice(11), creds: defaultCreds() });
    // 前提：显式值在草稿字段上，不在 extra 里
    expect(timeoutOf(base.providers['gpt-gateway'])).toBe(1800000);
    expect(base.providers['gpt-gateway'].extra).not.toHaveProperty(T_KEY);
    expect(timeoutOf(base.providers[DS_ROUTE_ID])).toBeUndefined();

    const file = parseModelConfig(exportModelConfig(base, { date: FIXED_DATE }));
    const preview = previewModelImport(file, base, WITH_DS);
    const next = applyModelImport(base, preview.items, new Set(preview.items.map((item) => item.id)));

    expect(timeoutOf(next.providers['gpt-gateway'])).toBe(1800000);
    expect(timeoutOf(next.providers[DS_ROUTE_ID])).toBeUndefined();

    const ops = computeOps(base, next, {});
    expect(ops.pi.filter((op) => op.path.includes(T_KEY))).toEqual([]);
    expect(ops.ds.filter((op) => op.path.includes(T_KEY))).toEqual([]);
  });
});

describe('R4b I7 非整数毫秒：导入时按 Math.round 取整', () => {
  it('I7 文件 1500.5 → new 载荷 1501；conflict 合并覆盖本地后也是 1501', () => {
    const fresh = previewOne({
      providers: { 'pi-new': { api: 'openai-completions', streamIdleTimeoutMs: 1500.5, models: [] } },
    });
    expect(fresh.kind).toBe('new');
    expect(timeoutOf(fresh.provider)).toBe(1501);

    const draft: DraftState = {
      providers: {
        'pi-existing': piDraft({ models: [draftModel({ id: 'old-model' })], [T_KEY]: 1800000, timeoutText: '30' }),
      },
    };
    const item = previewOne(
      {
        providers: {
          'pi-existing': { api: 'openai-completions', streamIdleTimeoutMs: 1500.5, models: [{ id: 'file-model' }] },
        },
      },
      draft,
    );
    expect(item.kind).toBe('conflict');

    const merged = applyModelImport(draft, [item], new Set(['pi-existing'])).providers['pi-existing'];
    expect(timeoutOf(merged)).toBe(1501);
  });
});

