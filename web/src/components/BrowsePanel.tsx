import { useState } from 'react';
import { Alert, Spin } from 'antd';
import { useRequest, useSearchParams } from '@umijs/max';
import { rawResult, tagApi } from '../api';
import type { Item } from '../types';
import ContextPane from './ContextPane';
import ItemGrid from './ItemGrid';
import TagTree from './TagTree';

const PAGE_SIZE = 60;
/**
 * 空结果。
 *
 * **四个字段都要显式类型** —— 光写 `{ foldersOf: {} }` 的话,`web/tsconfig.json` 的
 * `strict` 会把它推成 `{}`,下面 `foldersOf[it.id]` 的索引直接报 **TS7053**,
 * Task 9 的 typecheck 门禁过不去。(初稿就是这么写的,实测复现过。)
 */
const EMPTY: {
  items: Item[];
  total: number;
  foldersOf: Record<string, { id: number; title: string }[]>;
  tagsOf: Record<string, string[]>;
} = { items: [], total: 0, foldersOf: {}, tagsOf: {} };

/**
 * 按标签看收藏 —— 复用 ItemGrid(条目渲染只有一套口径),只在旁边加一层标签选择。
 *
 * 选中的标签存在 URL 上(`?tag=`),不放在 state 里:刷新和后退键都还在原地,
 * 而且"选中了哪个词"本来就是一个能用纯 URL 表达的状态 —— 想钉到某一个词,
 * 给个链接就行,不必为此开一条组件间的传参通道。
 */
export default function BrowsePanel() {
  const [params, setParams] = useSearchParams();
  const tagId = Number(params.get('tag')) || null;
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState<Item | null>(null);
  const [error, setError] = useState('');

  // **拉挂了必须出声** —— 少了 onError,一次失败渲染出来的是左边那句"词库还是空的,
  // 先去点一次「AI 标注」",而那是句谎话,照它做还会白跑一次全库 LLM。
  // (「规则」页那棵同源的树也是这么取的。)
  const { data: tree, error: treeError } = useRequest(() => tagApi.tree(), {
    formatResult: rawResult,
    onError: (e) => setError(e.message),
  });
  const { data, loading } = useRequest(
    () => (tagId ? tagApi.items(tagId, page).catch((e: Error) => { setError(e.message); return EMPTY; }) : Promise.resolve(EMPTY)),
    { refreshDeps: [tagId, page], formatResult: rawResult },
  );

  /**
   * 选词。**页码必须归零** —— 不归的话从"有 5 页的词"跳到"只有 1 页的词",
   * 画面是空的,而用户会以为那个词没视频。
   */
  const pick = (id: number) => {
    setPage(1);
    setSelected(null);
    setParams({ tag: String(id) });
  };

  const icon = (id: number) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const foldersOf = data?.foldersOf ?? {};
  const tagsOf = data?.tagsOf ?? {};
  const current = tree?.tree ? findName(tree.tree, tagId) : null;

  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      <div className="hud-panel" style={{ width: 300, flex: 'none', padding: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <span className="hud-label">词库</span>
          {tagId !== null && (
            <button
              type="button"
              onClick={() => { setPage(1); setSelected(null); setParams({}); }}
              style={{ marginLeft: 'auto', border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-dim)', fontSize: 'var(--fs-12)' }}
            >
              清除
            </button>
          )}
        </div>
        {(tree?.tree ?? []).length === 0 ? (
          <div style={{ color: 'var(--text-dim)', fontSize: 'var(--fs-12)', padding: '12px 0' }}>
            {treeError ? '词库没拉下来 —— 看红条' : '词库还是空的 —— 先去「标签」页点一次「AI 标注」'}
          </div>
        ) : (
          <TagTree
            nodes={tree!.tree}
            expanded={expanded}
            selectedId={tagId}
            onToggleExpand={icon}
            onSelect={pick}
          />
        )}
      </div>

      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {error && <Alert type="error" showIcon closable message={error} onClose={() => setError('')} />}

        {tagId === null ? (
          <div className="hud-panel" style={{ padding: '48px 20px', textAlign: 'center', color: 'var(--text-dim)', fontSize: 'var(--fs-13)' }}>
            左边选一个词
          </div>
        ) : loading ? (
          <div style={{ padding: 40, textAlign: 'center' }}><Spin /></div>
        ) : (
          <>
            <div style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>
              「{current ?? tagId}」连同它下面的词,一共{' '}
              <span className="num" style={{ color: 'var(--accent)' }}>{data?.total ?? 0}</span> 条
            </div>

            {/* 归属 chips —— 一条视频散在哪些夹子里。这正是标签存在的理由:
                夹子分不干净,标签能跨着看 */}
            {(data?.items ?? []).some((it) => (foldersOf[it.id] ?? []).length > 0) && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {(data?.items ?? []).map((it) => {
                  const fs = foldersOf[it.id] ?? [];
                  if (fs.length === 0) return null;
                  return (
                    <div key={it.id} style={{ display: 'flex', gap: 8, fontSize: 'var(--fs-12)', alignItems: 'baseline' }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 360 }}>
                        {it.title}
                      </span>
                      <span style={{ color: 'var(--text-dim)' }}>
                        在 {fs.map((f) => `「${f.title}」`).join(' ')}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}

            <ItemGrid
              items={data?.items ?? []}
              total={data?.total ?? 0}
              page={page}
              pageSize={PAGE_SIZE}
              onPage={setPage}
              selectedId={selected?.id ?? null}
              onSelect={setSelected}
            />
          </>
        )}
      </div>

      {/* tags 从筛选结果里带下来 —— 详情栏自己发请求会让每选一条都打一次接口 */}
      <ContextPane item={selected} tags={selected ? tagsOf[selected.id] ?? [] : []} />
    </div>
  );
}

/** 树里按 id 找名字(只用于顶部那句「选了谁」) */
function findName(nodes: { id: number; name: string; children: any[] }[], id: number | null): string | null {
  if (id === null) return null;
  for (const n of nodes) {
    if (n.id === id) return n.name;
    const hit = findName(n.children, id);
    if (hit) return hit;
  }
  return null;
}
