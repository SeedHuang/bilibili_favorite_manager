import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useRequest } from '@umijs/max';
import { App as AntApp, Button, Input, Alert, Select, Tabs } from 'antd';
import { Bot, Undo2, Plus, FolderInput, MoveRight, FolderX, Lock } from 'lucide-react';
import { api, rawResult, workbenchApi, setFolderLock } from '../api';
import type { Folder, Item, WorkbenchView } from '../types';
import WorkFolderTree from '../components/WorkFolderTree';
import OperationLog from '../components/OperationLog';
import { useAssistant } from '../components/assistant';

/** 整理 —— 一份结构,改动带标记。AI 不在这里(在右下角对话框里)。 */
export default function CuratorPage() {
  // 静态 `Modal.confirm` 认不到主题(它在另一个 React root 里)——
  // 用 `App.useApp()` 拿的那套才走 ConfigProvider
  const { modal } = AntApp.useApp();
  const { openWith } = useAssistant();
  const navigate = useNavigate();

  const [view, setView] = useState<WorkbenchView | null>(null);
  // total 是夹子的真实条目数,items 只有前 500 条 —— 两者不等时要说出来
  const [expanded, setExpanded] = useState<{ folderId: number; items: Item[]; total: number } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // reload 要能重拉展开区(移走 / 移动之后它显示的还是旧内容,而按钮就在展开区里),
  // 但 reload 的依赖里不能放 expanded —— 那会让挂载 effect 每次展开都重跑。用 ref 记。
  const expandedIdRef = useRef<number | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [logKey, setLogKey] = useState(0);
  /** 勾中的**夹子** —— 「移动 / 也放进」的源。目标在点了按钮之后再选 */
  const [checkedFolders, setCheckedFolders] = useState<Set<number>>(new Set());

  // 还没有工作副本时,页面要显示的是 **B站 现在的样子** —— 那份结构在快照里,
  // 而工作台视图此时刻意返回空(见 buildWorkbenchView 的开头)。
  // 所以这条只在 !exists 分支用到。
  const { data: foldersRes, refresh: refreshFolders } = useRequest(
    () => api<{ folders: Folder[] }>('/api/folders'),
    { formatResult: rawResult },
  );
  const snapshotFolders = foldersRes?.folders ?? [];

  const reload = useCallback(async () => {
    const next = await workbenchApi.get();
    setView(next);
    // 夹子可能已经被删/被合并 —— 指向不存在的夹子的状态要收回来,
    // 否则按钮可点、点了 404,Select 还会把裸 id 当名字显示
    // 勾中的夹子可能已经被删/被合并 —— 回收掉,否则按钮还在、点了 404
    setCheckedFolders((c) => {
      const keep = new Set([...c].filter((id) => next.folders.some((f) => f.id === id)));
      return keep.size === c.size ? c : keep;
    });
    setExpanded((e) => (e !== null && !next.folders.some((f) => f.id === e.folderId) ? null : e));
    setLogKey((k) => k + 1);
    // 快照那份也要跟着刷 —— 它只在挂载时拉过一次,不管的话「一键还原」之后
    // 显示的还是**打开页面那一刻**的 B站 结构,而不是刚同步进来的那份。
    void refreshFolders();

    // 展开的那一份同理:移走 / 移动之后不重拉的话,条目还在列表里躺着,
    // 而行头已经变了 —— 展开区里就摆着操作按钮,这种不一致会被当成"没生效"。
    const open = expandedIdRef.current;
    if (open !== null && next.folders.some((f) => f.id === open)) {
      const r = await workbenchApi.items(open);
      setExpanded({ folderId: open, items: r.items, total: r.total });
    }
    // refreshFolders 由 useRequest 给出、身份稳定,不进依赖列表(否则每次渲染
    // 都会重建 reload,而 reload 是挂载 effect 的依赖 → 无限拉取)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    expandedIdRef.current = expanded?.folderId ?? null;
  }, [expanded]);

  useEffect(() => {
    reload().catch((e) => setError((e as Error).message));
  }, [reload]);

  /**
   * 所有编辑动作走这里:统一错误处理 + 重新拉视图(标记每次都重算)。
   * 返回是否成功 —— 调用方要据此决定「成功后收尾」的动作(比如清勾选):
   * 失败时 Promise 不会 reject(错误已经被此处吞下),写死 .then 会连失败也清。
   */
  const act = async (fn: () => Promise<unknown>, okMsg?: string): Promise<boolean> => {
    setError('');
    setNotice('');
    try {
      await fn();
      await reload();
      if (okMsg) setNotice(okMsg);
      return true;
    } catch (e) {
      setError((e as Error).message);
      // 失败也要 reload —— 后端 actionError 已经把 failed 写了 operation_log,
      // 不 reload 的话 OperationLog 面板 logKey 不变,这条新记录就出不来。
      // 视图本身失败前后没变(没改成功),reload 一遍代价是再请求一次 /api/workbench。
      await reload();
      return false; // 失败:保持现状,让用户重试(勾选也不动)
    }
  };

  const toggleExpand = async (folderId: number) => {
    if (expanded?.folderId === folderId) {
      setExpanded(null);
      // 勾选跟着展开走:收起之后勾选看不见了,还留着"已选 N 条"就会动到
      // 用户当前根本没看见的条目
      setSelected(new Set());
      return;
    }
    setSelected(new Set()); // 同理:换夹子要清,否则会把上一个夹子勾的一起移走
    try {
      // 一律走**工作副本**口径。新建的夹子 originId 是 null,但完全可能有条目
      // (移动 / 也放进 / AI 应用都会往里写)—— 之前按"没有原点就当它空"处理,
      // 结果是行头说 645、展开说 0,而且那些条目从此看不见也勾不到,再也挪不走。
      const r = await workbenchApi.items(folderId);
      setExpanded({ folderId, items: r.items, total: r.total });
    } catch (e) {
      // 展开是用户主动点的,失败必须说出来 —— 否则点了毫无反应
      setError((e as Error).message);
    }
  };

  /**
   * 勾/取消一个夹子。**锁定的直接拒** —— 树上的 checkbox 也是禁用的,
   * 这里再挡一次是防"先勾上、之后才把它锁上"这种时序。
   */
  const toggleCheckFolder = (folderId: number) => {
    if (view?.folders.find((f) => f.id === folderId)?.locked) return;
    setCheckedFolders((c) => {
      const next = new Set(c);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  };

  /**
   * 移动 / 也放进 —— 源是勾中的**夹子**,目标是**点了按钮之后**才选。
   *
   * 为什么把目标选择挪到点击之后:原来底部挂着一个目标下拉框,常驻占地方、
   * 而且「移动」按钮还得等它选完才亮 —— 用户得先想好去哪儿,再回头勾东西。
   * 现在:勾夹子 → 点动作 → 弹窗里选目标(可打字搜)。
   */
  const runOnChecked = (mode: 'move' | 'add') => {
    const fromFolderIds = [...checkedFolders];
    const totalItems = fromFolderIds.reduce(
      (n, id) => n + (view?.folders.find((f) => f.id === id)?.itemCount ?? 0),
      0,
    );
    let target: number | null = null;

    modal.confirm({
      title: mode === 'move' ? '移到哪个夹子?' : '也放进哪个夹子?',
      content: (
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 6 }}>
            {mode === 'move'
              ? `${fromFolderIds.length} 个夹子里的 ${totalItems} 条会**离开原处**,进到目标夹子。`
              : `${fromFolderIds.length} 个夹子里的 ${totalItems} 条会**再加一份**到目标夹子,原处保留。`}
          </div>
          <Select
            autoFocus
            showSearch
            optionFilterProp="label"
            placeholder="打字可以搜"
            style={{ width: '100%' }}
            // 目标不能是源之一 —— 自己移到自己没意义(后端也会拒)
            options={(view?.folders ?? [])
              .filter((f) => !checkedFolders.has(f.id))
              .map((f) => ({ value: f.id, label: `${f.name}(${f.itemCount} 条)` }))}
            onChange={(v: number) => {
              target = v;
            }}
          />
        </div>
      ),
      okText: mode === 'move' ? '移动' : '也放进',
      cancelText: '算了',
      onOk: () => {
        if (target === null) return Promise.reject(new Error('还没选目标夹子'));
        return act(
          () => workbenchApi[mode]({ fromFolderIds }, target!),
          mode === 'move' ? `已移动 ${totalItems} 条` : `已放入 ${totalItems} 条`,
        ).then((ok) => {
          if (ok) setCheckedFolders(new Set());
        });
      },
    });
  };

  /**
   * 「移动并删除这 N 个夹子」—— 和移动是**同一个动作**,只是多一步删源夹子。
   *
   * 不发明"合并"这种抽象名词:按钮名直接写它干什么(用户提的)。
   * 二次确认这一步是必须的 —— 删夹子不可逆,而且他得在点之前看清楚
   * **到底哪几个会被删**。
   */
  const runMoveAndDelete = () => {
    const fromFolderIds = [...checkedFolders];
    const froms = fromFolderIds
      .map((id) => view?.folders.find((f) => f.id === id))
      .filter((f): f is NonNullable<typeof f> => f !== undefined);
    const totalItems = froms.reduce((n, f) => n + f.itemCount, 0);

    let target: number | null = null;

    modal.confirm({
      title: `移动并删除这 ${froms.length} 个夹子?`,
      width: 460,
      content: (
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 8, lineHeight: 1.7 }}>
            这 {froms.length} 个夹子里的 <b style={{ color: 'var(--text)' }}>{totalItems}</b> 条会先搬进目标夹子,
            然后这些夹子<b style={{ color: 'var(--danger)' }}>被删掉</b>:
          </div>
          <div style={{ maxHeight: 140, overflowY: 'auto', marginBottom: 10 }}>
            {froms.map((f) => (
              <div key={f.id} style={{ fontSize: 12, padding: '2px 0' }}>
                <span style={{ color: 'var(--danger)' }}>🗑 </span>
                {f.name}
                <span className="num" style={{ color: 'var(--text-dim)' }}>({f.itemCount} 条)</span>
                {f.locked && (
                  <span style={{ color: 'var(--warn)' }}> —— 这个是锁定的,只移空、不删</span>
                )}
              </div>
            ))}
          </div>
          <Select
            autoFocus
            showSearch
            optionFilterProp="label"
            placeholder="搬到哪个夹子?(打字可以搜)"
            style={{ width: '100%' }}
            options={(view?.folders ?? [])
              .filter((f) => !checkedFolders.has(f.id))
              .map((f) => ({ value: f.id, label: `${f.name}(${f.itemCount} 条)` }))}
            onChange={(v: number) => {
              target = v;
            }}
          />
        </div>
      ),
      okText: '移动并删除',
      okButtonProps: { danger: true },
      cancelText: '算了',
      onOk: () => {
        if (target === null) return Promise.reject(new Error('还没选目标夹子'));
        return act(
          () => workbenchApi.mergeInto(target!, fromFolderIds),
          `已移动并删除 ${froms.length} 个夹子`,
        ).then((ok) => {
          if (ok) setCheckedFolders(new Set());
        });
      },
    });
  };

  const toggleSelect = (itemId: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });

  /**
   * 按钮按**性质**分三组(用户提的分法):日常常驻 / 批量 / 高危。
   * 组与组之间一条竖线 —— 不是折叠,是让"这是一类"一眼看见。
   *
   * 空组会被过滤掉(批量与高危只在勾了夹子时才有东西),所以不会留下孤立的竖线。
   * 新建夹子是**主操作**,给 primary —— 它不该和旁边那些普通按钮长得一样。
   */
  const hasChecked = checkedFolders.size > 0;
  const BUTTON_GROUPS: ReactNode[][] = [
    [
      <Button
        key="new"
        type="primary"
        icon={<Plus size={14} />}
        onClick={() => {
          let name = '';
          modal.confirm({
            title: '新建夹子',
            content: <Input autoFocus placeholder="夹子名字" onChange={(e) => { name = e.target.value; }} />,
            okText: '新建',
            cancelText: '取消',
            onOk: () => act(() => workbenchApi.createFolder(name), `已新建「${name}」`),
          });
        }}
      >
        新建夹子
      </Button>,
      <Button key="ai" icon={<Bot size={14} />} onClick={() => openWith()}>
        打开 AI 助手
      </Button>,
    ],
    hasChecked
      ? [
          <Button key="move" icon={<MoveRight size={14} />} onClick={() => runOnChecked('move')}>
            移动 {checkedFolders.size} 个夹子
          </Button>,
          <Button key="add" icon={<FolderInput size={14} />} onClick={() => runOnChecked('add')}>
            也放进
          </Button>,
        ]
      : [],
    [
      hasChecked && (
        <Button key="mv-del" danger icon={<FolderX size={14} />} onClick={runMoveAndDelete}>
          移动并删除这 {checkedFolders.size} 个夹子
        </Button>
      ),
      <Button key="reset" danger icon={<Undo2 size={14} />} disabled={!view?.exists} onClick={() =>
        modal.confirm({
          title: '还原到上次同步的样子?',
          content: '会丢掉你在这个页面上做的全部改动。B站 上的东西本来就没被动过。',
          okText: '还原',
          cancelText: '算了',
          onOk: () => act(() => workbenchApi.reset(), '已还原。'),
        })
      }>
        一键还原
      </Button>,
    ],
  ];

  return (
    <div style={{ height: '100%', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span className="hud-label" style={{ color: 'var(--accent)' }}>整理</span>
        <span style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>
          {view?.exists ? `${view.folders.length} 个夹子 · 改动中` : '正在显示 B站 现在的样子 · 还没有自己的改动'}
        </span>
        {/*
          按钮按**性质**分组,组与组之间一条竖线 —— 不是折叠,是让"这是一类"看得见。
          常驻组永远在;批量组和高危组只在勾了夹子时出现(没勾时它们没有可作用的对象),
          所以空组直接不渲染,不留孤零零的竖线。
        */}
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          {BUTTON_GROUPS.map((group, gi) => {
            const shown = group.filter(Boolean);
            if (shown.length === 0) return null;
            return (
              <span key={gi} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {gi > 0 && (
                  <span
                    aria-hidden
                    style={{ width: 1, height: 20, background: 'var(--rule)', flex: 'none' }}
                  />
                )}
                <span style={{ display: 'flex', gap: 6 }}>{shown}</span>
              </span>
            );
          })}
        </span>
      </div>

      {view?.stale && (
        <Alert
          type="warning"
          showIcon
          message="你整理期间收藏夹又同步过 —— 显示的快照可能已经不是最新的,建议先看看差异再继续"
        />
      )}
      {error && <Alert type="error" showIcon closable message={error} onClose={() => setError('')} />}
      {notice && <Alert type="info" showIcon closable message={notice} onClose={() => setNotice('')} />}

      <Tabs
        items={[
          {
            key: 'tree',
            label: '结构',
            children: (
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <div className="hud-panel" style={{ flex: 2, minWidth: 0, padding: 12, maxHeight: 460, overflowY: 'auto' }}>
          {view?.exists ? (
            <>
              <WorkFolderTree
                folders={view.folders}
                removed={view.removed}
                expanded={expanded}
                selected={selected}
                onToggleExpand={toggleExpand}
                onToggleSelect={toggleSelect}
                onRename={(id, name) => void act(() => workbenchApi.renameFolder(id, name))}
                onToggleLock={(originId, locked) => void act(() => setFolderLock(originId, locked))}
                onShowRule={(folderId) => navigate(`/rules?folder=${folderId}`)}
                // mergeInto(into, from):into 在前 —— 传反了就是把目标并进自己
                onMerge={(fromId, intoId) =>
                  void act(() => workbenchApi.mergeInto(intoId, [fromId]), '已合并')
                }
                onDelete={(folderId) =>
                  void act(() => workbenchApi.deleteFolder(folderId), '已删除')
                }
                checked={checkedFolders}
                onToggleCheck={toggleCheckFolder}
                onRemoveSelected={(folderId, itemIds) =>
                  void act(
                    () => workbenchApi.remove(itemIds, folderId),
                    `已从夹子里移出 ${itemIds.length} 条 —— 它们现在是「未归类」`,
                  ).then((ok) => { if (ok) setSelected(new Set()); })
                }
              />
              {/* 列表被截断时必须说出来 —— 否则"看到 500 条"会被当成"就这 500 条",
                  一「移动」就只动了前 500 条。数字说谎比报错更坑。 */}
              {expanded && expanded.total > expanded.items.length && (
                <div style={{ fontSize: 11, color: 'var(--text-dim)', paddingTop: 8 }}>
                  仅显示前 {expanded.items.length} 条,共 {expanded.total} 条 —— 想动剩下的等「搜索与筛选」做完
                </div>
              )}
            </>
          ) : (
            /* 还没有自己的改动 —— 显示 B站 现在的样子(只读)。
               这条分支不能省:没有它首启就是一片空白。 */
            <div>
              <div style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)', marginBottom: 8 }}>
                这是 B站 上现在的结构。改动任意一处就会开始记录你的方案。
              </div>
              {snapshotFolders.map((f) => (
                <div
                  key={f.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '5px 4px', borderBottom: '1px solid var(--rule)',
                  }}
                >
                  {f.locked && (
                    <Lock size={11} style={{ flex: 'none', color: 'var(--warn)' }}>
                      <title>B站 自带的默认收藏夹 —— 不能改名、不能删除,只能移走里面的条目</title>
                    </Lock>
                  )}
                  <span style={{ fontSize: 'var(--fs-13)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {f.title}
                  </span>
                  <span className="num" style={{ marginLeft: 'auto', fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>
                    {f.mediaCount}
                  </span>
                </div>
              ))}
              {snapshotFolders.length === 0 && (
                <div style={{ padding: '14px 4px', color: 'var(--text-dim)', fontSize: 'var(--fs-12)' }}>
                  还没有同步任何收藏夹 —— 先去「总览」同步一次
                </div>
              )}
            </div>
          )}
        </div>

        <div style={{ flex: 1, minWidth: 260, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <OperationLog refreshKey={logKey} />
          {view && view.unassignedCount > 0 && (
            <div className="hud-panel" style={{ padding: 12 }}>
              <span className="hud-label" style={{ color: 'var(--warn)' }}>未归类</span>
              <div className="num" style={{ fontSize: 'var(--fs-18)', color: 'var(--warn)' }}>
                {view.unassignedCount}
              </div>
              <div style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>
                这些条目不属于任何夹子
              </div>
            </div>
          )}
        </div>
      </div>
            ),
          },
        ]}
      />

      <div style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>
        勾**夹子**前面的框 → 顶部出现「移动 / 也放进」;展开夹子可以按条勾选并「移出」。
        夹子行:▸ 展开 · 🔒 锁 · ✎ 改名 · ⊞ 合并 · 🗑 删空夹
      </div>

      <div style={{ height: 56, flex: 'none' }} aria-hidden />
    </div>
  );
}
