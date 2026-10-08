/**
 * SSR render tests for the 模型能力 settings.section (react-dom/server, node).
 *
 * The panel is controlled: it renders one fixed McSnapshot from a fake store and
 * only calls store methods, so renderToString pins the copy and the structure
 * without jsdom. Fixtures are inline (nothing reads ~/.dsh) and the snapshot
 * never carries a plaintext secret, by contract (spec B1).
 *
 * R2 (docs/specs/model-capabilities.r2.md): the provider-level defaults are gone,
 * so the copy asserted here is the R2 wording — 未设置 instead of 继承, the new
 * 旧字段 hint, the copy-lock note in the bulk layer and the new table track.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { ModelCapabilitiesPanel } from './ModelCapabilitiesPanel';
import { DS_ROUTE_ID, LIST_DESC, NS_DS, NS_PI } from './types';
import type {
  BulkDraft,
  McSnapshot,
  McUi,
  ModelCapabilitiesStore,
  ModelDraft,
  OpsResult,
  ProviderDraft,
  WizardDraft,
} from './types';

/* ================= fixture ================= */

function model(id: string, over: Partial<ModelDraft> = {}): ModelDraft {
  return { id, extra: {}, ...over };
}

function provider(id: string, over: Partial<ProviderDraft> = {}): ProviderDraft {
  return {
    id,
    ns: NS_PI,
    api: 'openai-completions',
    displayName: id,
    baseURL: `https://${id}.example.com/v1`,
    apiKeyEnv: `${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`,
    credConfigured: true,
    credWritable: true,
    models: [],
    extra: {},
    ...over,
  };
}

const EMPTY_OPS: OpsResult = { pi: [], ds: [], cred: [], dirty: 0, dirtySet: new Set() };

const BASE_UI: McUi = {
  view: 'list',
  route: null,
  edit: null,
  bulk: null,
  wizard: null,
  dialog: null,
  menuIdx: null,
  sel: {},
  showAdv: {},
  inputHint: null,
  undo: null,
  saving: false,
  saved: false,
  conflict: 'hidden',
  readonly: false,
  loading: false,
  status: '',
  previewReturn: null,
  importPreview: null,
  dsPrev: '',
};

/**
 * Two custom providers plus the official one. gpt-gateway carries one model with
 * explicit capacity/input/efforts and one that only has the legacy
 * inputModalities; cc-gateway has no credentials; the official provider has
 * thinking switched off.
 */
function draftProviders(): Record<string, ProviderDraft> {
  return {
    'gpt-gateway': provider('gpt-gateway', {
      displayName: 'GPT Gateway',
      models: [
        model('gpt-6-luna', {
          name: 'Luna',
          contextWindow: '272000',
          maxTokens: '32768',
          input: ['text', 'image'],
          reasoningEfforts: { low: 'low', high: 'high' },
        }),
        model('gpt-6-legacy', { inputModalities: ['text'] }),
      ],
    }),
    'cc-gateway': provider('cc-gateway', {
      displayName: 'CC Gateway',
      credConfigured: false,
      models: [model('cc-opus-4', { reasoningEfforts: false })],
    }),
    // The official provider's UI route id is a React key / sort key only: it must
    // never show up in an op path (spec B1), but it is the draft key here.
    [DS_ROUTE_ID]: provider(DS_ROUTE_ID, {
      ns: NS_DS,
      displayName: 'DeepSeek 官方',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      thinking: 'disabled',
      reasoningEffort: 'off',
      credConfigured: false,
      models: [model('deepseek-chat'), model('deepseek-reasoner')],
    }),
  };
}

function makeSnap(over: Partial<Omit<McSnapshot, 'ui'>> & { ui?: Partial<McUi> } = {}): McSnapshot {
  const { ui, ...rest } = over;
  return {
    draft: { providers: draftProviders() },
    revision: { pi: 7, ds: 3 },
    ops: EMPTY_OPS,
    errors: {},
    loadError: null,
    saveError: null,
    defaultModel: { provider: 'gpt-gateway', model: 'gpt-6-luna', effort: 'max' },
    hasPi: true,
    hasDs: true,
    secretSet: {},
    ...rest,
    ui: { ...BASE_UI, ...ui },
  };
}

/** Snapshot fields for one provider patched, every other provider untouched. */
function snapWithProvider(id: string, over: Partial<ProviderDraft>): Partial<Omit<McSnapshot, 'ui'>> {
  const providers = draftProviders();
  providers[id] = { ...providers[id], ...over };
  return { draft: { providers } };
}

/**
 * Minimal ModelCapabilitiesStore: one frozen snapshot, a no-op subscribe, and
 * vi.fn() for every action method. The Proxy spells out only the two methods the
 * panel really needs, and stays in step with types.ts as it grows.
 */
function fakeStore(snap: McSnapshot): ModelCapabilitiesStore {
  const store: Record<string, unknown> = {
    getSnapshot: () => snap,
    subscribe: () => () => {},
    then: undefined, // never look like a promise to React
  };
  return new Proxy(store, {
    get: (target, prop) => (typeof prop === 'string' && !(prop in target) ? (target[prop] = vi.fn()) : (target as never)[prop]),
  }) as unknown as ModelCapabilitiesStore;
}

function renderPanel(opts: { ui?: Partial<McUi>; snap?: Partial<Omit<McSnapshot, 'ui'>>; close?: () => void } = {}): string {
  return renderToString(<ModelCapabilitiesPanel store={fakeStore(makeSnap({ ...opts.snap, ui: opts.ui }))} close={opts.close} />);
}

/* ================= helpers ================= */

/** SSR separates adjacent text nodes with <!-- -->; drop them before matching copy. */
function text(html: string): string {
  return html.replace(/<!-- -->/g, '');
}

/** Opening tags of <button> elements whose text contains `label`. */
function buttonTags(html: string, label: string): string[] {
  return [...html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].filter((m) => m[2].includes(label)).map((m) => m[1]);
}

/** The element right after the panel's root <div>: its content column, topbar-free. */
function firstElementAfterRoot(html: string): string {
  const root = html.match(/^<div[^>]*>/)?.[0];
  expect(root, 'root div').toBeDefined();
  return html.slice(root!.length).match(/^<[^>]*>/)?.[0] ?? '';
}

/** Text of every ARIA column header of the model table (spacer columns dropped). */
function columnHeaders(html: string): string[] {
  return [...html.matchAll(/role="columnheader"[^>]*>([^<]*)/g)].map((m) => m[1].trim()).filter(Boolean);
}

/** The slice of `html` between the first `from` and the next `to`. */
function between(html: string, from: string, to: string): string {
  const start = html.indexOf(from);
  expect(start, from).toBeGreaterThan(-1);
  const end = html.indexOf(to, start + from.length);
  expect(end, `${from} → ${to}`).toBeGreaterThan(-1);
  return html.slice(start, end);
}

/** One capacity field of the model edit layer: from its label to the next one. */
function capField(html: string, label: '上下文窗口' | '最大输出'): string {
  const start = html.indexOf(`>${label}</label>`);
  expect(start, label).toBeGreaterThan(-1);
  const next = html.indexOf('<label', start + 1);
  return html.slice(start, next < 0 ? undefined : next);
}

/** The 输入类型 section of the model edit layer (the chips and their hint). */
function inputSection(html: string): string {
  return between(html, '>输入类型</div>', '>思考</div>');
}

/** One model-table row, found by the aria-label of its selection checkbox. */
function tableRow(html: string, name: string): string {
  const at = html.indexOf(`aria-label="选择 ${name}"`);
  expect(at, name).toBeGreaterThan(-1);
  const start = html.lastIndexOf('<div role="row"', at);
  const next = html.indexOf('<div role="row"', at);
  return html.slice(start, next < 0 ? undefined : next);
}

/** One provider card on the list: from its name up to its 进入 button. */
function providerCard(html: string, name: string): string {
  const at = html.indexOf(name);
  expect(at, name).toBeGreaterThan(-1);
  const end = html.indexOf(`aria-label="进入 ${name}"`, at);
  expect(end, name).toBeGreaterThan(-1);
  return html.slice(at, end);
}

/** The bulk draft of gpt-gateway, with every field at its 不修改 default. */
function bulkDraft(over: Partial<BulkDraft> = {}): BulkDraft {
  return {
    route: 'gpt-gateway',
    scope: 'all',
    selSnapshot: [],
    inMode: 'none',
    inArr: [],
    th: 'none',
    thSel: [],
    cw: 'none',
    cwRaw: '',
    mt: 'none',
    mtRaw: '',
    copy: 'none',
    src: null,
    ...over,
  };
}

/** The wizard's third step for one provider that is being added. */
const WIZARD_STEP3: WizardDraft = {
  step: 3,
  api: 'openai-completions',
  id: 'my-gateway',
  tried2: true,
  ack: true,
  displayName: '',
  baseURL: 'https://my-gateway.example.com/v1',
  env: 'MY_GATEWAY_API_KEY',
  envTouched: true,
  headersOpen: false,
  headers: [],
  models: ['gpt-6-nova'],
  // R4b：WizardDraft 新增的必填字段（第 2 步的分钟原文，defaultWizard() 里是 '30'）。
  timeoutText: '30',
};

/* ================= 列表 ================= */

describe('模型能力列表（SSR）', () => {
  it('renders the title, LIST_DESC and every provider with its credential state and 进入', () => {
    const html = text(renderPanel());
    expect(html).toContain('模型能力');
    expect(html).toContain(LIST_DESC);
    expect(html).toContain('GPT Gateway');
    expect(html).toContain('gpt-gateway');
    expect(html).toContain('CC Gateway');
    expect(html).toContain('DeepSeek 官方');
    // One card with credentials (gpt-gateway) against two without them. The pi
    // card summary itself is no longer a credential word (R2), so the state is
    // read per card.
    expect(html.match(/凭证缺失/g)).toHaveLength(2);
    expect(providerCard(html, 'GPT Gateway')).toContain('已配置');
    expect(providerCard(html, 'CC Gateway')).toContain('凭证缺失');
    expect(providerCard(html, 'DeepSeek 官方')).toContain('凭证缺失');
    expect(html.match(/aria-label="进入 /g)).toHaveLength(3);
    // Custom providers keep the record order; the official card is always last (spec B1).
    expect(html.indexOf('CC Gateway')).toBeLessThan(html.indexOf('DeepSeek 官方'));
  });

  it('keeps 还没有自定义提供方。for a DeepSeek-only config', () => {
    const providers = draftProviders();
    const html = text(renderPanel({
      snap: { draft: { providers: { [DS_ROUTE_ID]: providers[DS_ROUTE_ID] } }, hasPi: false },
    }));
    expect(html).toContain('还没有自定义提供方。');
    expect(html).toContain('DeepSeek 官方');
    expect(html).not.toContain('gpt-gateway');
  });

  it('shows the read-only default-model line only when all three fields are there', () => {
    expect(text(renderPanel())).toContain('默认模型（只读）：gpt-gateway / gpt-6-luna · max');
    expect(text(renderPanel({ snap: { defaultModel: null } }))).not.toContain('默认模型（只读）');
  });

  it('names the official provider in the read-only line while llm-deepseek is installed', () => {
    const html = text(renderPanel({
      snap: { defaultModel: { provider: DS_ROUTE_ID, model: 'deepseek-v4-pro', effort: 'high' } },
    }));
    expect(html).toContain('默认模型（只读）：deepseek-official / deepseek-v4-pro · high');
  });

  it('provider cards: no 默认档 anywhere, 有旧字段 on the pi card with the legacy model, 不可删除 on DS', () => {
    const html = text(renderPanel());
    expect(html).not.toContain('未设默认档');

    const gpt = providerCard(html, 'GPT Gateway');
    expect(gpt).not.toContain('默认档');
    expect(gpt).toContain('有旧字段');

    const cc = providerCard(html, 'CC Gateway');
    expect(cc).not.toContain('默认档');
    expect(cc).not.toContain('有旧字段');

    const ds = providerCard(html, 'DeepSeek 官方');
    expect(ds).not.toContain('默认档');
    expect(ds).toContain('不可删除');
  });
});

/* ================= 详情 ================= */

describe('提供方详情（SSR）', () => {
  const detail = (route: string): Partial<McUi> => ({ view: 'detail', route });

  it('pi detail: no 提供方默认值 or 默认档, with 批量设置, the four columns and 删除提供方', () => {
    const html = text(renderPanel({ ui: detail('gpt-gateway') }));
    for (const gone of ['提供方默认值', '默认档', '未设默认档', '路由默认档', '继承中']) {
      expect(html, gone).not.toContain(gone);
    }
    expect(html).toContain('批量设置');
    expect(columnHeaders(html).slice(0, 4)).toEqual(['模型', '输入', '思考', '容量']);
    expect(html).toContain('gpt-6-luna');
    expect(html).toContain('gpt-6-legacy');
    expect(html).toContain('删除提供方');
  });

  it('pi detail: the legacy inputModalities show 迁移为 input and the 旧 tag on the row', () => {
    const html = text(renderPanel({ ui: detail('gpt-gateway') }));
    expect(html).toContain('迁移为 input');
    expect(html).toMatch(/>旧</);

    const clean = text(renderPanel({
      ui: detail('gpt-gateway'),
      snap: snapWithProvider('gpt-gateway', { models: [model('gpt-6-luna', { input: ['text'] })] }),
    }));
    expect(clean).not.toContain('迁移为 input');
  });

  it('DeepSeek detail: 官方提供方由「模型」页接入, no 删除提供方, the 思考 hint, no 提供方默认值', () => {
    const off = text(renderPanel({ ui: detail(DS_ROUTE_ID) }));
    expect(off).toContain('官方提供方由「模型」页接入');
    expect(off).not.toContain('删除提供方');
    expect(off).not.toContain('提供方默认值');
    expect(off).toContain('关闭思考时只能是 off。');

    const on = text(renderPanel({
      ui: detail(DS_ROUTE_ID),
      snap: snapWithProvider(DS_ROUTE_ID, { thinking: 'enabled', reasoningEffort: 'high' }),
    }));
    expect(on).not.toContain('关闭思考时只能是 off。');
    expect(on).toContain('四档单选，所有模型共用。');
    expect(on).not.toContain('提供方默认值');
  });
});

/* ================= 图层 ================= */

describe('图层（SSR）', () => {
  const editUi = (idx: number, route = 'gpt-gateway'): Partial<McUi> => ({
    view: 'detail',
    route,
    edit: { kind: 'model', route, idx },
  });
  const accessUi = (route = 'gpt-gateway'): Partial<McUi> => ({
    view: 'detail',
    route,
    edit: { kind: 'access', route },
  });

  it('模型编辑层: 清除 and 线上拼写 stay, the 继承 wording is gone, the legacy hint is the R2 one', () => {
    const explicit = text(renderPanel({ ui: editUi(0) }));
    expect(explicit).toContain('线上拼写');
    expect(explicit).toMatch(/aria-label="low 的线上拼写"/);
    expect(explicit).toMatch(/aria-label="high 的线上拼写"/);
    expect(explicit).toContain('清除');
    expect(explicit).toContain('gpt-6-luna');
    expect(explicit).toContain('上下文窗口是请求与响应合计的 token 上限。');

    const legacy = text(renderPanel({ ui: editUi(1) }));
    expect(legacy).toContain('配置里还有旧字段 inputModalities: [text]，自定义提供方会忽略它。可在模型列表上方「迁移为 input」。');
    for (const gone of ['恢复继承', '单独设置', '缺省顺序', '继承']) {
      expect(legacy, gone).not.toContain(gone);
    }
  });

  it('容量字段: unset shows the 未设置 placeholder and hint', () => {
    const html = text(renderPanel({ ui: editUi(1) }));
    for (const label of ['上下文窗口', '最大输出'] as const) {
      const field = capField(html, label);
      expect(field, label).toContain('placeholder="未设置"');
      expect(field, label).toContain('>未设置</p>');
      expect(field, label).not.toContain('已设置');
    }
  });

  it('容量字段: a set side says 已设置, and pi 最大输出 adds the request-default note', () => {
    const html = text(renderPanel({ ui: editUi(0) }));
    for (const label of ['上下文窗口', '最大输出'] as const) {
      expect(capField(html, label), label).toContain('已设置。留空或点「清除」会删掉这个字段。');
    }
    expect(capField(html, '最大输出')).toContain('显式写入后，这个值会成为该模型每次请求的默认输出上限。');
    expect(capField(html, '上下文窗口')).not.toContain('显式写入后');
  });

  it('容量字段: the 最大输出 note stays off on DeepSeek (pi is false)', () => {
    const html = text(renderPanel({
      ui: editUi(0, DS_ROUTE_ID),
      snap: snapWithProvider(DS_ROUTE_ID, {
        models: [model('deepseek-chat', { contextWindow: '128K', maxTokens: '8192' })],
      }),
    }));
    expect(capField(html, '最大输出')).toContain('已设置。留空或点「清除」会删掉这个字段。');
    expect(capField(html, '最大输出')).not.toContain('显式写入后');
  });

  it('输入: an unset model reads 未设置 in the table and offers two unpressed chips with 未设置', () => {
    const html = text(renderPanel({ ui: editUi(1) }));
    const row = tableRow(html, 'gpt-6-legacy');
    expect(row).toContain('未设置');
    expect(row).not.toContain('继承');

    const section = inputSection(html);
    expect(section.match(/aria-pressed="false"/g) ?? []).toHaveLength(2);
    expect(section).not.toContain('aria-pressed="true"');
    expect(section).toContain('未设置');
  });

  it('输入: an explicit input keeps both chips pressed and needs no 未设置 note', () => {
    const section = inputSection(text(renderPanel({ ui: editUi(0) })));
    expect(section.match(/aria-pressed="true"/g) ?? []).toHaveLength(2);
    expect(section).not.toContain('未设置');
  });

  it('批量层: 清除 per group, 批量设置 with the only-what-you-touched note, no 继承 wording', () => {
    const html = text(renderPanel({ ui: { view: 'detail', route: 'gpt-gateway', bulk: bulkDraft() } }));
    expect(html).toContain('批量设置');
    expect(html).toContain('只改你动过的项。未动的项保持每个模型现在的值。');
    expect(html).toContain('清除');
    for (const gone of ['恢复继承', '留空以恢复继承']) {
      expect(html, gone).not.toContain(gone);
    }
  });

  it('批量层: the copy lock note shows in all three groups and the copy sentence keeps 源未设置', () => {
    const html = text(renderPanel({ ui: { view: 'detail', route: 'gpt-gateway', bulk: bulkDraft({ copy: 'copy' }) } }));
    expect((html.match(/正在从模型复制，这一组已锁定。/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(html).toContain('源未设置的项会在目标上清除');
  });

  it('向导第 3 步: only the model list, no 默认值 wording', () => {
    const html = text(renderPanel({ ui: { view: 'wizard', wizard: WIZARD_STEP3 } }));
    expect(html).toContain('添加提供方');
    expect(html).toContain('aria-label="模型 ID 1"');
    for (const gone of ['默认值', '默认输入', '路由默认档']) {
      expect(html, gone).not.toContain(gone);
    }
  });

  it('编辑接入层: no 默认值 section, and errors.headers shows with the 请求头 rows', () => {
    const clean = text(renderPanel({ ui: accessUi() }));
    expect(clean).toContain('请求头');
    expect(clean).not.toContain('默认值');

    const dup = '请求头名称「A」、「B」重复。请改成不同的名称后再保存。';
    const err = text(renderPanel({
      ui: accessUi(),
      snap: { errors: { 'gpt-gateway': { route: { headers: dup }, models: [] } } },
    }));
    expect(err).toContain(dup);
    // It belongs to the 请求头 section: the rows and their 添加 button come first.
    expect(err.indexOf('+ 添加请求头')).toBeGreaterThan(-1);
    expect(err.indexOf(dup)).toBeGreaterThan(err.indexOf('+ 添加请求头'));
  });
});

/* ================= 模型表 ================= */

describe('模型表（SSR）', () => {
  const detail: Partial<McUi> = { view: 'detail', route: 'gpt-gateway' };

  it('容量列: an unset model shows 未设置 under the 上下文未设置 aria label', () => {
    const row = tableRow(text(renderPanel({ ui: detail })), 'gpt-6-legacy');
    expect(row).toContain('未设置');
    expect(row).toMatch(/aria-label="上下文未设置/);
  });

  it('表格轨道: the R2 gridTemplateColumns and minWidth:0 on the table', () => {
    const html = text(renderPanel({ ui: detail }));
    expect(html).toContain(
      'grid-template-columns:24px minmax(96px,1.6fr) minmax(64px,1fr) minmax(56px,1.2fr) minmax(84px,max-content) max-content',
    );
    const tag = html.match(/<div role="table"[^>]*>/)?.[0] ?? '';
    expect(tag).toContain('min-width:0');
  });
});

/* ================= 预览 ================= */

describe('预览（SSR）', () => {
  const OPS: OpsResult = {
    pi: [{ op: 'set', path: ['providers', 'gpt-gateway', 'models'], value: [{ id: 'gpt-6-luna' }] }],
    ds: [],
    cred: [{ op: 'set', ref: 'GPT_GATEWAY_API_KEY' }],
    dirty: 1,
    dirtySet: new Set(['gpt-gateway']),
  };

  it('lists the real ops per namespace, with YAML paths and no secret value', () => {
    const html = text(renderPanel({ ui: { view: 'preview' }, snap: { ops: OPS } }));
    expect(html).toContain('llm-pi-ai');
    expect(html).toContain('path: [providers, gpt-gateway, models]');
    expect(html).toContain('credentials.set');
    expect(html).toContain('GPT_GATEWAY_API_KEY');
    expect(html).toContain('（值不展示）');
    // The snapshot never carries a plaintext secret (spec B1), so nothing leaks.
    expect(html).not.toContain('sk-');
  });
});

/* ================= 状态 ================= */

describe('状态条与横幅（SSR）', () => {
  it('conflict: 这次没写入 offers 重新加载 + 保留草稿, the kept wording only 重新加载', () => {
    expect(text(renderPanel())).not.toContain('被别处改过');

    const shown = text(renderPanel({ ui: { conflict: 'shown' } }));
    expect(shown).toContain('这份配置刚刚被别处改过，这次没写入。你的修改还在。');
    expect(buttonTags(shown, '重新加载')).toHaveLength(1);
    expect(buttonTags(shown, '保留草稿')).toHaveLength(1);

    const kept = text(renderPanel({ ui: { conflict: 'kept' } }));
    expect(kept).toContain('这份配置刚刚被别处改过。草稿还在，但解除冲突前保存会失败。');
    expect(buttonTags(kept, '重新加载')).toHaveLength(1);
    expect(buttonTags(kept, '保留草稿')).toHaveLength(0);
  });

  it('readonly: the banner and the save bar keep navigation and preview usable', () => {
    const html = text(renderPanel({ ui: { readonly: true } }));
    expect(html).toContain('只能在本机上修改设置。');
    expect(html).toContain('只读模式，不能保存。');
    expect(buttonTags(html, '保存')[0]).toContain('disabled');
    expect(buttonTags(html, '预览变更')[0]).not.toContain('disabled');
  });

  it('save bar: field errors replace the count with 处无法保存 and disable 保存', () => {
    const html = text(renderPanel({
      snap: {
        ...snapWithProvider('gpt-gateway', { apiKeyEnv: '', models: [model('', { reasoningEfforts: { low: 'low' } })] }),
        ops: { ...EMPTY_OPS, dirty: 2, dirtySet: new Set(['gpt-gateway']) },
        errors: { 'gpt-gateway': { route: { apiKeyEnv: '填写密钥环境变量名。' }, models: [{ id: '填写模型 ID' }] } },
      },
    }));
    expect(html).toContain('2 处无法保存');
    expect(buttonTags(html, '保存')[0]).toContain('disabled');
  });

  it('CL3: the host close prop renders neither a 关闭 button nor the topbar strip', () => {
    const withClose = renderPanel({ close: () => {} });
    const withoutClose = renderPanel();

    // The panel still renders: 模型能力 is the list view's h2, and the root's
    // first child is the content column either way (no extra strip).
    expect(withClose).toContain('模型能力');
    expect(firstElementAfterRoot(withClose)).toMatch(/^<div/);
    expect(firstElementAfterRoot(withClose)).toBe(firstElementAfterRoot(withoutClose));

    expect(buttonTags(withClose, '关闭')).toHaveLength(0);
    expect(buttonTags(withoutClose, '关闭')).toHaveLength(0);
    // The removed topbar's own style: display:flex;justify-content:flex-end;padding:8px 16px 0;flex:none
    expect(withClose).not.toContain('padding:8px 16px 0');
    expect(withoutClose).not.toContain('padding:8px 16px 0');
  });

  it('loading announces 正在加载配置', () => {
    expect(text(renderPanel({ ui: { loading: true } }))).toContain('正在加载配置');
  });
});

/* ================= 导入导出（R3 文档 1.3、1.9） ================= */

/** 契约 1.9 的警告与说明原文。 */
const IMPORT_WARNING =
  '文件不应包含密钥或请求头。这些字段会被丢弃，不会进入草稿。baseURL 和 apiKeyEnv 会随新提供方写入草稿，分享来的文件请先看过。';
const IMPORT_NOTE =
  '已存在的提供方默认不覆盖。勾选「覆盖」后，自定义提供方只替换模型、显示名和 API，保留本机的 baseURL、密钥环境变量名和请求头。DeepSeek 只合并思考设置和模型表。';

/** 一个 conflict、一个 new、一个 invalid：勾选状态与 1.5 的预览初值一致。 */
const IMPORT_ITEMS = [
  { kind: 'conflict' as const, id: 'gpt-gateway', label: 'GPT Gateway', reason: "提供方 'gpt-gateway' 已存在", checked: false, checkable: true },
  { kind: 'new' as const, id: 'brand-new', label: 'Brand New', reason: "将新增提供方 'brand-new'", checked: true, checkable: true },
  { kind: 'invalid' as const, id: 'Bad_Id', label: 'Bad_Id', reason: "提供方 ID 'Bad_Id' 不合法", checked: false, checkable: false },
];

function previewUi(): Partial<McUi> {
  return { importPreview: { fileName: 'x.yaml', items: IMPORT_ITEMS, selected: ['brand-new'], warning: IMPORT_WARNING } };
}

/** 从对话框标题到 html 末尾的那一段（对话框总是渲染在主区之后）。 */
function dialogRegion(html: string): string {
  const at = html.indexOf('导入模型配置');
  expect(at, '导入模型配置').toBeGreaterThan(-1);
  return html.slice(at);
}

/** 含有 checkbox 的 <label> 块的可见文字（SSR 没有 DOM，只能用文本近似）。 */
function checkboxLabels(html: string): string[] {
  return [...html.matchAll(/<input[^>]*type="checkbox"[^>]*>([\s\S]*?)(?:<\/label>|<\/span>|<\/div>)/g)]
    .map((m) => m[1].replace(/<[^>]*>/g, ' ').trim());
}

/** React SSR 会把文本里的 ' 转义成 &#x27;，比对 reason 前先解回来。 */
function decodeEntities(html: string): string {
  return html
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

describe('列表头的导出与导入（R3 1.3、1.9）', () => {
  it('按钮顺序为 导出、导入、添加提供方，导入用的是 ImportFileButton', () => {
    const html = text(renderPanel());
    const exportAt = html.indexOf('>导出</button>');
    const importAt = html.indexOf('>导入</button>');
    const addAt = html.indexOf('>添加提供方</button>');
    expect(exportAt, '导出').toBeGreaterThan(-1);
    expect(importAt, '导入').toBeGreaterThan(-1);
    expect(addAt, '添加提供方').toBeGreaterThan(-1);
    expect(html, 'ImportFileButton 的 aria-label').toContain('aria-label="导入配置文件"');
    expect(exportAt).toBeLessThan(importAt);
    expect(importAt).toBeLessThan(addAt);
  });

  it('只读：导入禁用并带「只读模式，不能导入」，导出可点', () => {
    const html = text(renderPanel({ ui: { readonly: true } }));
    const exportTag = buttonTags(html, '导出')[0];
    const importTag = buttonTags(html, '导入')[0];
    expect(exportTag, '导出按钮').toBeDefined();
    expect(importTag, '导入按钮').toBeDefined();
    expect(exportTag).not.toContain('disabled');
    expect(importTag).toContain('disabled');
    expect(importTag).toContain('title="只读模式，不能导入"');
  });

  it('有未保存的修改：导入禁用并带契约 title，导出仍可点', () => {
    const html = text(renderPanel({ snap: { ops: { ...EMPTY_OPS, dirty: 1 } } }));
    const exportTag = buttonTags(html, '导出')[0];
    const importTag = buttonTags(html, '导入')[0];
    expect(exportTag, '导出按钮').toBeDefined();
    expect(importTag, '导入按钮').toBeDefined();
    expect(exportTag).not.toContain('disabled');
    expect(importTag).toContain('disabled');
    expect(importTag).toContain('title="有未保存的修改或配置冲突，请先保存、放弃或重新加载后再导入"');
  });

  it('加载中：两个按钮都禁用', () => {
    const html = text(renderPanel({ ui: { loading: true } }));
    expect(buttonTags(html, '导出')[0], '导出按钮').toBeDefined();
    expect(buttonTags(html, '导出')[0]).toContain('disabled');
    expect(buttonTags(html, '导入')[0], '导入按钮').toBeDefined();
    expect(buttonTags(html, '导入')[0]).toContain('disabled');
  });
});

describe('导入预览对话框（R3 1.9）', () => {
  it('importPreview 为 null 时不渲染对话框，有值时渲染', () => {
    expect(text(renderPanel())).not.toContain('导入模型配置');
    expect(text(renderPanel({ ui: previewUi() }))).toContain('导入模型配置');
  });

  it('标题、文件名、警告、说明、计数与按钮', () => {
    const html = text(renderPanel({ ui: previewUi() }));
    expect(html).toContain('导入模型配置');
    expect(html).toContain('文件：x.yaml');
    expect(html).toContain(IMPORT_WARNING);
    expect(html).toContain(IMPORT_NOTE);
    expect(html).toContain('将新增 1 项，覆盖 0 项，跳过 2 项。');
    expect(buttonTags(html, '确认导入（1）')).toHaveLength(1);
    expect(buttonTags(html, '取消')).toHaveLength(1);
    expect(html, '旧文案').not.toContain('已存在的配置不会被覆盖');
  });

  it('每行有 label、徽章和 reason；只有 checkable 的项有勾选框，文字是 导入/覆盖', () => {
    const region = dialogRegion(text(renderPanel({ ui: previewUi() })));
    const plain = decodeEntities(region);
    expect(plain).toContain('GPT Gateway');
    expect(plain).toContain('Brand New');
    expect(plain).toContain("提供方 'gpt-gateway' 已存在");
    expect(plain).toContain("将新增提供方 'brand-new'");
    expect(plain).toContain("提供方 ID 'Bad_Id' 不合法");
    for (const badge of ['新增', '覆盖', '无效']) expect(plain, badge).toContain(badge);

    // invalid 的 checkable 为 false → 不渲染勾选框
    expect(region.match(/type="checkbox"/g) ?? []).toHaveLength(2);
    const labels = checkboxLabels(region);
    expect(labels).toHaveLength(2);
    expect(labels.filter((label) => label.includes('导入'))).toHaveLength(1);
    expect(labels.filter((label) => label.includes('覆盖'))).toHaveLength(1);
  });
});

/* ==========================================================================
 * R4b 流空闲超时（docs/specs/r4b-stream-idle-timeout.md 第 6 节）：P1–P4。
 *
 * 只追加用例；TimeoutField.tsx 现在还不存在，所以这些断言现在是红的。
 * ========================================================================== */

const T_KEY = 'streamIdleTimeoutMs';
const T_NOTE = '连续这么久没有收到任何数据就判定超时；不是单次调用的总时长。超时后 DSH 会话默认会自动重试。';
const T_HINT_UNSET = '未设置 · 使用 DSH 默认 5 分钟。建议 30 分钟。';

/** 只给一个提供方补上 R4b 的字段，其它提供方不变。 */
function snapWithTimeout(id: string, over: Record<string, unknown>): Partial<Omit<McSnapshot, 'ui'>> {
  const providers = draftProviders();
  providers[id] = { ...providers[id], ...over } as ProviderDraft;
  return { draft: { providers } };
}

/** 第一个带 data-mc hook 的 input/button 开始标签（属性顺序无关）。 */
function tagWith(html: string, dataMc: string): string {
  return html.match(new RegExp(`<(?:input|button)[^>]*data-mc="${dataMc}"[^>]*>`))?.[0] ?? '';
}

/** 所有带 data-mc hook 的 input/button 开始标签。 */
function tagsWith(html: string, dataMc: string): string[] {
  return [...html.matchAll(new RegExp(`<(?:input|button)[^>]*data-mc="${dataMc}"[^>]*>`, 'g'))].map((m) => m[0]);
}

describe('R4b 超时字段（SSR）：P1–P4', () => {
  const accessUi: Partial<McUi> = { view: 'detail', route: 'gpt-gateway', edit: { kind: 'access', route: 'gpt-gateway' } };

  it('P1 接入层: hook、value=30、hint、语义说明，且位于密钥环境变量名之后、请求头之前', () => {
    const html = text(renderPanel({ ui: accessUi, snap: snapWithTimeout('gpt-gateway', { [T_KEY]: 1800000 }) }));

    expect(html).toContain('data-mc="timeout"');
    expect(html).toContain('data-mc-scope="access"');
    expect(html).toContain('>超时</div>');
    expect(tagWith(html, 'timeout-input')).toContain('value="30"');
    expect(html).toContain('= 1800000 ms · 30 分钟');
    expect(html).toContain(T_NOTE);

    const keyAt = html.indexOf('密钥环境变量名');
    const timeoutAt = html.indexOf('data-mc="timeout"');
    const headersAt = html.indexOf('请求头');
    expect(keyAt).toBeGreaterThan(-1);
    expect(timeoutAt).toBeGreaterThan(keyAt);
    expect(headersAt).toBeGreaterThan(timeoutAt);
  });

  it('P2 DS 详情: scope=ds、未设置 hint、摘要、新描述原文', () => {
    const html = text(renderPanel({ ui: { view: 'detail', route: DS_ROUTE_ID } }));

    expect(html).toContain('data-mc="timeout"');
    expect(html).toContain('data-mc-scope="ds"');
    expect(tagWith(html, 'timeout-input')).toContain('placeholder="30"');
    expect(html).toContain(T_HINT_UNSET);
    expect(html).toContain('data-mc="timeout-summary"');
    expect(html).toContain('流空闲超时 默认 5 分钟');
    expect(html).toContain('官方提供方由「模型」页接入，这里改思考和超时。接入本身不在这里改。');
  });

  it('P3 错误态 aria-invalid 与文案；只读时 input、芯片、恢复按钮都 disabled', () => {
    const err = text(renderPanel({
      ui: accessUi,
      snap: {
        ...snapWithTimeout('gpt-gateway', { [T_KEY]: 1800000 }),
        errors: { 'gpt-gateway': { route: { [T_KEY]: '请输入大于 0 的分钟数' }, models: [] } },
      },
    }));
    expect(tagWith(err, 'timeout-input')).toContain('aria-invalid="true"');
    expect(err).toContain('请输入大于 0 的分钟数');

    const locked = text(renderPanel({
      ui: { ...accessUi, readonly: true },
      snap: snapWithTimeout('gpt-gateway', { [T_KEY]: 1800000 }),
    }));
    expect(tagWith(locked, 'timeout-input')).toContain('disabled');
    const chips = tagsWith(locked, 'timeout-preset');
    expect(chips).toHaveLength(3);
    for (const chip of chips) expect(chip).toContain('disabled');
    expect(tagWith(locked, 'timeout-reset')).toContain('disabled');
  });

  it('P4 向导第 2 步: scope=wizard、value=30、30 分钟（推荐）芯片 aria-pressed', () => {
    const html = text(renderPanel({ ui: { view: 'wizard', wizard: { ...WIZARD_STEP3, step: 2, timeoutText: '30' } } }));

    expect(html).toContain('data-mc-scope="wizard"');
    expect(tagWith(html, 'timeout-input')).toContain('value="30"');
    expect(html).toContain('= 1800000 ms · 30 分钟');

    const chips = buttonTags(html, '分钟');
    expect(chips).toHaveLength(3);
    expect(chips.filter((chip) => chip.includes('aria-pressed="true"'))).toHaveLength(1);
    const recommended = buttonTags(html, '30 分钟（推荐）');
    expect(recommended).toHaveLength(1);
    expect(recommended[0]).toContain('aria-pressed="true"');
  });
});

/* ==========================================================================
 * R4a 模型可用性测试（docs/specs/r4a-model-test.md §2.3、§2.6、§4 节）：P01–P11。
 *
 * 只在新增的 `snap.test` 上做 SSR 字符串断言：data-mc* 钩子、aria 属性、逐字文案。
 * 组件还不存在，所以这一组现在是红的；`snap.test === undefined` 时（P01）旧输出不变。
 * 颜色扫描 P11 覆盖同一批新组件。
 * ========================================================================== */

type TestState = 'queued' | 'running' | 'ok' | 'fail' | 'transient' | 'cancelled';

interface TestResultLike {
  provider: string;
  model: string;
  ok: boolean;
  latencyMs: number | null;
  firstTokenMs: number | null;
  sample: string;
  finish: string | null;
  errorKind: string | null;
  status: number | null;
  message: string;
  transient: boolean;
  params: { effort: string | null; maxTokens: number; timeoutMs: number };
  testedAt: string;
}

interface TestEntryLike {
  state: TestState;
  result?: TestResultLike;
  at?: number;
  startedAt?: number;
}

interface TestBatchLike {
  route: string;
  keys: string[];
  label: '全部模型' | '所选模型' | '重试失败项' | '已取消的模型';
  stopped: boolean;
  done: boolean;
  startedAt: number;
  endedAt?: number;
}

interface McTestStateLike {
  hostUnsupported: boolean;
  results: Record<string, TestEntryLike>;
  batches: Record<string, TestBatchLike>;
  open: string | null;
  cost: { route: string; modelIds: string[]; label: TestBatchLike['label'] } | null;
  skipCost: boolean;
  blocked: Record<string, string | null>;
  live: string;
}

const MC_T0 = new Date(2026, 9, 8, 2, 40, 0).getTime();
const MC_IDS = ['m1', 'm2', 'm3', 'm4', 'm5'];
const mcKey = (id: string): string => `gpt-gateway|${id}`;

/** 契约 §1.1 的 200 体：默认成功、812 ms、首 token 341 ms。 */
function mcResult(over: Partial<TestResultLike> = {}): TestResultLike {
  return {
    provider: 'gpt-gateway',
    model: 'm1',
    ok: true,
    latencyMs: 812,
    firstTokenMs: 341,
    sample: 'OK',
    finish: 'stop',
    errorKind: null,
    status: null,
    message: '',
    transient: false,
    params: { effort: 'off', maxTokens: 32, timeoutMs: 20000 },
    testedAt: '2026-10-08T02:40:00.000Z',
    ...over,
  };
}

function mcOk(id = 'm1'): TestEntryLike {
  return { state: 'ok', result: mcResult({ model: id }), at: MC_T0 + 812 };
}

function mcFail(kind: string, status: number | null, over: Partial<TestEntryLike> = {}): TestEntryLike {
  return {
    state: 'fail',
    at: MC_T0 + 230,
    result: mcResult({ ok: false, latencyMs: 230, firstTokenMs: null, sample: '', finish: 'error', errorKind: kind, status, message: 'Incorrect API Key', model: 'm2' }),
    ...over,
  };
}

function mcTransient(): TestEntryLike {
  return mcFail('RATE_LIMIT', 429, { state: 'transient', result: mcResult({ ok: false, latencyMs: 230, firstTokenMs: null, sample: '', finish: 'error', errorKind: 'RATE_LIMIT', status: 429, transient: true, message: 'rate limited', model: 'm2' }) });
}

function mcTest(over: Partial<McTestStateLike> = {}): McTestStateLike {
  return {
    hostUnsupported: false,
    results: {},
    batches: {},
    open: null,
    cost: null,
    skipCost: false,
    blocked: {},
    live: '',
    ...over,
  };
}

function mcBatch(over: Partial<TestBatchLike> = {}): TestBatchLike {
  return { route: 'gpt-gateway', keys: MC_IDS.map(mcKey), label: '全部模型', stopped: false, done: false, startedAt: MC_T0, ...over };
}

/** gpt-gateway 的模型表换成给定 id（其余提供方照旧）。 */
function mcProviders(ids: string[] = MC_IDS): Record<string, ProviderDraft> {
  const providers = draftProviders();
  providers['gpt-gateway'] = { ...providers['gpt-gateway'], models: ids.map((id) => model(id, { name: id })) };
  return providers;
}

function mcSnap(
  test: McTestStateLike | undefined,
  opts: { ui?: Partial<McUi>; snap?: Partial<Omit<McSnapshot, 'ui'>> } = {},
): McSnapshot {
  const base = makeSnap({ ...opts.snap, ui: opts.ui });
  return (test === undefined ? base : { ...base, test }) as unknown as McSnapshot;
}

function renderMc(
  test: McTestStateLike | undefined,
  opts: { ui?: Partial<McUi>; snap?: Partial<Omit<McSnapshot, 'ui'>> } = {},
): string {
  return text(renderToString(<ModelCapabilitiesPanel store={fakeStore(mcSnap(test, opts))} close={() => {}} />));
}

/** 带该属性的完整 <button>…</button>（文本在标签体内，需要整段取）。 */
function mcButton(html: string, attr: string): string {
  const at = html.indexOf(attr);
  expect(at, attr).toBeGreaterThan(-1);
  const start = html.lastIndexOf('<button', at);
  expect(start, `<button ${attr}>`).toBeGreaterThan(-1);
  const end = html.indexOf('</button>', at);
  expect(end, `</button> ${attr}`).toBeGreaterThan(-1);
  return html.slice(start, end);
}

const MC_DETAIL: Partial<McUi> = { view: 'detail', route: 'gpt-gateway' };

describe('R4a 模型测试（SSR）：P01–P11', () => {
  it('P01 没有 test 字段 → 不含 data-mc-test 与「测试全部」', () => {
    const html = renderMc(undefined);

    expect(html).not.toContain('data-mc-test');
    expect(html).not.toContain('测试全部');
  });

  it('P02 详情页：全部测试 / 测试所选（0）/ 每个模型的 data-mc-test 与 aria-label', () => {
    const html = renderMc(mcTest(), { ui: MC_DETAIL, snap: { draft: { providers: mcProviders() } } });

    expect(html).toContain('全部测试');
    expect(html).toContain('测试所选（0）');
    for (const id of MC_IDS) {
      expect(html, id).toContain(`data-mc-test="${id}"`);
      expect(html, id).toContain(`aria-label="测试 ${id}"`);
    }
  });

  it('P03 ok 条目：data-mc-strip / data-mc-state / 可用 / 重测 / aria-expanded=false', () => {
    const html = renderMc(mcTest({ results: { [mcKey('m1')]: mcOk() } }), {
      ui: MC_DETAIL,
      snap: { draft: { providers: mcProviders() } },
    });

    expect(html).toContain('data-mc-strip="m1"');
    expect(html).toContain('data-mc-state="ok"');
    expect(html).toContain('data-mc-detail="m1"');
    expect(html).toContain('可用');
    expect(mcButton(html, 'data-mc-detail="m1"')).toContain('aria-expanded="false"');
    expect(mcButton(html, 'data-mc-retest="m1"')).toContain('重测');
  });

  it('P04 transient 条目：data-mc-state="transient"、重试按钮是「↻ 重试」', () => {
    const html = renderMc(mcTest({ results: { [mcKey('m2')]: mcTransient() } }), {
      ui: MC_DETAIL,
      snap: { draft: { providers: mcProviders() } },
    });

    expect(html).toContain('data-mc-state="transient"');
    expect(html).toContain('被限流');
    const retest = mcButton(html, 'data-mc-retest="m2"');
    expect(retest).toContain('↻');
    expect(retest).toContain('重试');
  });

  it('P05 open 的详情：data-mc-tdetail / 请求参数 / 与提供方流空闲超时无关 / （已脱敏）', () => {
    const html = renderMc(mcTest({ results: { [mcKey('m2')]: mcFail('AUTH', 401) }, open: mcKey('m2') }), {
      ui: MC_DETAIL,
      snap: { draft: { providers: mcProviders() } },
    });

    expect(html).toContain('data-mc-tdetail="m2"');
    expect(html).toContain('请求参数');
    expect(html).toContain('与提供方流空闲超时无关');
    expect(html).toContain('（已脱敏）');
    expect(html).toContain('401');
    expect(mcButton(html, 'data-mc-detail="m2"')).toContain('aria-expanded="true"');
  });

  it('P06 批次进行中：progressbar / aria-valuemax=5 / 停止；结束：测试完成 + 仅重试失败项（1）', () => {
    const providers = { draft: { providers: mcProviders() } };
    const inFlight = mcTest({
      batches: { 'gpt-gateway': mcBatch() },
      results: {
        [mcKey('m1')]: mcOk('m1'),
        [mcKey('m2')]: mcOk('m2'),
        [mcKey('m3')]: mcFail('AUTH', 401),
        [mcKey('m4')]: { state: 'queued' },
        [mcKey('m5')]: { state: 'queued' },
      },
    });
    const html = renderMc(inFlight, { ui: MC_DETAIL, snap: providers });

    expect(html).toContain('data-mc="batch"');
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuemax="5"');
    expect(mcButton(html, 'data-mc="batch-stop"')).toContain('停止');
    expect(html).toContain('已完成 3/5，失败 1');

    const finished = mcTest({
      batches: { 'gpt-gateway': mcBatch({ done: true, endedAt: MC_T0 + 20000 }) },
      results: {
        [mcKey('m1')]: mcOk('m1'),
        [mcKey('m2')]: mcFail('AUTH', 401),
        [mcKey('m3')]: mcOk('m3'),
        [mcKey('m4')]: mcOk('m4'),
        [mcKey('m5')]: mcOk('m5'),
      },
    });
    const doneHtml = renderMc(finished, { ui: MC_DETAIL, snap: providers });

    expect(doneHtml).toContain('测试完成');
    expect(mcButton(doneHtml, 'data-mc="batch-retry-failed"')).toContain('仅重试失败项（1）');
  });

  it('P07 费用确认：测试 5 个模型？ / 开始测试 / 本次会话不再提示', () => {
    const html = renderMc(mcTest({ cost: { route: 'gpt-gateway', modelIds: MC_IDS, label: '全部模型' } }), {
      snap: { draft: { providers: mcProviders() } },
    });

    expect(html).toContain('测试 5 个模型？');
    expect(html).toContain('本次会话不再提示');
    expect(mcButton(html, 'data-mc="cost-ok"')).toContain('开始测试');
    expect(mcButton(html, 'data-mc="cost-cancel"')).toContain('取消');
  });

  it('P08 hostUnsupported：横幅原文 + 选择栏/卡片按钮 aria-disabled + 卡片原因行', () => {
    const state = mcTest({ hostUnsupported: true });
    const providers = { draft: { providers: mcProviders() } };

    const detail = renderMc(state, { ui: MC_DETAIL, snap: providers });
    expect(detail).toContain('data-mc="test-unsupported"');
    expect(detail).toContain('当前 Host 不支持模型测试，重启 DSH 后可用。');
    expect(tagWith(detail, 'test-all')).toContain('aria-disabled="true"');
    expect(mcButton(detail, 'data-mc-test="m1"')).toContain('aria-disabled="true"');

    const list = renderMc(state, { snap: providers });
    expect(mcButton(list, 'data-mc-test-all="gpt-gateway"')).toContain('aria-disabled="true"');
    expect(list).toContain('id="mc-card-why-gpt-gateway"');
    expect(list).toContain('当前 Host 不支持模型测试，重启 DSH 后可用');
  });

  it('P09 dirty 路由：先保存再测试 + data-mc="test-gate"', () => {
    const html = renderMc(mcTest({ blocked: { 'gpt-gateway': '先保存再测试：Host 还不知道这个提供方的未保存改动' } }), {
      ui: MC_DETAIL,
      snap: {
        draft: { providers: mcProviders() },
        ops: { ...EMPTY_OPS, dirty: 1, dirtySet: new Set(['gpt-gateway']) },
      },
    });

    expect(html).toContain('data-mc="test-gate"');
    expect(html).toContain('先保存再测试');
  });

  it('P10 列表卡片：✓ 2/2 可用 徽标与 data-mc-test-all', () => {
    const html = renderMc(mcTest({ results: { [mcKey('m1')]: mcOk('m1'), [mcKey('m2')]: mcOk('m2') } }), {
      snap: { draft: { providers: mcProviders(['m1', 'm2']) } },
    });

    expect(html).toContain('data-mc-badge="gpt-gateway"');
    expect(html).toContain('✓ 2/2 可用');
    expect(html).toContain('data-mc-test-all="gpt-gateway"');
  });

  it('P11 颜色扫描：新组件 HTML 无 #xxx / rgb( / --mc-', () => {
    const html = renderMc(
      mcTest({
        results: { [mcKey('m1')]: mcOk('m1'), [mcKey('m2')]: mcTransient() },
        open: mcKey('m1'),
        batches: { 'gpt-gateway': mcBatch({ done: true, stopped: true, endedAt: MC_T0 + 20000 }) },
        cost: { route: 'gpt-gateway', modelIds: MC_IDS, label: '全部模型' },
        live: '测试完成。可用 1，失败 1。',
      }),
      { ui: MC_DETAIL, snap: { draft: { providers: mcProviders() } } },
    );

    // 先确认这一页确实渲染了 r4a 的新组件，否则扫描等于空跑。
    expect(html).toContain('data-mc="test-live"');
    expect(html).toContain('data-mc-tdetail="m1"');
    expect(html).toContain('data-mc="batch"');
    expect(html).toContain('data-mc-badge="gpt-gateway"');

    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(html).not.toContain('rgb(');
    expect(html).not.toContain('--mc-');
  });
});
