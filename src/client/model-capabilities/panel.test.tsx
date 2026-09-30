/**
 * SSR render tests for the 模型能力 settings.section (react-dom/server, node).
 *
 * The panel is controlled: it renders one fixed McSnapshot from a fake store and
 * only calls store methods, so renderToString pins the copy and the structure
 * without jsdom. Fixtures are inline (nothing reads ~/.dsh) and the snapshot
 * never carries a plaintext secret, by contract (spec B1).
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
 * an explicit input/efforts and one that still has the legacy inputModalities;
 * cc-gateway has no credentials; the official provider has thinking switched off.
 */
function draftProviders(): Record<string, ProviderDraft> {
  return {
    'gpt-gateway': provider('gpt-gateway', {
      displayName: 'GPT Gateway',
      defaultInput: ['text', 'image'],
      reasoning: 'medium',
      defaultContextWindow: '272000',
      defaultMaxTokens: '32768',
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
    // One 已配置 (gpt-gateway) against two cards without credentials.
    expect(html.match(/已配置/g)).toHaveLength(1);
    expect(html.match(/凭证缺失/g)).toHaveLength(2);
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
});

/* ================= 详情 ================= */

describe('提供方详情（SSR）', () => {
  const detail = (route: string): Partial<McUi> => ({ view: 'detail', route });

  it('pi detail: 提供方默认值, 批量设置, the four columns and 删除提供方', () => {
    const html = text(renderPanel({ ui: detail('gpt-gateway') }));
    expect(html).toContain('提供方默认值');
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

  it('DeepSeek detail: 官方提供方由「模型」页接入, no 删除提供方, and the 思考 hint', () => {
    const off = text(renderPanel({ ui: detail(DS_ROUTE_ID) }));
    expect(off).toContain('官方提供方由「模型」页接入');
    expect(off).not.toContain('删除提供方');
    expect(off).toContain('关闭思考时只能是 off。');

    const on = text(renderPanel({
      ui: detail(DS_ROUTE_ID),
      snap: snapWithProvider(DS_ROUTE_ID, { thinking: 'enabled', reasoningEffort: 'high' }),
    }));
    expect(on).not.toContain('关闭思考时只能是 off。');
    expect(on).toContain('四档单选，所有模型共用。');
  });
});

/* ================= 图层 ================= */

describe('图层（SSR）', () => {
  const editUi = (idx: number): Partial<McUi> => ({
    view: 'detail',
    route: 'gpt-gateway',
    edit: { kind: 'model', route: 'gpt-gateway', idx },
  });

  it('模型编辑层: 线上拼写 per selected level, 恢复继承 for an explicit input', () => {
    const html = text(renderPanel({ ui: editUi(0) }));
    expect(html).toContain('线上拼写');
    expect(html).toMatch(/aria-label="low 的线上拼写"/);
    expect(html).toMatch(/aria-label="high 的线上拼写"/);
    expect(html).toContain('恢复继承');
    expect(html).toContain('gpt-6-luna');
  });

  it('模型编辑层: a model without an explicit input offers 单独设置 and names the old field', () => {
    const html = text(renderPanel({ ui: editUi(1) }));
    expect(html).toContain('单独设置');
    expect(html).toContain('旧字段 inputModalities: [text]');
  });

  it('批量层: 批量设置 with the only-what-you-touched note', () => {
    const bulk: BulkDraft = {
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
    };
    const html = text(renderPanel({ ui: { view: 'detail', route: 'gpt-gateway', bulk } }));
    expect(html).toContain('批量设置');
    expect(html).toContain('只改你动过的项。未动的项保持每个模型现在的值。');
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
