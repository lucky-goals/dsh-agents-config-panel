/**
 * validate.ts 用例清单。
 *
 * R2 增量（docs/specs/model-capabilities.r2.md 第 1.3、3、5 节）：
 * - 删除路由容量相关用例和 routeCapBad；modelCapBad 只看模型；
 * - routeErrors 只处理 pi 的空白 apiKeyEnv 和重复请求头；
 * - 重复请求头按 trim 后的非空值比较、大小写敏感，名称按首次出现顺序、去重列出（#17）；
 * - secretError 补 #16 的全文。
 *
 * R2-9 / R2-10 的逐字文案断言在 regression-r2.test.ts 里。
 */
import { describe, expect, it } from 'vitest';
import {
  allErrors,
  idWarn,
  modelCapBad,
  modelErrors,
  providerIdError,
  routeErrors,
  secretError,
  wizardErrors,
} from './validate';
import { CAP_FMT_ERR, type DraftState, type FieldErrors, type WizardDraft } from './types';
import { draftModel, draftProvider } from './test-fixtures';

function wizard(over: Partial<WizardDraft> = {}): WizardDraft {
  return {
    step: 1,
    api: '',
    id: '',
    tried2: false,
    ack: false,
    displayName: '',
    baseURL: '',
    env: '',
    envTouched: false,
    headersOpen: false,
    headers: [],
    models: [''],
    ...over,
  };
}

describe('validate.modelErrors（模型 ID）', () => {
  it('Given 模型 ID 为空或纯空白 When modelErrors Then 「填写模型 ID」', () => {
    const p = draftProvider({ id: 'gpt-gateway', models: [draftModel({ id: '' })] });
    expect(modelErrors(p, draftModel({ id: '' }), 0).id).toBe('填写模型 ID');
    expect(modelErrors(p, draftModel({ id: '   ' }), 0).id).toBe('填写模型 ID');
  });

  it('Given 模型 ID 含空格 When modelErrors Then 「ID 不能包含空格」', () => {
    const p = draftProvider({ id: 'gpt-gateway' });
    expect(modelErrors(p, draftModel({ id: 'gpt 6' }), 0).id).toBe('ID 不能包含空格');
  });

  it('Given 同一提供方里已有同名模型 When modelErrors Then 「这个提供方里已有同名模型」', () => {
    const p = draftProvider({ id: 'gpt-gateway', models: [draftModel({ id: 'dup' }), draftModel({ id: 'dup' })] });
    expect(modelErrors(p, p.models[1], 1).id).toBe('这个提供方里已有同名模型');
    expect(modelErrors(p, p.models[0], 0).id).toBeUndefined();
  });
});

describe('validate.modelErrors（思考档位）', () => {
  it('Given pi 模型的 reasoningEfforts 为空对象 When modelErrors Then 「勾选至少一档，或改为不思考。」', () => {
    const p = draftProvider({ id: 'gpt-gateway' });
    expect(modelErrors(p, draftModel({ id: 'm', reasoningEfforts: {} }), 0).efforts).toBe('勾选至少一档，或改为不思考。');
  });

  it('Given 某档的线上拼写为空串 When modelErrors Then spell_<档位> 出错', () => {
    const p = draftProvider({ id: 'gpt-gateway' });
    const m = draftModel({ id: 'm', reasoningEfforts: { low: '', high: 'high' } });
    const e = modelErrors(p, m, 0);
    expect(e.spell_low).toBe('线上拼写不能为空；与档名相同或写成 null。');
    expect(e.spell_high).toBeUndefined();
    expect(e.efforts).toBeUndefined();
  });

  it('Given reasoningEfforts 写成 false（不思考）When modelErrors Then 不报档位错误', () => {
    const p = draftProvider({ id: 'gpt-gateway' });
    expect(modelErrors(p, draftModel({ id: 'm', reasoningEfforts: false }), 0).efforts).toBeUndefined();
  });
});

describe('validate.providerIdError / idWarn', () => {
  const d: DraftState = { providers: { mine: draftProvider({ id: 'mine', api: 'openai-completions' }) } };

  it('Given 提供方 ID 为空 When providerIdError Then 「填写提供方 ID」', () => {
    expect(providerIdError('', d)).toBe('填写提供方 ID');
    expect(providerIdError('   ', d)).toBe('填写提供方 ID');
  });

  it('Given 提供方 ID 含大写或点号 When providerIdError Then 字符集提示且提到点号', () => {
    expect(providerIdError('Foo', d)).toContain('不能含点号');
    expect(providerIdError('a.', d)).toContain('不能含点号');
    expect(providerIdError('-a', d)).toContain('不能含点号');
  });

  it('Given 提供方 ID 已存在 When providerIdError Then 「已有这个提供方 ID」', () => {
    expect(providerIdError('mine', d)).toBe('已有这个提供方 ID');
  });

  it('Given 合法且不重复的 ID When providerIdError Then 空串', () => {
    expect(providerIdError('my-gateway', d)).toBe('');
  });

  it('Given idWarn 收到 A_b When 提示 Then 含「小写字母」', () => {
    expect(idWarn('A_b')).toContain('小写字母');
    expect(idWarn('a-b')).toBe('');
  });
});

describe('validate.routeErrors（只处理 apiKeyEnv 与重复请求头）', () => {
  it('Given pi 路由 apiKeyEnv 键存在但为空白 When routeErrors Then 「填写密钥环境变量名。」', () => {
    const e = routeErrors(draftProvider({ id: 'gpt-gateway', apiKeyEnv: '' }));
    expect(e.apiKeyEnv).toBe('填写密钥环境变量名。');
  });

  it('Given pi 路由没有 apiKeyEnv 键 When routeErrors Then 不报错', () => {
    const p = draftProvider({ id: 'gpt-gateway' });
    delete p.apiKeyEnv;
    expect(routeErrors(p).apiKeyEnv).toBeUndefined();
  });

  it('Given DeepSeek 路由 apiKeyEnv 空白 When routeErrors Then 不报错（只管 pi）', () => {
    expect(routeErrors(draftProvider({ id: 'deepseek-official', ns: 'llm-deepseek', apiKeyEnv: '' })).apiKeyEnv).toBeUndefined();
  });

  it('Given 请求头名 trim 后重复 When routeErrors Then 报 headers 错误', () => {
    const e = routeErrors(draftProvider({ id: 'gpt-gateway', headers: [{ k: 'X-A', v: '1' }, { k: ' X-A ', v: '2' }] }));
    expect(e.headers).toBeDefined();
    expect(e.headers).toContain('重复');
  });

  it('Given 请求头名只有大小写不同 When routeErrors Then 不报错（大小写敏感）', () => {
    const e = routeErrors(draftProvider({ id: 'gpt-gateway', headers: [{ k: 'X-A', v: '1' }, { k: 'x-a', v: '2' }] }));
    expect(e.headers).toBeUndefined();
  });

  it('Given 请求头名是空白 When routeErrors Then 不参与比较也不报错', () => {
    const e = routeErrors(draftProvider({ id: 'gpt-gateway', headers: [{ k: '  ', v: '1' }, { k: '', v: '2' }] }));
    expect(e.headers).toBeUndefined();
  });

  it('Given 请求头名重复且提供方容量非法 When routeErrors Then 不再有容量相关字段', () => {
    // 提供方级容量键已从 ProviderDraft 删除，这里用断言把「只要还传进来也不该报」钉住。
    const p = draftProvider({
      id: 'gpt-gateway',
      headers: [{ k: 'A', v: '1' }, { k: 'A', v: '2' }],
      defaultContextWindow: 'nope',
    } as unknown as Parameters<typeof draftProvider>[0]);
    const e = routeErrors(p);
    expect(e.headers).toBeDefined();
    expect((e as Record<string, unknown>).defaultContextWindow).toBeUndefined();
    expect((e as Record<string, unknown>).maxTokens).toBeUndefined();
  });
});

describe('validate.wizardErrors', () => {
  it('Given 向导里请求头名重复 When wizardErrors Then 报 headers 错误', () => {
    const e = wizardErrors(wizard({ headers: [{ k: 'A', v: '1' }, { k: 'A', v: '2' }] }), { providers: {} });
    expect(e.headers).toBeDefined();
    expect(e.headers).toContain('重复');
  });

  it('Given 向导里请求头只有大小写不同 When wizardErrors Then 不报错', () => {
    const e = wizardErrors(wizard({ headers: [{ k: 'A', v: '1' }, { k: 'a', v: '2' }] }), { providers: {} });
    expect(e.headers).toBeUndefined();
  });

  it('Given 向导的 ID 与模型列表 When wizardErrors Then 两者都不为 undefined 键', () => {
    const e = wizardErrors(wizard({ id: 'fresh', models: ['m1'] }), { providers: {} });
    expect(e.id).toBeUndefined();
    expect(e.models).toBeUndefined();
    expect(e.headers).toBeUndefined();
  });
});

describe('validate.secretError（#16 的全文）', () => {
  const R2 = '密钥只能包含 ASCII 非空白字符，不能写成环境变量赋值，也不能首尾用同一种引号包住。';

  it('Given 空串 When secretError Then 空串（表示不改）', () => {
    expect(secretError('')).toBe('');
  });

  it('Given 正常密钥 When secretError Then 空串', () => {
    expect(secretError('sk-abc123')).toBe('');
    expect(secretError('A.b_c-1')).toBe('');
    expect(secretError('sk-abc=')).toBe('');
    expect(secretError('a=b')).toBe('');
    expect(secretError("sk'x")).toBe('');
  });

  it('Given 非法密钥 When secretError Then 逐字返回 #16 的文案', () => {
    expect(secretError('A=b')).toBe(R2);
    expect(secretError('FOO=bar')).toBe(R2);
    expect(secretError('"x"')).toBe(R2);
    expect(secretError("'x'")).toBe(R2);
    expect(secretError('has space')).toBe(R2);
    expect(secretError('中文密钥')).toBe(R2);
  });
});

describe('validate.allErrors / modelCapBad', () => {
  it('Given 只有部分提供方出错 When allErrors Then 只收录出错的路由', () => {
    const bad = draftProvider({ id: 'bad', models: [draftModel({ id: 'm', contextWindow: 'nope' })] });
    const ok = draftProvider({ id: 'ok', models: [draftModel({ id: 'm' })] });
    const all = allErrors({ providers: { bad, ok } });
    expect(Object.keys(all)).toEqual(['bad']);
    expect(all.bad.route).toEqual({});
    expect(all.bad.models[0].contextWindow).toBe(CAP_FMT_ERR);
  });

  it('Given 模型容量非法或越界 When modelCapBad Then true（只看模型，不看提供方）', () => {
    expect(modelCapBad(draftModel({ id: 'm', maxTokens: 'nope' }))).toBe(true);
    expect(modelCapBad(draftModel({ id: 'm', contextWindow: '1000', maxTokens: '40000' }))).toBe(true);
    expect(modelCapBad(draftModel({ id: 'm' }))).toBe(false);
    expect(modelCapBad(draftModel({ id: 'm', contextWindow: '128000', maxTokens: '128000' }))).toBe(false);
  });
});

/* ==========================================================================
 * R4b 流空闲超时（docs/specs/r4b-stream-idle-timeout.md 第 3 节 validate 段）：V1–V2。
 *
 * 只追加用例，不动 validate.ts。timeoutText 与 WizardDraft.timeout 现在还不存在，
 * 用下面的小工具绕过类型，保证这些用例失败在断言上。
 * ========================================================================== */

const TIMEOUT_KEY = 'streamIdleTimeoutMs';
const TIMEOUT_ERR_POSITIVE = '请输入大于 0 的分钟数';
const TIMEOUT_ERR_TOO_LARGE = '不能超过 35791 分钟';

/** 在路由草稿上补一个 timeoutText（ProviderDraft 还没有这个字段）。 */
function routeWithText(text: string | undefined): ReturnType<typeof draftProvider> {
  const p = draftProvider({ id: 'gpt-gateway' });
  return { ...p, ...({ timeoutText: text } as unknown as object) } as ReturnType<typeof draftProvider>;
}

/** 在路由草稿上补一个加载来的显式毫秒值（没有 timeoutText）。 */
function routeWithMs(ms: number): ReturnType<typeof draftProvider> {
  const p = draftProvider({ id: 'gpt-gateway' });
  return { ...p, ...({ [TIMEOUT_KEY]: ms } as unknown as object) } as ReturnType<typeof draftProvider>;
}

function routeError(e: FieldErrors, key: string): string | undefined {
  return (e as Record<string, string | undefined>)[key];
}

/** 向导草稿加一个 timeoutText（WizardDraft 还没有这个字段）。 */
function wizardWithTimeout(timeoutText: string): WizardDraft {
  return { ...wizard(), ...({ timeoutText } as unknown as Partial<WizardDraft>) };
}

describe('R4b V1 routeErrors：只校验正在输入的原文', () => {
  it('V1 pi 与 DS 的 text=0 → e.streamIdleTimeoutMs 是逐字文案', () => {
    expect(routeError(routeErrors(routeWithText('0')), TIMEOUT_KEY)).toBe(TIMEOUT_ERR_POSITIVE);

    const ds = draftProvider({ id: 'deepseek-official', ns: 'llm-deepseek' });
    const dsWithText = { ...ds, ...({ timeoutText: '0' } as unknown as object) } as ReturnType<typeof draftProvider>;
    expect(routeError(routeErrors(dsWithText), TIMEOUT_KEY)).toBe(TIMEOUT_ERR_POSITIVE);
  });

  it('V1 text=30 或 undefined → 没有该键；加载来的 500 没有 text → 不报错', () => {
    expect(routeError(routeErrors(routeWithText('30')), TIMEOUT_KEY)).toBeUndefined();
    expect(routeError(routeErrors(draftProvider({ id: 'gpt-gateway' })), TIMEOUT_KEY)).toBeUndefined();

    // 加载来的值即使 < 1000，只要没被编辑就不报错
    const loaded = routeWithMs(500);
    expect(routeError(routeErrors(loaded), TIMEOUT_KEY)).toBeUndefined();
    expect((loaded as unknown as Record<string, unknown>).timeoutText).toBeUndefined();
    // 但编辑过的非法值会报错
    expect(routeError(routeErrors(routeWithText('0.01')), TIMEOUT_KEY)).toBe('不能少于 1 秒（0.0167 分钟）');
  });
});

describe('R4b V2 wizardErrors：向导第 2 步的超时错误', () => {
  it('V2 timeoutText=35792 → timeout 是逐字文案；空串与合法值 → 没有该键', () => {
    const tooLarge = wizardErrors(wizardWithTimeout('35792'), { providers: {} }) as { timeout?: string };
    expect(tooLarge.timeout).toBe(TIMEOUT_ERR_TOO_LARGE);

    const empty = wizardErrors(wizardWithTimeout(''), { providers: {} }) as { timeout?: string };
    expect(empty.timeout).toBeUndefined();

    const ok = wizardErrors(wizardWithTimeout('30'), { providers: {} }) as { timeout?: string };
    expect(ok.timeout).toBeUndefined();

    const bad = wizardErrors(wizardWithTimeout('0'), { providers: {} }) as { timeout?: string };
    expect(bad.timeout).toBe(TIMEOUT_ERR_POSITIVE);
  });
});
