import { useEffect, useState } from 'react';
import { workbenchApi } from '../api';
import type { OperationEntry } from '../types';

/** 留痕的界面落点(spec §9B.5)。一次操作一行 —— 拖 412 条也是这一行。 */
export default function OperationLog({ refreshKey }: { refreshKey: number }) {
  const [rows, setRows] = useState<OperationEntry[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    // 每次重拉先清错误 —— 否则一次失败会把整个面板永久变成一行错误,
    // 后面刷新成功了也回不来
    setError('');
    workbenchApi.log().then(setRows).catch((e) => setError((e as Error).message));
  }, [refreshKey]);

  if (error) return <div style={{ color: 'var(--danger)', fontSize: 'var(--fs-12)' }}>{error}</div>;

  return (
    <div className="hud-panel" style={{ padding: 12, maxHeight: 260, overflowY: 'auto' }}>
      <span className="hud-label">操作记录</span>
      {rows.length === 0 && (
        <div style={{ color: 'var(--text-dim)', fontSize: 'var(--fs-12)', paddingTop: 6 }}>
          还没有任何改动
        </div>
      )}
      {rows.map((r) => (
        <div key={r.id} style={{ display: 'flex', gap: 8, padding: '4px 0', borderBottom: '1px solid var(--rule)' }}>
          <span className="num" style={{ fontSize: 11, color: 'var(--text-dim)', flex: 'none' }}>
            {new Date(r.ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
          </span>
          {r.actor === 'ai' && (
            <span className="hud-label" style={{ fontSize: 10, color: 'var(--ai)', flex: 'none' }}>AI</span>
          )}
          {/*
            失败的尝试标红 + 把 detail.reason(失败原因)放在 summary 下面 ——
            否则只看到「失败:」三个字看不到为什么。
          */}
          {r.kind === 'failed' && (
            <span className="hud-label" style={{ fontSize: 10, color: 'var(--danger)', flex: 'none' }}>失败</span>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 'var(--fs-12)' }}>{r.summary}</div>
            {(() => {
              const d = r.detail;
              if (!d || typeof d !== 'object' || !('reason' in d)) return null;
              const reason = String((d as { reason: string }).reason);
              return (
                <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 2 }}>
                  {reason}
                </div>
              );
            })()}
          </div>
        </div>
      ))}
    </div>
  );
}
