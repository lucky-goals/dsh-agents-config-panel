/**
 * 「模型能力」 settings.section (spec D). Controlled by the store: it
 * subscribes with useSyncExternalStore, loads on mount, disposes on unmount,
 * and renders one view per snap.ui.
 *
 * Layout: [关闭] · scrolling main area (banners on top) · edit/bulk layer
 * (absolute, 48px left for the save bar) · save bar · dialog · row menu.
 * A layer makes the main area inert; a dialog makes the main area, the layer
 * and the save bar inert.
 */
import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { McSnapshot, ModelCapabilitiesStore } from './types';
import { Alert } from '../ui/Alert';
import { Button } from '../ui/Button';
import { mcStyles as s } from './styles';
import { AddProviderWizard } from './components/AddProviderWizard';
import { BulkLayer } from './components/BulkLayer';
import { DeleteDialog } from './components/DeleteDialog';
import { EditAccessLayer } from './components/EditAccessLayer';
import { ModelEditLayer } from './components/ModelEditLayer';
import { ModelTable } from './components/ModelTable';
import { PreviewPanel } from './components/PreviewPanel';
import { ProviderDetail } from './components/ProviderDetail';
import { ListHead, ProviderList } from './components/ProviderList';
import { RowMenu } from './components/RowMenu';
import { SaveBar } from './components/SaveBar';
import { Banners, useInert, useIsoLayoutEffect } from './components/shared';

export interface ModelCapabilitiesPanelProps {
  store: ModelCapabilitiesStore;
  /** Host settings close (settings.section props); the button is hidden when absent. */
  close?: () => void;
}

type LayerKind = 'model' | 'access' | 'bulk' | null;

function layerOf(snap: McSnapshot): LayerKind {
  const { ui } = snap;
  if (ui.loading || snap.loadError) return null;
  if (ui.edit) return ui.edit.kind;
  if (ui.bulk) return 'bulk';
  return null;
}

function layerLabel(snap: McSnapshot, layer: Exclude<LayerKind, null>): string {
  const edit = snap.ui.edit;
  if (layer === 'bulk') return '批量设置';
  if (edit?.kind === 'access') return `编辑接入 ${edit.route}`;
  if (edit?.kind === 'model') return `编辑模型 ${snap.draft.providers[edit.route]?.models[edit.idx]?.id ?? ''}`;
  return '';
}

function MainView({ snap, store }: { snap: McSnapshot; store: ModelCapabilitiesStore }) {
  const { ui } = snap;
  if (ui.loading) {
    return (
      <>
        <ListHead addDisabled />
        <div style={s.skeleton} aria-hidden="true" />
        <div style={s.skeleton} aria-hidden="true" />
        <div style={s.skeleton} aria-hidden="true" />
        <span role="status" style={s.srOnly}>正在加载配置</span>
      </>
    );
  }
  if (snap.loadError) {
    return (
      <>
        <ListHead addDisabled />
        <Alert type="error">
          <div>{snap.loadError}</div>
          <div style={{ marginTop: '8px' }}><Button onClick={() => void store.reload()}>重新加载</Button></div>
        </Alert>
      </>
    );
  }
  switch (ui.view) {
    case 'detail':
      return (
        <>
          <ProviderDetail snap={snap} store={store} />
          <ModelTable snap={snap} store={store} />
        </>
      );
    case 'wizard':
      return <AddProviderWizard snap={snap} store={store} />;
    case 'preview':
      return <PreviewPanel snap={snap} store={store} />;
    default:
      return <ProviderList snap={snap} store={store} />;
  }
}

export function ModelCapabilitiesPanel(props: ModelCapabilitiesPanelProps): JSX.Element | null {
  const { store, close } = props;
  const snap = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const { ui } = snap;

  useEffect(() => {
    void store.load();
    return () => store.dispose();
  }, [store]);

  const rootRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);

  const layer = layerOf(snap);
  const dialog = !!ui.dialog;
  const mainHidden = !!layer || dialog;
  useInert(mainRef, mainHidden);
  useInert(layerRef, dialog);
  useInert(barRef, dialog);

  // The 「···」 button of the open row menu (the menu measures it).
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  useIsoLayoutEffect(() => {
    const el = ui.menuIdx == null
      ? null
      : rootRef.current?.querySelector<HTMLElement>(`[data-mc-menu="${ui.menuIdx}"]`) ?? null;
    setAnchor((prev) => (prev === el ? prev : el));
  }, [ui.menuIdx, ui.view, ui.route]);

  // Layer focus: in on open, back to the trigger (or 返回提供方) on close.
  const layerKey = layer ? `${layer}:${ui.edit?.route ?? ui.bulk?.route ?? ''}:${ui.edit?.kind === 'model' ? ui.edit.idx : ''}` : '';
  const returnTo = useRef<HTMLElement | null>(null);
  const prevLayer = useRef('');
  useIsoLayoutEffect(() => {
    const before = prevLayer.current;
    prevLayer.current = layerKey;
    if (layerKey && layerKey !== before) {
      if (!before) {
        const active = rootRef.current?.ownerDocument.activeElement;
        returnTo.current = active instanceof HTMLElement && mainRef.current?.contains(active) ? active : null;
      }
      const target = layerRef.current?.querySelector<HTMLElement>(
        layer === 'model' && ui.edit?.kind === 'model' && !snap.draft.providers[ui.edit.route]?.models[ui.edit.idx]?.id
          ? 'input:not([disabled])'
          : '[data-mc="close-layer"], [data-mc="bulk-close"]',
      );
      target?.focus();
    } else if (!layerKey && before) {
      const back = returnTo.current;
      returnTo.current = null;
      if (back && back.isConnected) back.focus();
      else rootRef.current?.querySelector<HTMLElement>('[data-mc="back-list"], [data-mc="bulk-toggle"]')?.focus();
    }
  }, [layerKey]);

  // Escape: menu → layer → bulk → preview → wizard (the Modal owns it while a dialog is open).
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Escape' || e.defaultPrevented || e.nativeEvent.isComposing || dialog) return;
    let handled = true;
    if (ui.menuIdx != null) store.closeMenu();
    else if (ui.edit) store.closeLayer();
    else if (ui.bulk) store.closeBulk();
    else if (ui.view === 'preview') store.closePreview();
    else if (ui.view === 'wizard') store.wizardCancel();
    else handled = false;
    if (handled) e.preventDefault();
  };

  return (
    <div ref={rootRef} style={s.root} onKeyDown={onKeyDown}>
      {close && (
        <div style={s.topbar}>
          <Button onClick={close}>关闭</Button>
        </div>
      )}
      {/* Content column: the layer covers it down to the 48px save bar. */}
      <div style={s.body}>
        <div ref={mainRef} style={s.scroll} aria-hidden={mainHidden ? 'true' : undefined}>
          <Banners snap={snap} store={store} />
          <MainView snap={snap} store={store} />
        </div>
        {layer && (
          <div
            ref={layerRef}
            role="region"
            aria-label={layerLabel(snap, layer)}
            aria-hidden={dialog ? 'true' : undefined}
            style={s.layer}
          >
            {layer === 'bulk' ? (
              <BulkLayer snap={snap} store={store} />
            ) : (
              <div style={s.scroll}>
                {layer === 'model' ? <ModelEditLayer snap={snap} store={store} /> : <EditAccessLayer snap={snap} store={store} />}
              </div>
            )}
          </div>
        )}
        <div ref={barRef} style={s.savebar} aria-hidden={dialog ? 'true' : undefined}>
          <SaveBar snap={snap} store={store} />
        </div>
      </div>
      <DeleteDialog snap={snap} store={store} />
      <RowMenu snap={snap} store={store} anchor={anchor} />
    </div>
  );
}
