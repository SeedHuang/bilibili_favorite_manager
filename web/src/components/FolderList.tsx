import { Lock } from 'lucide-react';
import type { Folder } from '../types';

/**
 * 左栏收藏夹 —— HUD 侧栏。
 * 选中态用「青色左边条 + 抬升底色 + 青色描边切角」,而非反白块(对比度更好、更 HUD)。
 */
export default function FolderList({
  folders,
  active,
  onSelect,
}: {
  folders: Folder[];
  active: number | null;
  onSelect: (id: number) => void;
}) {
  const total = folders.reduce((s, f) => s + (f.mediaCount ?? 0), 0);

  return (
    <aside
      className="hud-panel"
      style={{
        width: 232,
        flex: 'none',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        padding: '12px 0',
      }}
    >
      <div
        style={{
          padding: '0 12px 10px',
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
        }}
      >
        <span className="hud-label">收藏夹</span>
        <span className="num" style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>
          {folders.length}
        </span>
      </div>

      {/* 只有需要时才出现滚动条 —— flex:1 + minHeight:0 让列表自己滚,
          底部「合计」行始终钉在栏底 */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', paddingBottom: 8 }}>
        {folders.map((f) => {
          const on = active === f.id;
          return (
            <button
              key={f.id}
              onClick={() => onSelect(f.id)}
              style={{
                display: 'flex',
                width: '100%',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                gap: 8,
                padding: '7px 12px',
                margin: 0,
                border: 'none',
                borderLeft: on ? '2px solid var(--accent)' : '2px solid transparent',
                background: on ? 'var(--surface-2)' : 'transparent',
                color: on ? 'var(--accent)' : 'var(--text)',
                font: 'inherit',
                fontSize: 'var(--fs-13)',
                textAlign: 'left',
                cursor: 'pointer',
                transition: 'background .13s ease-out, color .13s ease-out',
              }}
              onMouseEnter={(e) => {
                if (!on) e.currentTarget.style.background = 'var(--surface-2)';
              }}
              onMouseLeave={(e) => {
                if (!on) e.currentTarget.style.background = 'transparent';
              }}
            >
              <span
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                  minWidth: 0,
                  overflow: 'hidden',
                }}
              >
                {f.locked && (
                  <Lock
                    size={11}
                    style={{ flex: 'none', color: 'var(--warn)' }}
                    aria-label="默认收藏夹"
                  >
                    <title>B站 自带的默认收藏夹 —— 不能改名、不能删除,只能移走里面的条目</title>
                  </Lock>
                )}
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {f.title}
                </span>
              </span>
              <span
                className="num"
                style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)', flex: 'none' }}
              >
                {f.mediaCount ?? 0}
              </span>
            </button>
          );
        })}

        {folders.length === 0 && (
          <div
            style={{ padding: '16px 12px', color: 'var(--text-dim)', fontSize: 'var(--fs-12)' }}
          >
            还没有同步任何收藏夹
          </div>
        )}
      </div>

      <div
        style={{
          margin: '10px 12px 0',
          paddingTop: 10,
          borderTop: '1px solid var(--rule)',
          display: 'flex',
          justifyContent: 'space-between',
        }}
      >
        <span className="hud-label">合计</span>
        <span className="num" style={{ fontSize: 'var(--fs-12)', color: 'var(--accent)' }}>
          {total}
        </span>
      </div>
    </aside>
  );
}
