import { ChevronRight, ChevronDown } from 'lucide-react';
import type { TagNode } from '../types';

/**
 * 词库树 —— **手写**的,不用 antd `Tree`。
 *
 * 为什么手写:仓库里夹子/条目那棵树就是手写的(WorkFolderTree.tsx),它自成
 * 一套样式(缩进 + 展开三角 + 操作按钮 + 计数贴右)。antd Tree 一次没用过,
 * 混进来会多一套要调的样式和一套要学的 API,换不到任何东西。
 *
 * 这个组件**只管显示和展开/选中**,操作按钮由调用方经 `renderActions` 注入
 * ——「标签」页要改名/合并/删除,「浏览」页只选中,两边共用同一棵树。
 * 分两份写迟早分叉(和 shapeItem 注释里那条同理)。
 */
export default function TagTree({
  nodes,
  expanded,
  selectedId,
  onToggleExpand,
  onSelect,
  renderActions,
  depth = 0,
}: {
  nodes: TagNode[];
  expanded: Set<number>;
  selectedId?: number | null;
  onToggleExpand: (id: number) => void;
  /** 不传 = 只读(「浏览」页选了才有意义) */
  onSelect?: (id: number) => void;
  renderActions?: (node: TagNode) => React.ReactNode;
  depth?: number;
}) {
  return (
    <>
      {nodes.map((n) => {
        const open = expanded.has(n.id);
        const hasKids = n.children.length > 0;
        return (
          <div key={n.id}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '5px 4px',
                paddingLeft: 4 + depth * 16,
                borderBottom: '1px solid var(--rule)',
                background: n.id === selectedId ? 'var(--surface-2)' : 'none',
              }}
            >
              {hasKids ? (
                <button
                  type="button"
                  aria-label={open ? '收起' : '展开'}
                  aria-expanded={open}
                  onClick={() => onToggleExpand(n.id)}
                  style={{
                    flex: 'none', border: 'none', background: 'none', padding: 0,
                    cursor: 'pointer', color: 'var(--text-dim)', lineHeight: 0,
                  }}
                >
                  {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>
              ) : (
                // 没有孩子也占同样的位置,否则同级节点名字对不齐
                <span style={{ width: 14, flex: 'none' }} aria-hidden />
              )}

              {onSelect ? (
                <button
                  type="button"
                  onClick={() => onSelect(n.id)}
                  style={{
                    border: 'none', background: 'none', padding: 0, cursor: 'pointer',
                    font: 'inherit', fontSize: 'var(--fs-13)', textAlign: 'left',
                    color: n.id === selectedId ? 'var(--accent)' : 'var(--text)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}
                >
                  {n.name}
                </button>
              ) : (
                <span
                  style={{
                    fontSize: 'var(--fs-13)', overflow: 'hidden',
                    textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}
                >
                  {n.name}
                </span>
              )}

              {renderActions?.(n)}

              <span
                className="num"
                style={{ marginLeft: 'auto', fontSize: 'var(--fs-12)', color: 'var(--text-dim)', flex: 'none' }}
              >
                {n.count}
              </span>
            </div>

            {open && (
              <TagTree
                nodes={n.children}
                expanded={expanded}
                selectedId={selectedId ?? null}
                onToggleExpand={onToggleExpand}
                {...(onSelect ? { onSelect } : {})}
                {...(renderActions ? { renderActions } : {})}
                depth={depth + 1}
              />
            )}
          </div>
        );
      })}
    </>
  );
}
