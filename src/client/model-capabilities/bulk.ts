import { capBlocks, modelCap, parseCap } from './capacity';
import { effortSummary } from './efforts';
import { ALL_EFFORTS, CAP_FMT_ERR, MAIN_EFFORTS, type BulkDraft, type BulkPlan, type ModelDraft, type ProviderDraft } from './types';

const BULK_CAP_EMPTY = '填写数值，或改为「不修改」「清除」。';
const BULK_SKIP = '最大输出会大于上下文窗口。';
const LEGACY_HINT = '旧字段 inputModalities 不会被「清除」清掉，请用「迁移为 input」。';
const SOURCE_NO_INPUT = '源没有 input，目标会清除输入。';
const SOURCE_NO_INPUT_LEGACY = '源没有 input，目标会清除输入；不复制旧字段。';
const clone = <T>(value: T): T => structuredClone(value);
const isPi = (p: ProviderDraft): boolean => p.ns === 'llm-pi-ai';
const sourceNoInput = (model: ModelDraft | null): boolean => model !== null && model.input === undefined;
const sourceHasLegacyInput = (model: ModelDraft | null): boolean => model !== null && model.input === undefined && model.inputModalities !== undefined;
const sourceInputNotice = (model: ModelDraft | null): string => sourceHasLegacyInput(model) ? SOURCE_NO_INPUT_LEGACY : sourceNoInput(model) ? SOURCE_NO_INPUT : '';

export function newBulk(route: string, selected: readonly number[]): BulkDraft {
  const selSnapshot = [...selected].sort((a, b) => a - b);
  return {
    route,
    scope: selSnapshot.length ? 'sel' : 'all',
    selSnapshot,
    inMode: 'none',
    inArr: ['text'],
    th: 'none',
    thSel: [],
    cw: 'none',
    cwRaw: '',
    mt: 'none',
    mtRaw: '',
    copy: 'none',
    src: null,
  };
}

export function bulkTargets(p: ProviderDraft, b: BulkDraft): number[] {
  if (b.scope === 'sel') return [...new Set(b.selSnapshot)].filter((i) => i >= 0 && i < p.models.length).sort((a, z) => a - z);
  return p.models.map((_, i) => i);
}

function capSet(m: ModelDraft, key: 'contextWindow' | 'maxTokens', value: number | undefined): void {
  if (value === undefined) delete m[key];
  else m[key] = String(value);
}

export function rawPersist(m: ModelDraft): string {
  const copy = clone(m) as ModelDraft & { _stash?: unknown };
  delete copy._stash;
  return JSON.stringify(copy);
}

export function canonicalPersist(m: ModelDraft): string {
  const copy = clone(m) as ModelDraft & { _stash?: unknown };
  delete copy._stash;
  for (const key of ['contextWindow', 'maxTokens'] as const) {
    if (!Object.prototype.hasOwnProperty.call(copy, key)) continue;
    const raw = copy[key];
    const parsed = parseCap(raw);
    if (parsed === undefined) delete copy[key];
    else if (typeof parsed === 'number') copy[key] = String(parsed);
  }
  return JSON.stringify(copy);
}

export function bulkPlan(p: ProviderDraft, b: BulkDraft): BulkPlan {
  const pi = isPi(p);
  const copy = pi && b.copy === 'copy';
  const plan: BulkPlan = {
    pi,
    copy,
    touched: copy || b.inMode !== 'none' || (pi && b.th !== 'none') || b.cw !== 'none' || b.mt !== 'none',
    errs: {},
    err: '',
    targets: [],
    results: [],
    C: 0,
    S: 0,
    L: 0,
    srcM: null,
    cw: null,
    mt: null,
  };

  if (copy) {
    if (b.src == null || !p.models[b.src]) plan.errs.src = '先选择源模型。';
    else {
      plan.srcM = p.models[b.src];
      const sourceCaps = modelCap(plan.srcM);
      if (sourceCaps.cw.parsed === null || sourceCaps.mt.parsed === null) {
        plan.errs.src = '源模型的容量格式不正确，不能复制。';
      }
      const efforts = plan.srcM.reasoningEfforts;
      if (!plan.errs.src && efforts && typeof efforts === 'object' && !ALL_EFFORTS.some((level) => Object.prototype.hasOwnProperty.call(efforts, level))) {
        plan.errs.src = '源模型的思考档位不完整，不能复制。';
      }
    }
  } else {
    if (pi && b.th === 'set' && !b.thSel.length) plan.errs.th = '勾选至少一档，或改为不思考。';
    for (const [field, raw] of [['cw', b.cwRaw], ['mt', b.mtRaw]] as const) {
      if (b[field] !== 'set') continue;
      const parsed = parseCap(raw);
      if (parsed === undefined) plan.errs[field] = BULK_CAP_EMPTY;
      else if (parsed === null) plan.errs[field] = CAP_FMT_ERR;
      else plan[field] = parsed;
    }
  }
  plan.err = plan.errs.src || plan.errs.th || plan.errs.cw || plan.errs.mt || '';
  let targets = bulkTargets(p, b);
  if (copy && b.src != null) targets = targets.filter((i) => i !== b.src);
  plan.targets = targets;
  if (!plan.touched || plan.err) return plan;

  const capTouched = copy || b.cw !== 'none' || b.mt !== 'none';
  for (const i of targets) {
    const model = p.models[i];
    const next = clone(model);
    if (copy) {
      const source = plan.srcM!;
      if (source.input !== undefined) next.input = source.input.slice();
      else delete next.input;
      if (source.reasoningEfforts === undefined) delete next.reasoningEfforts;
      else next.reasoningEfforts = clone(source.reasoningEfforts);
      delete next._stash;
      const sourceCaps = modelCap(source);
      capSet(next, 'contextWindow', sourceCaps.cw.explicit && typeof sourceCaps.cw.parsed === 'number' ? sourceCaps.cw.parsed : undefined);
      capSet(next, 'maxTokens', sourceCaps.mt.explicit && typeof sourceCaps.mt.parsed === 'number' ? sourceCaps.mt.parsed : undefined);
    } else {
      if (b.inMode === 'set') {
        if (pi) next.input = b.inArr.slice();
        else next.inputModalities = b.inArr.slice();
      } else if (b.inMode === 'clear') {
        if (pi) delete next.input;
        else delete next.inputModalities;
      }
      if (pi && b.th === 'set') {
        const selected: Record<string, string> = {};
        for (const level of ALL_EFFORTS) if (b.thSel.includes(level)) selected[level] = level;
        next.reasoningEfforts = selected;
        delete next._stash;
      } else if (pi && b.th === 'off') {
        if (next.reasoningEfforts && typeof next.reasoningEfforts === 'object') next._stash = clone(next.reasoningEfforts);
        next.reasoningEfforts = false;
      }
      if (b.cw === 'set') capSet(next, 'contextWindow', plan.cw!);
      else if (b.cw === 'clear') delete next.contextWindow;
      if (b.mt === 'set') capSet(next, 'maxTokens', plan.mt!);
      else if (b.mt === 'clear') delete next.maxTokens;
    }

    if (capTouched && capBlocks(modelCap(next))) {
      plan.S += 1;
      continue;
    }
    if (canonicalPersist(next) === canonicalPersist(model)) {
      if (!copy && b.inMode === 'clear' && !model.input && model.inputModalities) plan.L += 1;
      continue;
    }
    plan.results.push({ i, next });
    plan.C += 1;
  }
  return plan;
}

export function bulkSummary(b: BulkDraft, plan: BulkPlan): { t: string; ok: boolean; err?: boolean } {
  if (!plan.touched) return { t: '还没有要修改的项目。', ok: false };
  const sourceError = plan.errs.src;
  if (sourceError) {
    return sourceError === '先选择源模型。'
      ? { t: sourceError, ok: false }
      : { t: sourceError, ok: false, err: true };
  }
  if (plan.err) return { t: plan.err, ok: false, err: true };
  let text: string;
  if (!plan.targets.length) text = '没有可修改的模型。';
  else if (plan.C && !plan.S) text = `将修改 ${plan.C} 个模型。`;
  else if (plan.C) text = `将修改 ${plan.C} 个模型。另有 ${plan.S} 个会跳过：${BULK_SKIP}`;
  else if (plan.S) text = `没有需要修改的模型。${plan.S} 个模型未改：${BULK_SKIP}`;
  else text = '没有需要修改的模型。';
  if (plan.C && plan.L) text += `另有 ${plan.L} 个模型只有旧字段，不会改动。`;
  if (!plan.copy && b.inMode === 'clear' && plan.L) text += LEGACY_HINT;
  if (plan.copy) {
    const notice = sourceInputNotice(plan.srcM);
    if (notice) text += notice;
  }
  return { t: text, ok: plan.C > 0 };
}

function capName(value: number | null): string {
  if (value == null) return '';
  if (value % 1_000_000 === 0) return `${value / 1_000_000}M`;
  if (value % 1000 === 0) return `${value / 1000}K`;
  return String(value);
}

export function bulkPhrase(b: BulkDraft, plan: BulkPlan): string {
  if (plan.copy) return `从 ${plan.srcM?.name || plan.srcM?.id || '未命名模型'} 复制`;
  const fields: string[] = [];
  if (b.inMode === 'set') fields.push(b.inArr.length === 2 ? '输入改为文本和图片' : b.inArr[0] === 'image' ? '输入改为仅图片' : '输入改为仅文本');
  else if (b.inMode === 'clear') fields.push('输入清除');
  if (plan.pi && b.th === 'set') {
    const levels = ALL_EFFORTS.filter((level) => b.thSel.includes(level));
    fields.push(levels.length === MAIN_EFFORTS.length && MAIN_EFFORTS.every((level) => levels.includes(level)) ? '开启 low、medium、high、xhigh、max' : `思考档位改为 ${effortSummary(Object.fromEntries(levels.map((level) => [level, level])))}`);
  } else if (plan.pi && b.th === 'off') fields.push('改为不思考');
  if (b.cw === 'clear' && b.mt === 'clear') fields.push('容量清除');
  else {
    if (b.cw === 'set') fields.push(`上下文窗口设为 ${capName(plan.cw)}`);
    else if (b.cw === 'clear') fields.push('上下文窗口清除');
    if (b.mt === 'set') fields.push(`最大输出设为 ${capName(plan.mt)}`);
    else if (b.mt === 'clear') fields.push('最大输出清除');
  }
  return fields.join('；');
}

export function bulkResultMsg(b: BulkDraft, plan: BulkPlan): string {
  let message = `已修改 ${plan.C} 个模型：${bulkPhrase(b, plan)}。`;
  if (plan.S) message += `${plan.S} 个模型未改：${BULK_SKIP}`;
  if (!plan.copy && b.inMode === 'clear' && plan.L) message += `${plan.L} 个模型只有旧字段，未改动。${LEGACY_HINT}`;
  if (plan.copy) {
    const notice = sourceInputNotice(plan.srcM);
    if (notice) message += notice;
  }
  return message;
}
