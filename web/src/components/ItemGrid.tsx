import { Pagination } from 'antd';
import type { Item } from '../types';

/** 封面走同源代理(/api/cover 转发 CDN),绕开浏览器跨域 ORB 拦截 */
const coverSrc = (c: string) =>
  `/api/cover?url=${encodeURIComponent(c.replace(/^http:\/\//, 'https://'))}`;

const dur = (d: number | null) =>
  d ? `${Math.floor(d / 60)}:${String(d % 60).padStart(2, '0')}` : '';

/**
 * 封面墙 —— 深色底下让封面承担全部色彩(HUD 里 chrome 保持安静)。
 * 悬停:青色微光 + 上浮;选中:青描边 + 四角括号。
 */
export default function ItemGrid({
  items,
  total,
  page,
  pageSize,
  onPage,
  selectedId,
  onSelect,
}: {
  items: Item[];
  total: number;
  page: number;
  pageSize: number;
  onPage: (p: number) => void;
  selectedId?: string | null;
  onSelect?: (item: Item) => void;
}) {
  if (items.length === 0) {
    return (
      <div
        className="hud-panel"
        style={{
          padding: '48px 20px',
          textAlign: 'center',
          color: 'var(--text-dim)',
          fontSize: 'var(--fs-13)',
        }}
      >
        选择左侧收藏夹,或在上方搜索
      </div>
    );
  }

  return (
    <div>
      <div className="cover-grid">
        {items.map((it) => {
          const on = it.id === selectedId;
          return (
            <div
              key={it.id}
              className={`cover-card${on ? ' is-selected' : ''}${it.invalid ? ' is-invalid' : ''}`}
              onClick={() => onSelect?.(it)}
              title={it.title}
            >
              {it.invalid ? <span className="cover-card__badge">已失效</span> : null}
              {it.cover ? (
                <div className="cover-card__thumb">
                  <img src={coverSrc(it.cover)} alt="" loading="lazy" />
                  <div className="cover-card__meta">
                    <span className="cover-card__up">{it.upperName ?? '未知 UP'}</span>
                    <span className="cover-card__dur">{dur(it.duration)}</span>
                  </div>
                </div>
              ) : (
                <div className="cover-card__thumb" />
              )}
              <div className="cover-card__title">{it.title}</div>
            </div>
          );
        })}
      </div>

      {total > pageSize && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '20px 0 4px' }}>
          <Pagination
            current={page}
            pageSize={pageSize}
            total={total}
            onChange={onPage}
            showSizeChanger={false}
            size="small"
          />
        </div>
      )}
    </div>
  );
}
