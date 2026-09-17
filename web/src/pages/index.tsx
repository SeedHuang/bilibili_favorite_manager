import { useEffect, useState } from 'react';
import { useRequest } from '@umijs/max';
import { Search } from 'lucide-react';
import { Input } from 'antd';
import { api, rawResult } from '../api';
import FolderList from '../components/FolderList';
import ItemGrid from '../components/ItemGrid';
import ContextPane from '../components/ContextPane';
import type { Folder, Item } from '../types';

const PAGE_SIZE = 40;

export default function Overview() {
  const [activeFolder, setActiveFolder] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [selectedItem, setSelectedItem] = useState<Item | null>(null);

  const { data: folders } = useRequest(() => api<{ folders: Folder[] }>('/api/folders'), {
    formatResult: rawResult,
  });

  // 首屏自动选中第一个夹子 —— 打开就有内容,而不是空等点击
  useEffect(() => {
    if (activeFolder === null && folders?.folders?.length) {
      setActiveFolder(folders.folders[0]!.id);
    }
  }, [folders, activeFolder]);

  const searching = query.trim().length > 0;

  const { data: folderItems } = useRequest(
    () =>
      activeFolder
        ? api<{ items: Item[]; total: number }>(
            `/api/folders/${activeFolder}/items?page=${page}&pageSize=${PAGE_SIZE}`,
          )
        : Promise.resolve({ items: [], total: 0 }),
    { refreshDeps: [activeFolder, page], formatResult: rawResult },
  );

  const { data: searchRes } = useRequest(
    () =>
      searching
        ? api<{ items: Item[] }>(`/api/items/search?q=${encodeURIComponent(query)}`)
        : Promise.resolve(null),
    { refreshDeps: [query], formatResult: rawResult },
  );

  const displayItems = searching ? (searchRes?.items ?? []) : (folderItems?.items ?? []);
  const activeTitle =
    folders?.folders?.find((f) => f.id === activeFolder)?.title ?? '全部收藏';

  return (
    <div style={{ display: 'flex', gap: 14, height: '100%', alignItems: 'stretch' }}>
      <FolderList
        folders={folders?.folders ?? []}
        active={activeFolder}
        onSelect={(id) => {
          setActiveFolder(id);
          setPage(1);
          setQuery(''); // 切夹子时清空搜索,避免"输入框有字但显示夹子内容"的错乱
          setSelectedItem(null);
        }}
      />

      {/* overflowX:hidden 兜底(防任何 1px 溢出)。底部间距用末尾的占位元素
          而不是 padding —— border-box 下容器的 padding 会被算进 height:100% */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          height: '100%',
          overflowY: 'auto',
          overflowX: 'hidden',
        }}
      >
        {/* ── HUD 计数条 ───────────────────────── */}
        <div
          className="hud-panel"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '8px 12px',
            marginBottom: 12,
          }}
        >
          <span className="hud-label">{searching ? '搜索' : '当前'}</span>
          <span style={{ fontSize: 'var(--fs-13)', color: 'var(--accent)' }}>
            {searching ? query : activeTitle}
          </span>
          <span className="num" style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>
            {searching
              ? `${displayItems.length} 条命中`
              : `${folderItems?.total ?? 0} 条`}
          </span>

          <Input
            prefix={<Search size={13} color="var(--text-dim)" />}
            placeholder="搜索标题 / 简介 / UP"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(1);
              setSelectedItem(null);
            }}
            allowClear
            variant="borderless"
            style={{ marginLeft: 'auto', width: 260 }}
          />
        </div>

        <ItemGrid
          items={displayItems}
          total={searching ? displayItems.length : (folderItems?.total ?? 0)}
          page={page}
          pageSize={PAGE_SIZE}
          onPage={setPage}
          selectedId={selectedItem?.id}
          onSelect={setSelectedItem}
        />

        {/* 滚动内容末尾的真实占位块 —— 保证滚到底时最后一行不贴边。
            用元素而不是 padding:border-box 下容器的 padding 会被算进
            height:100% 而"吃掉",放元素则 100% 属于滚动区。 */}
        <div style={{ height: 36 }} aria-hidden />
      </div>

      <ContextPane item={selectedItem} />
    </div>
  );
}
