/**
 * Save bar pinned to the bottom, 48px (prototype savebarHTML).
 *
 * The count and the 「N 处无法保存」 state read snap.ops / snap.errors only
 * (captain ruling 1). 预览变更 stays usable in read-only mode.
 */
import React from 'react';
import type { McSnapshot, ModelCapabilitiesStore } from '../types';
import { mcStyles as s } from '../styles';
import { Btn, errorCount } from './shared';

type ComponentProps = { snap: McSnapshot; store: ModelCapabilitiesStore };

export function SaveBar({ snap, store }: ComponentProps): JSX.Element | null {
  const { ui, ops, revision } = snap;
  const dirty = ops.dirty;
  const errs = errorCount(snap);
  let txt: string;
  let err = false;
  if (ui.readonly) txt = '只读模式，不能保存。';
  else if (ui.saving) txt = '保存中…';
  else if (ui.saved && !dirty) txt = '已保存';
  else if (errs) { txt = `${dirty} 处无法保存`; err = true; }
  else txt = dirty ? `未保存 ${dirty} 处` : '没有未保存的更改';

  const busy = ui.saving || ui.loading;
  const preview = ui.view === 'preview';
  const rev = [revision.pi, revision.ds].filter((r) => r != null).join(' / ');

  return (
    <>
      <span role="status" aria-live="polite" style={err ? s.countErr : s.count}>{txt}</span>
      {rev && <span style={s.rev}>revision {rev}</span>}
      <Btn
        aria-pressed={preview}
        disabled={busy}
        onClick={() => (preview ? store.closePreview() : store.openPreview())}
        data-mc="preview"
      >
        预览变更
      </Btn>
      <Btn disabled={busy || ui.readonly || !dirty} onClick={() => store.askDiscard()}>放弃</Btn>
      <Btn kind="primary" disabled={busy || ui.readonly || !dirty || errs > 0} onClick={() => void store.save()}>
        {ui.saving ? '保存中' : '保存'}
      </Btn>
    </>
  );
}
