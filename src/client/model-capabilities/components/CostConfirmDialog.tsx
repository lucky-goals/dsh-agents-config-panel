/**
 * Cost confirmation before a batch test (r4a-model-test.md 2.6, prototype
 * dialogHTML), drawn with the repo Modal: Escape and the mask cancel, 取消 has
 * the initial focus. 「本次会话不再提示」 is local until 开始测试.
 */
import React, { useState } from 'react';
import type { McSnapshot, ModelCapabilitiesStore } from '../types';
import { Modal } from '../../ui/Modal';
import { TEST_CONCURRENCY } from '../model-test';
import { mcStyles as s } from '../styles';
import { Btn } from './shared';

type ComponentProps = { snap: McSnapshot; store: ModelCapabilitiesStore };

type Cost = NonNullable<NonNullable<McSnapshot['test']>['cost']>;

/** Mounted per open dialog, so the checkbox starts unchecked every time. */
function CostBody({ cost, store }: { cost: Cost; store: ModelCapabilitiesStore }) {
  const [skip, setSkip] = useState(false);
  const n = cost.modelIds.length;
  const fact = (k: string, v: React.ReactNode, mono?: boolean) => (
    <li style={s.costFact}>
      <span style={s.costFactK}>{k}</span>
      <span style={mono ? { ...s.costFactV, ...s.mono } : s.costFactV}>{v}</span>
    </li>
  );
  return (
    <div style={s.dlgBody}>
      <p style={s.costLead}>将对 {n} 个模型各发送 1 次真实请求，会产生少量费用。</p>
      <ul style={s.costFacts}>
        {fact('提供方', cost.route, true)}
        {fact('每次请求', '短提示，maxTokens 32，最低推理档（能关就关）')}
        {fact('超时', '单个 20 秒')}
        {fact('并发', `最多 ${TEST_CONCURRENCY} 个，逐条返回，可随时停止`)}
      </ul>
      <label style={s.check}>
        <input
          type="checkbox"
          data-mc="cost-skip"
          checked={skip}
          onChange={(e) => setSkip(e.target.checked)}
          style={s.checkInput}
        />
        本次会话不再提示
      </label>
      <div style={s.dlgActions}>
        <Btn data-mc="cost-cancel" data-modal-autofocus="" onClick={() => store.cancelCost()}>取消</Btn>
        <Btn kind="primary-sm" data-mc="cost-ok" onClick={() => store.confirmCost(skip)}>开始测试</Btn>
      </div>
    </div>
  );
}

export function CostConfirmDialog({ snap, store }: ComponentProps): JSX.Element | null {
  const cost = snap.test?.cost;
  if (!cost) return null;
  return (
    <Modal isOpen onClose={() => store.cancelCost()} title={`测试 ${cost.modelIds.length} 个模型？`}>
      <CostBody key={`${cost.route}|${cost.label}|${cost.modelIds.join(',')}`} cost={cost} store={store} />
    </Modal>
  );
}
