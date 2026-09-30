/**
 * bulk.ts 用例清单。
 *
 * R2 增量（docs/specs/model-capabilities.r2.md 第 1.1、1.3、4、5 节）：
 * - BulkDraft 的 'inherit' 改为 'clear'，并附旧字段提示
 *   `旧字段 inputModalities 不会被「清除」清掉，请用「迁移为 input」。`；
 * - #4 两句：源没有 input 时底栏摘要和结果句都追加提示；
 * - #1 文案：空白用「填写数值，或改为「不修改」「清除」。」，非法沿用 CAP_FMT_ERR；
 * - 短语 `容量清除` / `上下文窗口清除`；
 * - #7：canonicalPersist 判断变化，`128K` 与 `128000` 视为相同，C 不增加；
 * - #8：源的任一侧 parseCap 为 null 时整次复制阻断，errs.src 用逐字文案。
 *
 * 含 B4 的两处修正：L 只统计没进入 results 的模型；scope=sel 取 selSnapshot。
 * R2-6 / R2-7 / R2-8 的逐字文案断言在 regression-r2.test.ts 里也有。
 */
import { describe, expect, it } from 'vitest';
import { bulkPhrase, bulkPlan, bulkResultMsg, bulkSummary, bulkTargets, canonicalPersist, newBulk, rawPersist } from './bulk';
import { CAP_FMT_ERR, type BulkDraft, type ProviderDraft } from './types';
import { draftModel, draftProvider, MAIN_MAP } from './test-fixtures';

const LEGACY_HINT = '旧字段 inputModalities 不会被「清除」清掉，请用「迁移为 input」。';

function gptProvider(models = 3): ProviderDraft {
  return draftProvider({
    id: 'gpt-gateway',
    models: [
      draftModel({ id: 'gpt-6-astra', name: 'Astra', contextWindow: '272000', maxTokens: '128000', input: ['text', 'image'], reasoningEfforts: { ...MAIN_MAP } }),
      draftModel({ id: 'gpt-6-sol', name: 'Sol', contextWindow: '272000', maxTokens: '128000', input: ['text', 'image'], reasoningEfforts: { ...MAIN_MAP } }),
      draftModel({ id: 'gpt-6-terra', name: 'Terra', contextWindow: '272000', maxTokens: '128000', input: ['text', 'image'], reasoningEfforts: { ...MAIN_MAP } }),
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
  it('Given inMode=clear、模型只有旧字段且没被写入 When bulkSummary Then L 加 1，并给出旧字段提示', () => {
    const p = draftProvider({ id: 'gpt-gateway', models: [draftModel({ id: 'legacy', inputModalities: ['text', 'image'] })] });
    const b = bulk({ inMode: 'clear' });
    const plan = bulkPlan(p, b);
    expect(plan.C).toBe(0);
    expect(plan.S).toBe(0);
    expect(plan.L).toBe(1);
    expect(bulkSummary(b, plan).t).toContain(LEGACY_HINT);
    expect(bulkResultMsg(b, plan)).toContain('只有旧字段');
  });

  it('Given 同一个只有旧字段的模型同时改了容量并进入 results When bulkPlan Then 不计入 L', () => {
    const p = draftProvider({
      id: 'gpt-gateway',
      models: [draftModel({ id: 'legacy', inputModalities: ['text', 'image'], contextWindow: '272000' })],
    });
    const b = bulk({ inMode: 'clear', cw: 'set', cwRaw: '128K' });
    const plan = bulkPlan(p, b);
    expect(plan.C).toBe(1);
    expect(plan.L).toBe(0);
    expect(bulkSummary(b, plan).t).not.toContain('只有旧字段');
    expect(bulkResultMsg(b, plan)).not.toContain('只有旧字段');
  });

  it('Given pi 模型有 input 且 inMode=clear When bulkPlan Then 删除 input，且不计入 L', () => {
    const p = draftProvider({ id: 'gpt-gateway', models: [draftModel({ id: 'm', input: ['text', 'image'] })] });
    const b = bulk({ inMode: 'clear' });
    const plan = bulkPlan(p, b);
    expect(plan.C).toBe(1);
    expect(plan.L).toBe(0);
    expect(plan.results[0].next).not.toHaveProperty('input');
  });

  it('Given pi 模型既没有 input 也没有旧字段、inMode=clear When bulkPlan Then 无变化也不计入 L', () => {
    const p = draftProvider({ id: 'gpt-gateway', models: [draftModel({ id: 'm' })] });
    const b = bulk({ inMode: 'clear' });
    const plan = bulkPlan(p, b);
    expect(plan.C).toBe(0);
    expect(plan.L).toBe(0);
  });

  it('Given DeepSeek 模型有 inputModalities、inMode=clear When bulkPlan Then 删除 inputModalities', () => {
    const p = draftProvider({ id: 'deepseek-official', ns: 'llm-deepseek', models: [draftModel({ id: 'm', inputModalities: ['text'] })] });
    const b = bulk({ inMode: 'clear' });
    const plan = bulkPlan(p, b);
    expect(plan.C).toBe(1);
    expect(plan.results[0].next).not.toHaveProperty('inputModalities');
  });
});

describe('bulk（#7 canonicalPersist 判断变化）', () => {
  it('Given 模型写 128K、批量设为 128000 When bulkPlan Then 视为相同，C=0', () => {
    const p = draftProvider({ id: 'gpt-gateway', models: [draftModel({ id: 'm', contextWindow: '128K' })] });
    const b = bulk({ cw: 'set', cwRaw: '128000' });
    const plan = bulkPlan(p, b);
    expect(plan.C).toBe(0);
    expect(plan.results).toEqual([]);
    expect(bulkSummary(b, plan).ok).toBe(false);
  });

  it('Given 模型写 128000、批量设为 1M When bulkPlan Then 值不同，C=1', () => {
    const p = draftProvider({ id: 'gpt-gateway', models: [draftModel({ id: 'm', contextWindow: '128000' })] });
    const plan = bulkPlan(p, bulk({ cw: 'set', cwRaw: '1M' }));
    expect(plan.C).toBe(1);
    expect(plan.results[0].next.contextWindow).toBe('1000000');
  });

  it('Given 只差 _stash When canonicalPersist Then 结果相同，差异则不同', () => {
    const a = draftModel({ id: 'm', name: 'A' });
    const b = draftModel({ id: 'm', name: 'A', _stash: { ...MAIN_MAP } });
    expect(canonicalPersist(b)).toBe(canonicalPersist(a));
    expect(canonicalPersist(draftModel({ id: 'm', name: 'B' }))).not.toBe(canonicalPersist(a));
  });

  it('Given 空白容量键 When canonicalPersist Then 省略该键', () => {
    const withBlank = draftModel({ id: 'm', contextWindow: '   ', maxTokens: '128K' });
    const without = draftModel({ id: 'm', maxTokens: '128000' });
    expect(canonicalPersist(withBlank)).toBe(canonicalPersist(without));
  });

  it('Given 非法容量键 When canonicalPersist Then 保留原文', () => {
    const bad = draftModel({ id: 'm', contextWindow: 'nope' });
    expect(canonicalPersist(bad)).toContain('nope');
  });
});

describe('bulk（从模型复制）', () => {
  it('Given 源没有 input、有旧字段 When 复制 Then 不改 ID/名称，目标只按源的 input 删掉 input，自己的旧字段原样保留', () => {
    const p = draftProvider({
      id: 'gpt-gateway',
      models: [
        draftModel({ id: 'src', name: 'Source', contextWindow: '128K', inputModalities: ['text', 'image'] }),
        draftModel({ id: 'dst', name: 'Dest', contextWindow: '64000', maxTokens: '999', input: ['text'], inputModalities: ['text'] }),
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
    // R2F-4：不复制旧字段 —— 目标保留自己的 inputModalities（['text']），不是源的 ['text','image']。
    expect(next.inputModalities).toEqual(['text']);
    expect(next).not.toHaveProperty('input');
    expect(next).not.toHaveProperty('maxTokens');
    expect(next.contextWindow).toBe('128000');

    expect(bulkPhrase(b, plan)).toBe('从 Source 复制');
  });

  it('Given 源某侧 parseCap 为 null When bulkPlan Then errs.src 用 #8 的文案且 C=0、targets 不变', () => {
    const p = draftProvider({
      id: 'gpt-gateway',
      models: [
        draftModel({ id: 'src', name: 'Source', contextWindow: 'nope' }),
        draftModel({ id: 'dst', name: 'Dest', contextWindow: '64000' }),
      ],
    });
    const b = bulk({ scope: 'sel', selSnapshot: [0, 1], copy: 'copy', src: 0 });
    const plan = bulkPlan(p, b);
    expect(plan.errs.src).toBe('源模型的容量格式不正确，不能复制。');
    expect(plan.C).toBe(0);
    expect(plan.results).toEqual([]);
    const summary = bulkSummary(b, plan);
    expect(summary.t).toBe('源模型的容量格式不正确，不能复制。');
    expect(summary.ok).toBe(false);
  });

  it('Given 源合法、目标两侧都有值 When 复制 Then 目标没有任何容量键被删', () => {
    const p = draftProvider({
      id: 'gpt-gateway',
      models: [
        draftModel({ id: 'src', name: 'Source', contextWindow: '128000', maxTokens: '64000' }),
        draftModel({ id: 'dst', name: 'Dest', contextWindow: '64000', maxTokens: '1000' }),
      ],
    });
    const b = bulk({ scope: 'sel', selSnapshot: [0, 1], copy: 'copy', src: 0 });
    const next = bulkPlan(p, b).results[0].next;
    expect(next.contextWindow).toBe('128000');
    expect(next.maxTokens).toBe('64000');
  });

  it('Given 源没有 input When 底栏摘要与结果句 Then 都追加 #4 的提示（旧字段时改为后半句）', () => {
    const p = draftProvider({
      id: 'gpt-gateway',
      models: [draftModel({ id: 'src', name: 'Source' }), draftModel({ id: 'dst', name: 'Dest' })],
    });
    const b = bulk({ scope: 'sel', selSnapshot: [0, 1], copy: 'copy', src: 0 });
    const plan = bulkPlan(p, b);
    expect(bulkSummary(b, plan).t).toContain('源没有 input，目标会清除输入。');
    expect(bulkSummary(b, plan).t).not.toContain('不复制旧字段');
  });

  it('Given 源有旧字段 When 底栏摘要 Then 第 4 条的后半句', () => {
    const p = draftProvider({
      id: 'gpt-gateway',
      models: [
        draftModel({ id: 'src', name: 'Source', inputModalities: ['text', 'image'] }),
        draftModel({ id: 'dst', name: 'Dest', input: ['text'] }),
      ],
    });
    const b = bulk({ scope: 'sel', selSnapshot: [0, 1], copy: 'copy', src: 0 });
    const plan = bulkPlan(p, b);
    expect(bulkSummary(b, plan).t).toContain('源没有 input，目标会清除输入；不复制旧字段。');
  });

  it('Given 源有 input When 底栏摘要 Then 不追加 #4 的提示', () => {
    const p = draftProvider({
      id: 'gpt-gateway',
      models: [draftModel({ id: 'src', name: 'Source', input: ['text'] }), draftModel({ id: 'dst', name: 'Dest' })],
    });
    const b = bulk({ scope: 'sel', selSnapshot: [0, 1], copy: 'copy', src: 0 });
    const plan = bulkPlan(p, b);
    expect(bulkSummary(b, plan).t).not.toContain('源没有 input');
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

  it('Given 容量「设置为」但值为空白 When bulkPlan Then #1 的文案（「清除」而非「恢复继承」）', () => {
    const p = gptProvider();
    const b = bulk({ cw: 'set', cwRaw: '   ' });
    const plan = bulkPlan(p, b);
    expect(plan.errs.cw).toBe('填写数值，或改为「不修改」「清除」。');
    expect(bulkSummary(b, plan).ok).toBe(false);
  });

  it('Given 容量「设置为」但格式非法 When bulkPlan Then 沿用 CAP_FMT_ERR', () => {
    const p = gptProvider();
    const b = bulk({ mt: 'set', mtRaw: 'nope' });
    expect(bulkPlan(p, b).errs.mt).toBe(CAP_FMT_ERR);
  });

  it('Given 复制但没选源模型 When bulkPlan Then 「先选择源模型。」且不设 err 标记', () => {
    const p = gptProvider();
    const b = bulk({ copy: 'copy', src: null });
    expect(bulkPlan(p, b).errs.src).toBe('先选择源模型。');
    const summary = bulkSummary(b, bulkPlan(p, b));
    expect(summary.t).toBe('先选择源模型。');
    expect(summary.ok).toBe(false);
    expect(summary.err).toBeUndefined();
  });

  it('Given 源档位不完整 When bulkPlan Then 仍用错误色（err=true）', () => {
    const p = draftProvider({
      id: 'gpt-gateway',
      models: [
        draftModel({ id: 'src', name: 'Source', reasoningEfforts: { nope: 'nope' } as never }),
        draftModel({ id: 'dst', name: 'Dest' }),
      ],
    });
    const b = bulk({ scope: 'sel', selSnapshot: [0, 1], copy: 'copy', src: 0 });
    const plan = bulkPlan(p, b);
    expect(plan.errs.src).toBe('源模型的思考档位不完整，不能复制。');
    expect(bulkSummary(b, plan).err).toBe(true);
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
  it('Given 输入改为文本+图片、两侧容量清除 When bulkPhrase Then 用「容量清除」', () => {
    const p = draftProvider({ id: 'gpt-gateway', models: [draftModel({ id: 'a' })] });
    const b = bulk({ inMode: 'set', inArr: ['text', 'image'], cw: 'clear', mt: 'clear' });
    const plan = bulkPlan(p, b);
    expect(bulkPhrase(b, plan)).toBe('输入改为文本和图片；容量清除');
  });

  it('Given 只清上下文窗口 When bulkPhrase Then 用「上下文窗口清除」', () => {
    const p = draftProvider({ id: 'gpt-gateway', models: [draftModel({ id: 'a', contextWindow: '128000' })] });
    const b = bulk({ cw: 'clear' });
    const plan = bulkPlan(p, b);
    expect(bulkPhrase(b, plan)).toBe('上下文窗口清除');
  });

  it('Given 只清最大输出 When bulkPhrase Then 用「最大输出清除」', () => {
    const p = draftProvider({ id: 'gpt-gateway', models: [draftModel({ id: 'a', maxTokens: '64000' })] });
    const b = bulk({ mt: 'clear' });
    const plan = bulkPlan(p, b);
    expect(bulkPhrase(b, plan)).toBe('最大输出清除');
  });

  it('Given 两侧容量设为数值 When bulkPhrase Then 拼出可读句子', () => {
    const p = draftProvider({ id: 'gpt-gateway', models: [draftModel({ id: 'a' })] });
    const b = bulk({ cw: 'set', cwRaw: '128K', mt: 'set', mtRaw: '64000' });
    const plan = bulkPlan(p, b);
    expect(bulkPhrase(b, plan)).toBe('上下文窗口设为 128K；最大输出设为 64K');
  });
});
