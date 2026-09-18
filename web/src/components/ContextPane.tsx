import { useState } from 'react';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import type { Item } from '../types';

const coverSrc = (c: string) =>
  `/api/cover?url=${encodeURIComponent(c.replace(/^http:\/\//, 'https://'))}`;

const dur = (d: number | null) =>
  d ? `${Math.floor(d / 60)}:${String(d % 60).padStart(2, '0')}` : '—';

const date = (t: number | null) => (t ? new Date(t * 1000).toLocaleDateString('zh-CN') : '—');

/**
 * 右栏详情 —— HUD 面板。折叠状态只留一个展开按钮,不占版面。
 *
 * `tags` 由**调用方**传进来,组件自己不发请求:详情栏跟着选中项变,
 * 让它自己请求的话每选一条都要多打一次接口(而且「浏览」页手上本来就有)。
 */
export default function ContextPane({ item, tags = [] }: { item: Item | null; tags?: string[] }) {
  const [open, setOpen] = useState(true);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        title="展开详情"
        style={{
          flex: 'none',
          width: 30,
          padding: '8px 0',
          background: 'var(--surface)',
          border: '1px solid var(--rule)',
          color: 'var(--text-dim)',
          cursor: 'pointer',
        }}
      >
        <PanelRightOpen size={15} />
      </button>
    );
  }

  return (
    <aside
      className="hud-panel"
      style={{ width: 268, flex: 'none', height: '100%', overflowY: 'auto', padding: 12 }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 12,
        }}
      >
        <span className="hud-label">条目详情</span>
        <button
          onClick={() => setOpen(false)}
          title="收起"
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--text-dim)',
            cursor: 'pointer',
            padding: 0,
            lineHeight: 0,
          }}
        >
          <PanelRightClose size={15} />
        </button>
      </div>

      {!item ? (
        <p style={{ color: 'var(--text-dim)', fontSize: 'var(--fs-12)', margin: 0 }}>
          点击封面查看详情
        </p>
      ) : (
        <div>
          {item.cover && (
            <div className="cover-card__thumb hud-cut" style={{ marginBottom: 10 }}>
              <img src={coverSrc(item.cover)} alt="" />
            </div>
          )}

          <div style={{ fontSize: 'var(--fs-13)', fontWeight: 600, lineHeight: 1.5 }}>
            {item.title}
          </div>

          <dl
            style={{
              margin: '12px 0 0',
              display: 'grid',
              gridTemplateColumns: 'auto 1fr',
              gap: '6px 10px',
              fontSize: 'var(--fs-12)',
            }}
          >
            <dt className="hud-label" style={{ margin: 0 }}>UP</dt>
            <dd style={{ margin: 0, color: 'var(--text)' }}>{item.upperName ?? '未知'}</dd>

            <dt className="hud-label" style={{ margin: 0 }}>时长</dt>
            <dd className="num" style={{ margin: 0, color: 'var(--text)' }}>
              {dur(item.duration)}
            </dd>

            <dt className="hud-label" style={{ margin: 0 }}>收藏</dt>
            <dd className="num" style={{ margin: 0, color: 'var(--text)' }}>
              {date(item.favTime)}
            </dd>

            <dt className="hud-label" style={{ margin: 0 }}>状态</dt>
            <dd
              style={{
                margin: 0,
                color: item.invalid ? 'var(--danger)' : 'var(--ok)',
              }}
            >
              {item.invalid ? '已失效' : '正常'}
            </dd>

            <dt className="hud-label" style={{ margin: 0 }}>标签</dt>
            <dd style={{ margin: 0, color: 'var(--text)' }}>
              {tags.length ? tags.join(' · ') : '—'}
            </dd>
          </dl>

          {item.invalid && (
            <p
              style={{
                marginTop: 12,
                paddingTop: 10,
                borderTop: '1px solid var(--rule)',
                color: 'var(--danger)',
                fontSize: 'var(--fs-12)',
              }}
            >
              这条已失效,可在 M5 的「清理失效内容」中删除。
            </p>
          )}
        </div>
      )}
    </aside>
  );
}
