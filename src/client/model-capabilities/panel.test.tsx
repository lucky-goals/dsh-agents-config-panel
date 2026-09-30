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

  it('关闭 is forwarded from the host props, and absent without them', () => {
    expect(buttonTags(renderPanel({ close: () => {} }), '关闭')).toHaveLength(1);
    expect(buttonTags(renderPanel(), '关闭')).toHaveLength(0);
  });

  it('loading announces 正在加载配置', () => {
    expect(text(renderPanel({ ui: { loading: true } }))).toContain('正在加载配置');
  });
});
