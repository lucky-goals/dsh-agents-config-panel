/**
 * The five confirmation dialogs (prototype dialogHTML), drawn with the repo
 * Modal (Escape, focus trap, focus return):
 * delete / discard / reload / wiz-cancel / save-wiz.
 */
import React, { useId } from 'react';
import type { McSnapshot, ModelCapabilitiesStore } from '../types';
import { Button } from '../../ui/Button';
import { Modal } from '../../ui/Modal';
import { mcStyles as s, sx } from '../styles';

type ComponentProps = { snap: McSnapshot; store: ModelCapabilitiesStore };

export function DeleteDialog({ snap, store }: ComponentProps): JSX.Element | null {
  const d = snap.ui.dialog;
  const inputId = useId();
  if (!d) return null;

  const revs = [snap.revision.pi, snap.revision.ds].filter((r) => r != null).join(' / ');
  let title = '';
  let body: React.ReactNode = null;
  let ok = '';
  let danger = true;
  let okDisabled = false;
  let cancel = '取消';

  switch (d.type) {
    case 'delete':
      title = `删除提供方 ${d.route}`;
      // Spec C: saving unsets the config first, then the stored credential.
      body = (
        <>
          <p style={s.dlgDesc}>配置键会被移除；保存时会在配置写入后再移除它的已存密钥。</p>
          <div style={s.field}>
            <label htmlFor={inputId} style={s.label}>输入 <span style={s.mono}>{d.route}</span> 确认</label>
            <input
              id={inputId}
              value={d.text}
              autoComplete="off"
              data-modal-autofocus=""
              onChange={(e) => store.setDeleteConfirm(e.target.value)}
              style={sx(s.input, s.mono)}
            />
          </div>
        </>
      );
      ok = '删除提供方';
      okDisabled = d.text !== d.route;
      break;
    case 'discard':
      title = '放弃未保存的更改？';
      body = <p style={s.dlgDesc}>{`${snap.ops.dirty} 处修改会被丢弃，恢复到 revision ${revs || '—'}。`}</p>;
      ok = '放弃更改';
      break;
    case 'reload':
      title = '重新加载配置？';
      body = <p style={s.dlgDesc}>重新加载会丢掉当前草稿，换成最新配置。</p>;
      ok = '重新加载';
      break;
    case 'wiz-cancel':
      title = '取消添加提供方？';
      body = <p style={s.dlgDesc}>已填写的内容不会保留。</p>;
      ok = '取消添加';
      cancel = '继续填写';
      break;
    case 'save-wiz':
      title = '还没添加完';
      body = <p style={s.dlgDesc}>先完成或取消添加提供方，再保存。</p>;
      cancel = '知道了';
      danger = false;
      break;
    default:
      return null;
  }

  return (
    <Modal isOpen onClose={() => store.cancelDialog()} title={title}>
      <div style={s.dlgBody}>
        {body}
        <div style={s.dlgActions}>
          <Button onClick={() => store.cancelDialog()}>{cancel}</Button>
          {ok && (
            <Button variant={danger ? 'danger' : 'primary'} disabled={okDisabled} onClick={() => store.confirmDialog()}>
              {ok}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
