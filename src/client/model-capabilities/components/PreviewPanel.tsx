/**
 * 预览变更 (prototype viewPreview). The body is previewText(ops, revision)
 * verbatim in a monospace <pre> (captain ruling 6): real ops per namespace,
 * YAML flow paths, credential lines without values.
 */
import React from 'react';
import type { McSnapshot, ModelCapabilitiesStore } from '../types';
import { previewText } from '../ops';
import { mcStyles as s } from '../styles';
import { Banner, Btn } from './shared';

type ComponentProps = { snap: McSnapshot; store: ModelCapabilitiesStore };

export function PreviewPanel({ snap, store }: ComponentProps): JSX.Element | null {
  const { ops, errors, revision } = snap;
  const has = (o: object | undefined) => !!o && Object.values(o).some(Boolean);
  const routes = Object.values(errors);
  const bad = routes.some((x) => has(x.route) || (x.models ?? []).some(has));
  const empty = !ops.pi.length && !ops.ds.length && !ops.cred.length;
  const revs = [
    revision.pi != null ? `llm-pi-ai ${revision.pi}` : '',
    revision.ds != null ? `llm-deepseek ${revision.ds}` : '',
  ].filter(Boolean).join('、');

  return (
    <>
      <div><Btn kind="link" onClick={() => store.closePreview()} data-mc="close-preview">← 返回</Btn></div>
      <div>
        <h2 style={s.h1}>预览变更</h2>
        <p style={s.desc}>按 namespace 列出这次保存会写入的操作{revs ? `，基于 revision ${revs}` : ''}。</p>
      </div>
      {bad && (
        <Banner tone="error">
          有字段未通过校验。空的思考档位、非法容量和未通过校验的提供方字段不会写入下面的预览；其余错误（如模型 ID）仍按草稿显示。保存已禁用。
        </Banner>
      )}
      {empty
        ? <p style={s.desc}>{ops.dirty && bad ? `有 ${ops.dirty} 处修改未通过校验，暂不能写入。` : '没有未保存的更改。'}</p>
        : <pre style={s.diff}>{previewText(ops, revision)}</pre>}
    </>
  );
}
