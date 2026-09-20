import { useEffect, useState } from 'react';
import { Alert, Spin } from 'antd';
import { useRequest } from '@umijs/max';
import { rawResult, tagApi } from '../api';
import type { Item } from '../types';
import ItemGrid from './ItemGrid';

const PAGE_SIZE = 60;
/**
 * 空结果。
 *
 * **四个字段都要显式类型** —— 光写 `{ foldersOf: {} }` 的话,`web/tsconfig.json` 的
 * `strict` 会把它推成 `{}`,索引直接报 TS2339。foldersOf 在本组件不读(归属 chips
 * 留在浏览页),但声明着 —— 收窄成两字段反而引 TS2339,收不干净。
 */
const EMPTY: {
  items: Item[];
  total: number;
  foldersOf: Record<string, { id: number; title: string }[]>;
  tagsOf: Record<string, string[]>;
} = { items: [], total: 0, foldersOf: {}, tagsOf: {} };

/**
 * 标签页右半边的视频墙 —— 取数/分页/tagsOf 这套逻辑以 BrowsePanel 为模板整体搬来
 * (条目渲染只有一套口径,复用 ItemGrid)。词的选中在树列(TagPanel 管,存 URL),
 * 本组件只管"选中的这个词下面有什么"。
 */
export default function TagItemPane({
  tagId, selectedId, excludeTag, onSelect, onTagsOf,
}: {
  tagId: number | null;
  selectedId: string | null;
  /** 角标要排除的词名(= 当前选中的词名),父层从树里查出来传下来 */
  excludeTag: string | null;
  onSelect: (item: Item) => void;
  /** 选中项的标签列表 —— tagsOf 在本组件手里,详情栏要的值得从这里上报 */
  onTagsOf: (tags: string[]) => void;
}) {
  const [page, setPage] = useState(1);
  const [error, setError] = useState('');

  // **拉挂了必须出声** —— 少了 setError,一次失败渲染出来的就是一块无声的空白。
  // 进入取数先清掉上一轮的 error:失败回落 EMPTY 后,红条还挂着会一直吓人
  const { data, loading } = useRequest(
    () => {
      setError('');
      return tagId
        ? tagApi.items(tagId, page, PAGE_SIZE).catch((e: Error) => { setError(e.message); return EMPTY; })
        : Promise.resolve(EMPTY);
    },
    { refreshDeps: [tagId, page], formatResult: rawResult },
  );

  // 选中变化时把详情栏要的 tags 上报给父层(无选中报空数组)。
  // 选中项不在本页 items 里(翻页翻走了)就**不上报** —— "不在本页"不是"没标签",
  // 详情栏保留旧标签行才是真话,报空数组会把详情栏清成"没有标签"
  useEffect(() => {
    if (!selectedId) { onTagsOf([]); return; }
    const inPage = (data?.items ?? []).some((it) => it.id === selectedId);
    if (!inPage) return;
    onTagsOf((data?.tagsOf ?? {})[selectedId] ?? []);
  }, [selectedId, data]);  // eslint-disable-line react-hooks/exhaustive-deps

  // 角标内容:其他词(排除当前词),最多 3 个,超出补 +N
  const tagsOf = data?.tagsOf ?? {};
  const badgesOf: Record<string, string[]> = {};
  for (const it of data?.items ?? []) {
    const others = (tagsOf[it.id] ?? []).filter((t) => t !== excludeTag);
    badgesOf[it.id] = others.slice(0, 3).concat(others.length > 3 ? [`+${others.length - 3}`] : []);
  }

  return (
    <div style={{ flex: 1, minWidth: 0, height: '100%', overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: 10 }}>
      {error && <Alert type="error" showIcon closable message={error} onClose={() => setError('')} />}
      {tagId === null ? (
        <div className="hud-panel" style={{ padding: '48px 20px', textAlign: 'center', color: 'var(--text-dim)', fontSize: 'var(--fs-13)' }}>
          左边选一个词
        </div>
      ) : error ? (
        // 失败回落 EMPTY 后,墙上那句「这个词下面还没有视频」是谎话 —— 照树列同款语气占位
        <div className="hud-panel" style={{ padding: '48px 20px', textAlign: 'center', color: 'var(--text-dim)', fontSize: 'var(--fs-13)' }}>
          视频列表没拉下来 —— 看上面的红条
        </div>
      ) : loading ? (
        <div style={{ padding: 40, textAlign: 'center' }}><Spin /></div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          <ItemGrid
            items={data?.items ?? []}
            total={data?.total ?? 0}
            page={page}
            pageSize={PAGE_SIZE}
            onPage={setPage}
            selectedId={selectedId}
            onSelect={onSelect}
            badgesOf={badgesOf}
            emptyText="这个词下面还没有视频"
          />
        </div>
      )}
    </div>
  );
}
