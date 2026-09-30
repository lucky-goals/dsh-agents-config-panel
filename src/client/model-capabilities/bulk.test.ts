/**
 * bulk.ts 用例清单（docs/specs/model-capabilities.tests.md）。
 * 含 B4 的两处修正：L 只统计没进入 results 的模型；scope=sel 取 selSnapshot。
 * W1a：现在应为红，失败原因是桩抛 `not implemented`。
 */
import { describe, expect, it } from 'vitest';
import { bulkPhrase, bulkPlan, bulkResultMsg, bulkSummary, bulkTargets, newBulk, rawPersist } from './bulk';
import { CAP_FMT_ERR, type BulkDraft, type ProviderDraft } from './types';
import { draftModel, draftProvider, MAIN_MAP } from './test-fixtures';

function gptProvider(models = 3): ProviderDraft {
  return draftProvider({
    id: 'gpt-gateway',
    models: [
      draftModel({ id: 'gpt-6-astra', name: 'Astra', contextWindow: '272000', maxTokens: '128000', inputModalities: ['text', 'image'], reasoningEfforts: { ...MAIN_MAP } }),
      draftModel({ id: 'gpt-6-sol', name: 'Sol', contextWindow: '272000', maxTokens: '128000', inputModalities: ['text', 'image'], reasoningEfforts: { ...MAIN_MAP } }),
      draftModel({ id: 'gpt-6-terra', name: 'Terra', contextWindow: '272000', maxTokens: '128000', inputModalities: ['text', 'image'], reasoningEfforts: { ...MAIN_MAP } }),
    ].slice(0, models),
  });
}

function bulk(over: Partial<BulkDraft> = {}): BulkDraft {
  return { ...newBulk('gpt-gateway', []), ...over };
}

describe('bulk.newBulk / bulkTargets', () => {
  it('Given 打开批量层时已勾选 0、2 When newBulk Then scope=sel 且 selSnapshot=[0,2]', () => {
    const b = newBulk('gpt-gateway', [0, 2]);
    expect(b.route).toBe('gpt-gateway');
    expect(b.scope).toBe('sel');
    expect(b.selSnapshot).toEqual([0, 2]);
    expect(b.inMode).toBe('none');
    expect(b.th).toBe('none');
    expect(b.cw).toBe('none');
    expect(b.mt).toBe('none');
    expect(b.copy).toBe('none');
    expect(b.src).toBeNull();
  });

  it('Given 没有勾选 When newBulk Then scope=all 且 selSnapshot 为空', () => {
    const b = newBulk('gpt-gateway', []);
    expect(b.scope).toBe('all');
    expect(b.selSnapshot).toEqual([]);
  });

  it('Given scope=sel When bulkTargets Then 取快照下标，越界下标被过滤且升序', () => {
    const p = gptProvider();
    expect(bulkTargets(p, { ...newBulk('gpt-gateway', [2, 0, 9]), scope: 'sel' })).toEqual([0, 2]);
    expect(bulkTargets(p, newBulk('gpt-gateway', []))).toEqual([0, 1, 2]);
  });
});

describe('bulk.bulkSummary', () => {
  it('Given 没有改动任何项 When bulkSummary Then 「还没有要修改的项目。」且 ok=false', () => {
    const p = gptProvider();
    const b = bulk();
    const summary = bulkSummary(b, bulkPlan(p, b));
    expect(summary.t).toBe('还没有要修改的项目。');
    expect(summary.ok).toBe(false);
  });

  it('Given 目标 2 个模型、设为文本+图片 When bulkSummary Then 「将修改 2 个模型。」', () => {
    const p = draftProvider({ id: 'gpt-gateway', models: [draftModel({ id: 'a' }), draftModel({ id: 'b' })] });
    const b = bulk({ inMode: 'set', inArr: ['text', 'image'] });
    const plan = bulkPlan(p, b);
    expect(plan.C).toBe(2);
    expect(plan.S).toBe(0);
    const summary = bulkSummary(b, plan);
    expect(summary.t).toBe('将修改 2 个模型。');
    expect(summary.ok).toBe(true);
  });

  it('Given 某模型显式最大输出大于窗口 When bulkSummary Then 计入 S 且文案含「最大输出会大于上下文窗口。」', () => {
    const p = draftProvider({
      id: 'gpt-gateway',
      models: [draftModel({ id: 'small', contextWindow: '1000' }), draftModel({ id: 'big' })],
    });
    const b = bulk({ mt: 'set', mtRaw: '40000' });
    const plan = bulkPlan(p, b);
    expect(plan.S).toBe(1);
    expect(plan.C).toBe(1);
    const summary = bulkSummary(b, plan);
    expect(summary.t).toContain('最大输出会大于上下文窗口。');
    expect(summary.t).toContain('另有 1 个会跳过');
  });
});

describe('bulk（B4 修正 1：L 只统计没进入 results 的模型）', () => {
  it('Given inMode=inherit、模型只有旧字段且没被写入 When bulkSummary Then L 加 1，结果句含「只有旧字段」', () => {
    const p = draftProvider({ id: 'gpt-gateway', models: [draftModel({ id: 'legacy', inputModalities: ['text', 'image'] })] });
    const b = bulk({ inMode: 'inherit' });
    const plan = bulkPlan(p, b);
    expect(plan.C).toBe(0);
    expect(plan.S).toBe(0);
    expect(plan.L).toBe(1);
    expect(bulkSummary(b, plan).t).toContain('旧字段 inputModalities 不会被「恢复继承」清掉，请用「迁移为 input」。');
    expect(bulkResultMsg(b, plan)).toContain('只有旧字段');
  });

  it('Given 同一个只有旧字段的模型同时改了容量并进入 results When bulkPlan Then 不计入 L', () => {
    const p = draftProvider({
      id: 'gpt-gateway',
      models: [draftModel({ id: 'legacy', inputModalities: ['text', 'image'], contextWindow: '272000' })],
    });
    const b = bulk({ inMode: 'inherit', cw: 'set', cwRaw: '128K' });
    const plan = bulkPlan(p, b);
    expect(plan.C).toBe(1);
    expect(plan.L).toBe(0);
    expect(bulkSummary(b, plan).t).not.toContain('只有旧字段');
    expect(bulkResultMsg(b, plan)).not.toContain('只有旧字段');
  });
});

describe('bulk（从模型复制）', () => {
  it('Given 源模型没有 input、有旧字段 When 复制 Then 不改 ID/名称/inputModalities，源继承的键从目标删掉', () => {
    const p = draftProvider({
      id: 'gpt-gateway',
      models: [
        draftModel({ id: 'src', name: 'Source', contextWindow: '128000', inputModalities: ['text', 'image'] }),
        draftModel({ id: 'dst', name: 'Dest', contextWindow: '64000', maxTokens: '999', input: ['text'], inputModalities: ['text', 'image'] }),
      ],
    });
    const b = bulk({ scope: 'sel', selSnapshot: [0, 1], copy: 'copy', src: 0 });
    const plan = bulkPlan(p, b);

    expect(plan.copy).toBe(true);
    expect(plan.targets).toEqual([1]);
    expect(plan.C).toBe(1);
    const next = plan.results[0].next;
    expect(next.id).toBe('dst');
    expect(next.name).toBe('Dest');
    expect(next.inputModalities).toEqual(['text', 'image']);
    expect(next).not.toHaveProperty('input');
    expect(next).not.toHaveProperty('maxTokens');
    expect(next.contextWindow).toBe('128000');

    const msg = bulkResultMsg(b, plan);
    expect(msg).toContain('源没有 input，目标改为继承');
    expect(msg).toContain('未复制旧字段');
    expect(bulkPhrase(b, plan)).toBe('从 Source 复制');
  });
});

describe('bulk 校验', () => {
  it('Given th=set 且 thSel 为空 When bulkPlan Then 「勾选至少一档，或改为不思考。」', () => {
    const p = gptProvider();
    const b = bulk({ th: 'set', thSel: [] });
    const plan = bulkPlan(p, b);
    expect(plan.errs.th).toBe('勾选至少一档，或改为不思考。');
    const summary = bulkSummary(b, plan);
    expect(summary.t).toBe('勾选至少一档，或改为不思考。');
    expect(summary.ok).toBe(false);
    expect(summary.err).toBe(true);
  });

  it('Given 容量「设置为」但值为空白 When bulkPlan Then 「填写数值，或改为「不修改」「恢复继承」。」', () => {
    const p = gptProvider();
    const b = bulk({ cw: 'set', cwRaw: '   ' });
    const plan = bulkPlan(p, b);
    expect(plan.errs.cw).toBe('填写数值，或改为「不修改」「恢复继承」。');
    expect(bulkSummary(b, plan).ok).toBe(false);
  });

  it('Given 容量「设置为」但格式非法 When bulkPlan Then 沿用 CAP_FMT_ERR', () => {
    const p = gptProvider();
    const b = bulk({ mt: 'set', mtRaw: 'nope' });
    expect(bulkPlan(p, b).errs.mt).toBe(CAP_FMT_ERR);
  });

  it('Given 复制但没选源模型 When bulkPlan Then 「先选择源模型。」', () => {
    const p = gptProvider();
    const b = bulk({ copy: 'copy', src: null });
    expect(bulkPlan(p, b).errs.src).toBe('先选择源模型。');
  });
});

describe('bulk.rawPersist', () => {
  it('Given 只有 _stash 不同 When rawPersist Then 结果相同', () => {
    const a = draftModel({ id: 'm', name: 'A' });
    const b = draftModel({ id: 'm', name: 'A', _stash: { ...MAIN_MAP } });
    expect(rawPersist(b)).toBe(rawPersist(a));
    expect(rawPersist(draftModel({ id: 'm', name: 'B' }))).not.toBe(rawPersist(a));
  });
});

describe('bulk.bulkPhrase', () => {
  it('Given 输入改为文本+图片、容量恢复继承 When bulkPhrase Then 拼出可读句子', () => {
    const p = draftProvider({ id: 'gpt-gateway', models: [draftModel({ id: 'a' })] });
    const b = bulk({ inMode: 'set', inArr: ['text', 'image'], cw: 'inherit', mt: 'inherit' });
    const plan = bulkPlan(p, b);
    expect(bulkPhrase(b, plan)).toBe('输入改为文本和图片；容量恢复继承');
  });
});
