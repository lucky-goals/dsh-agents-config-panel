/**
 * Import preview (R3 1.9): one row per file entry with its badge and reason, a
 * checkbox for checkable entries (导入 for new, 覆盖 for conflict), the counts
 * and 取消 / 确认导入（n）. Drawn with the repo Modal; the store owns every
 * state change (setImportChecked / confirmImport / cancelImport).
 */
import React from 'react';
import type { ImportItem, ImportItemKind } from '../io';
import type { McSnapshot, ModelCapabilitiesStore } from '../types';
import { Modal } from '../../ui/Modal';
import { mcStyles as s, sx } from '../styles';
import { Btn, Hint, Tag } from './shared';

type ComponentProps = { snap: McSnapshot; store: ModelCapabilitiesStore };

export const IMPORT_NOTE =
  '已存在的提供方默认不覆盖。勾选「覆盖」后，自定义提供方只替换模型、显示名和 API，保留本机的 baseURL、密钥环境变量名和请求头。DeepSeek 只合并思考设置和模型表。';

const BADGE: Record<ImportItemKind, string> = { new: '新增', conflict: '覆盖', invalid: '无效', skip: '跳过' };

/** 新增 = checked new, 覆盖 = checked conflict, 跳过 = everything else. */
export function importCounts(items: readonly ImportItem[], selected: readonly string[]): { nNew: number; nConflict: number; nSkip: number } {
  const on = new Set(selected);
  let nNew = 0;
  let nConflict = 0;
  for (const it of items) {
    if (!on.has(it.id)) continue;
    if (it.kind === 'new') nNew += 1;
    else if (it.kind === 'conflict') nConflict += 1;
  }
  return { nNew, nConflict, nSkip: items.length - nNew - nConflict };
}

export function ImportPreviewDialog({ snap, store }: ComponentProps): JSX.Element | null {
  const p = snap.ui.importPreview;
  if (!p) return null;

  const on = new Set(p.selected);
  const { nNew, nConflict, nSkip } = importCounts(p.items, p.selected);
  const cancel = () => store.cancelImport();

  return (
    <Modal isOpen onClose={cancel} title="导入模型配置">
      <div style={s.dlgBody}>
        <p style={sx(s.dlgDesc, s.mono)}>{`文件：${p.fileName}`}</p>
        {p.warning && <p style={s.impWarn}>{p.warning}</p>}
        <p style={s.dlgDesc}>{IMPORT_NOTE}</p>
        <ul style={s.impList}>
          {p.items.map((it, i) => {
            const verb = it.kind === 'conflict' ? '覆盖' : '导入';
            return (
              <li key={`${it.id}:${i}`} style={s.impRow}>
                <div style={s.impMain}>
                  <div style={sx(s.rowWrap, { gap: '6px' })}>
                    <span>{it.label}</span>
                    <Tag>{BADGE[it.kind]}</Tag>
                  </div>
                  <Hint>{it.reason}</Hint>
                </div>
                {it.checkable && (it.kind === 'new' || it.kind === 'conflict') && (
                  <label style={s.impCheck}>
                    <input
                      type="checkbox"
                      checked={on.has(it.id)}
                      aria-label={`${verb} ${it.label}`}
                      onChange={(e) => store.setImportChecked(it.id, e.target.checked)}
                    />
                    {verb}
                  </label>
                )}
              </li>
            );
          })}
        </ul>
        <p style={s.impCount} role="status">{`将新增 ${nNew} 项，覆盖 ${nConflict} 项，跳过 ${nSkip} 项。`}</p>
        <div style={s.dlgActions}>
          <Btn onClick={cancel}>取消</Btn>
          <Btn
            kind={nConflict > 0 ? 'danger' : 'primary'}
            disabled={p.selected.length === 0}
            onClick={() => store.confirmImport()}
          >
            {`确认导入（${p.selected.length}）`}
          </Btn>
        </div>
      </div>
    </Modal>
  );
}
