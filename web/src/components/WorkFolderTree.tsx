import { useState } from 'react';
import { App as AntApp, Button, Select } from 'antd';
import { ChevronRight, ChevronDown, Lock, Pencil, Check, X, Combine, Trash2, SlidersHorizontal } from 'lucide-react';
import type { ChangeMark, Item, RemovedFolder, RuleView, WorkFolderView } from '../types';
import FolderRuleSection from './FolderRuleSection';

/**
 * 一份结构(spec §9B.5)。
 *
 * **夹子和条目在视觉上是两种东西**:夹子是分组的头(可改名/合并/删除),
 * 条目在组里(只能移动)。让它们长得一样,人会以为条目也能改名。
 *
 * 改动标记是**算出来的**,点开能看原值 —— 每个标记都能展开,不能有的能有的不能。
 */
const MARK: Record<ChangeMark, { glyph: string; color: string; label: string } | null> = {
  unchanged: null,
  renamed: { glyph: '✎', color: 'var(--accent)', label: '改名' },
  created: { glyph: '✚', color: 'var(--ok)', label: '新建' },
  merged: { glyph: '⇥', color: 'var(--special)', label: '已并入别处' },
  removed: { glyph: '✖', color: 'var(--danger)', label: '已删除' },
};

export default function WorkFolderTree({
  folders,
  removed,
  expanded,
  selected,
  onToggleExpand,
  onToggleSelect,
  onRename,
  onToggleLock,
  onToggleRule,
  onRuleChanged,
  onMerge,
  onDelete,
  onRemoveSelected,
  checked,
  onToggleCheck,
  outliersByFolder,
  rules,
  ruleOpenId,
  tagNameOf,
  tagTree,
  busy,
}: {
  folders: WorkFolderView[];
  removed: RemovedFolder[];
  expanded: { folderId: number; items: Item[] } | null;
  selected: Set<string>;
  onToggleExpand: (folderId: number) => void;
  onToggleSelect: (itemId: string) => void;
  onRename: (folderId: number, name: string) => void;
  onToggleLock: (originId: number, locked: boolean) => void;
  /** 点夹子行规则按钮:就地展开/收起该行的规则区(不再跳 /rules) */
  onToggleRule: (folderId: number) => void;
  /** 规则区任一改动成功后 —— 重拉 rules + workbench 视图 */
  onRuleChanged: () => void;
  onMerge: (fromId: number, intoId: number) => void;
  onDelete: (folderId: number) => void;
  onRemoveSelected: (folderId: number, itemIds: string[]) => void;
  /**
   * 夹子 id → 和它不搭的条目 id(§9F C14)。
   *
   * 由 `curator.tsx` 从 `/api/workbench` 的 `profiles` 按 folderId 摊平 ——
   * 这里只负责画那个 ⚠,**不自动移任何东西**(画像是镜子不是裁判,§9F.6)。
   */
  outliersByFolder: ReadonlyMap<number, readonly string[]>;
  /**
   * 被勾中的夹子 —— 它们是「移动 / 也放进」的**源**。
   *
   * 勾的是夹子而不是条目:真实库 64 个夹子、默认收藏夹一个就 2864 条,
   * 按条目挑根本没法用。目标在点了按钮之后再选(见 curator.tsx)。
   */
  checked: Set<number>;
  onToggleCheck: (folderId: number) => void;
  /** 每条夹子对应的规则视图(没规则的夹子拿不到条目) */
  rules: RuleView[];
  /** 展开规则区的夹子 id —— 由 curator 统一管理(采纳/改一下后定位展开) */
  ruleOpenId: number | null;
  tagNameOf: Map<number, string>;
  tagTree: { id: number; name: string }[];
  busy: boolean;
}) {
  const ruleViewOf = new Map(rules.map((r) => [r.folderId, r]));
  return (
    <div>
      {folders.map((f) => (
        <FolderRow
          key={f.id}
          folder={f}
          allFolders={folders}
          open={expanded?.folderId === f.id}
          items={expanded?.folderId === f.id ? expanded.items : []}
          selected={selected}
          onToggleExpand={onToggleExpand}
          onToggleSelect={onToggleSelect}
          onRename={onRename}
          onToggleLock={onToggleLock}
          onToggleRule={onToggleRule}
          onRuleChanged={onRuleChanged}
          onMerge={onMerge}
          onDelete={onDelete}
          onRemoveSelected={onRemoveSelected}
          checked={checked}
          onToggleCheck={onToggleCheck}
          outliersByFolder={outliersByFolder}
          ruleView={ruleViewOf.get(f.id) ?? null}
          ruleOpen={ruleOpenId === f.id}
          tagNameOf={tagNameOf}
          tagTree={tagTree}
          busy={busy}
        />
      ))}

      {removed.length > 0 && (
        <div style={{ marginTop: 14, paddingTop: 10, borderTop: '1px solid var(--rule)' }}>
          <span className="hud-label">已不在新结构里的夹子</span>
          {removed.map((r) => {
            const m = MARK[r.mark]!;
            return (
              <div
                key={r.id}
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 8,
                  padding: '5px 4px',
                  color: 'var(--text-dim)',
                  textDecoration: 'line-through',
                }}
              >
                <span style={{ color: m.color, textDecoration: 'none' }}>{m.glyph}</span>
                <span>{r.name}</span>
                <span style={{ fontSize: 11 }}>
                  {r.intoName ? `→ 并入「${r.intoName}」` : `${r.itemCount} 条已移出`}
                </span>
                <span className="num" style={{ marginLeft: 'auto', fontSize: 'var(--fs-12)' }}>
                  {r.itemCount}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function FolderRow({
  folder,
  allFolders,
  open,
  items,
  selected,
  onToggleExpand,
  onToggleSelect,
  onRename,
  onToggleLock,
  onToggleRule,
  onRuleChanged,
  onMerge,
  onDelete,
  onRemoveSelected,
  checked,
  onToggleCheck,
  outliersByFolder,
  ruleView,
  ruleOpen,
  tagNameOf,
  tagTree,
  busy,
}: {
  folder: WorkFolderView;
  allFolders: WorkFolderView[];
  open: boolean;
  items: Item[];
  selected: Set<string>;
  onToggleExpand: (folderId: number) => void;
  onToggleSelect: (itemId: string) => void;
  onRename: (folderId: number, name: string) => void;
  onToggleLock: (originId: number, locked: boolean) => void;
  /** 点夹子行规则按钮:就地展开/收起该行的规则区(不再跳 /rules) */
  onToggleRule: (folderId: number) => void;
  /** 规则区任一改动成功后 —— 重拉 rules + workbench 视图 */
  onRuleChanged: () => void;
  onMerge: (fromId: number, intoId: number) => void;
  onDelete: (folderId: number) => void;
  onRemoveSelected: (folderId: number, itemIds: string[]) => void;
  checked: Set<number>;
  onToggleCheck: (folderId: number) => void;
  outliersByFolder: ReadonlyMap<number, readonly string[]>;
  ruleView: RuleView | null;
  ruleOpen: boolean;
  tagNameOf: Map<number, string>;
  tagTree: { id: number; name: string }[];
  busy: boolean;
}) {
  // 静态 Modal.confirm 拿不到 ConfigProvider 的主题,用 App.useApp() 这套
  const { modal } = AntApp.useApp();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(folder.name);
  const mark = MARK[folder.mark];

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== folder.name) onRename(folder.id, next);
    else setDraft(folder.name);
  };

  const others = allFolders.filter((f) => f.id !== folder.id);
  const outliers = outliersByFolder.get(folder.id) ?? [];
  const selectedHere = items.filter((it) => selected.has(it.id)).length;

  /**
   * 合并 —— 把**当前这个**(from)并进另一个(into)。
   *
   * 目标用 Select 现选,选之前「合并」是禁着的:少了这一步,用户点确定会毫无反应,
   * 而"点了没反应"比报错更难查。
   */
  const confirmMerge = () => {
    let targetId: number | null = null;
    const inst = modal.confirm({
      title: `把「${folder.name}」并进别的夹子?`,
      content: (
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 6 }}>
            里面的 {folder.itemCount} 条会一起搬过去,之后这个夹子就不在了。
          </div>
          <Select
            autoFocus
            // 64 个夹子靠翻列表找不动 —— 必须能打字搜
            showSearch
            optionFilterProp="label"
            placeholder="并进哪个夹子(打字可以搜)"
            style={{ width: '100%' }}
            options={others.map((f) => ({ value: f.id, label: `${f.name}(${f.itemCount} 条)` }))}
            onChange={(v: number) => {
              targetId = v;
              inst.update({ okButtonProps: { disabled: false } });
            }}
          />
        </div>
      ),
      okText: '合并',
      cancelText: '算了',
      okButtonProps: { disabled: true },
      onOk: () => {
        if (targetId !== null) onMerge(folder.id, targetId);
      },
    });
  };

  /** 删除 —— 只对空夹开放(后端也会拒),否则用户会拿它当"连条目一起扔掉" */
  const confirmDelete = () =>
    modal.confirm({
      title: `从方案里删掉「${folder.name}」?`,
      content: '它现在是空的,没有条目会跟着丢。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '算了',
      onOk: () => onDelete(folder.id),
    });

  return (
    <div style={{ borderBottom: '1px solid var(--rule)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 4px' }}>
        {/*
          夹子级的勾选 —— 它是「移动 / 也放进」的**源**。
          勾条目太细(默认收藏夹一个就 2864 条),按夹子挑才是真实用法。
          锁定的夹子也能勾:往里移不许,但**往外移是允许的**,而且那正是
          清空默认收藏夹的办法。
        */}
        <input
          type="checkbox"
          checked={checked.has(folder.id)}
          onChange={() => onToggleCheck(folder.id)}
          // 锁定的(默认收藏夹)勾不了。
          //
          // 一开始我让它能勾、只是"不删只移空",理由是"它有 88% 的条目,
          // 得能批量清空" —— 那个理由站不住:默认收藏夹里的东西要的是
          // **分类**(Pass 2 / 手挑),不是整体倒进另一个夹子(那只是换个地方堆)。
          // 而"清空一个文件夹"作为独立目标,本来就不在能力清单里。
          // 所以直接不给勾 —— 少一套"锁定的也能勾"的特殊规则少一个名词。
          disabled={folder.locked}
          title={
            folder.locked
              ? 'B站 自带的默认收藏夹 —— 不能改名、不能删除,也不能整夹子搬走。里面的条目请展开后单独挑'
              : undefined
          }
          aria-label={`选择夹子「${folder.name}」(${folder.itemCount} 条)`}
          style={{ flex: 'none', margin: 0, cursor: folder.locked ? 'not-allowed' : 'pointer' }}
        />
        <button
          type="button"
          aria-label={open ? '收起' : '展开'}
          aria-expanded={open}
          onClick={() => onToggleExpand(folder.id)}
          style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-dim)' }}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>

        {/* 锁图标既是标识也是开关。只对快照里来的夹子给(新建的不继承锁)。
            自动判定只有一个账号的样本,猜错了你自己改回来。 */}
        {folder.originId !== null && (
          <button
            type="button"
            aria-label={`${folder.locked ? '解锁' : '锁定'}「${folder.name}」`}
            title={
              folder.locked
                ? '不能改名 / 不能删除,只能移走里面的条目。点击解锁'
                : '点击锁定(默认收藏夹这类不可改名/删除的夹子)'
            }
            onClick={() => onToggleLock(folder.originId as number, !folder.locked)}
            style={{
              flex: 'none', display: 'grid', placeItems: 'center', padding: 0,
              border: 'none', background: 'none', cursor: 'pointer',
              color: folder.locked ? 'var(--warn)' : 'var(--text-dim)',
              opacity: folder.locked ? 1 : 0.3,
            }}
          >
            <Lock size={11} />
          </button>
        )}

        {editing ? (
          <>
            <input
              autoFocus
              aria-label={`重命名「${folder.name}」`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit();
                if (e.key === 'Escape') { setDraft(folder.name); setEditing(false); }
              }}
              style={{
                flex: 1, minWidth: 0, font: 'inherit', fontSize: 'var(--fs-13)',
                background: 'var(--surface-2)', color: 'var(--text)',
                border: '1px solid var(--accent)', padding: '1px 5px',
              }}
            />
            <button type="button" aria-label="确认" onClick={commit}
              style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--ok)' }}>
              <Check size={13} />
            </button>
            <button type="button" aria-label="取消" onClick={() => { setDraft(folder.name); setEditing(false); }}
              style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-dim)' }}>
              <X size={13} />
            </button>
          </>
        ) : (
          <>
            <span style={{ fontSize: 'var(--fs-13)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {folder.name}
            </span>

            {/* 来源图标(spec §7):🤖 = AI 建 / ✎ = 用户建。锁定的默认夹不显示 */}
            {!folder.locked && (
              <span
                role="img"
                aria-label={folder.ai ? 'AI 建的夹子' : '你建的夹子'}
                title={folder.ai ? 'AI 建的夹子 —— 规则只读,走建议通道' : '你建的夹子'}
                style={{ fontSize: 11, color: 'var(--text-dim)', flex: 'none', cursor: 'help' }}
              >
                {folder.ai ? '🤖' : '✎'}
              </span>
            )}

            {mark && (
              <span
                role="img"
                aria-label={
                  folder.mark === 'renamed' && folder.originName
                    ? `已改名,原来是「${folder.originName}」`
                    : mark.label
                }
                title={
                  folder.mark === 'renamed' && folder.originName
                    ? `原来是「${folder.originName}」`
                    : mark.label
                }
                style={{ fontSize: 11, color: mark.color, flex: 'none', cursor: 'help' }}
              >
                {mark.glyph}
                {folder.mark === 'renamed' && folder.originName && (
                  <span style={{ color: 'var(--text-dim)' }}> ← 「{folder.originName}」</span>
                )}
              </span>
            )}

            {/* §9F C14:这个夹子里有几条和其余内容对不上(零参数判据 —— 它每个标签
                在夹子里都没有同伴)。点开能看是哪几条,不自动改任何东西 */}
            {outliers.length > 0 && (
              <span
                role="img"
                aria-label={`${outliers.length} 条可能放错了`}
                title={`${outliers.length} 条可能放错了:${outliers.slice(0, 3).join('、')}${outliers.length > 3 ? ' …' : ''}`}
                style={{ fontSize: 11, color: 'var(--warn)', flex: 'none', cursor: 'help' }}
              >
                ⚠
              </span>
            )}

            {/* 规则区开关 —— 就地展开/收起这一行的规则,不再跳 /rules(spec §7) */}
            <button
              type="button"
              aria-label={ruleOpen ? `收起「${folder.name}」的规则` : `展开「${folder.name}」的规则`}
              title={ruleOpen ? '收起规则区' : '展开规则区'}
              onClick={() => onToggleRule(folder.id)}
              style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-dim)', opacity: 0.5 }}
            >
              <SlidersHorizontal size={11} />
            </button>

            {/* 锁定的夹子不给改名入口 —— 点了服务端也会拒,不如别给。
                合并 / 删除同理:它们都会改到那个夹子的名字或存在,而写回 B站
                时必然被拒(§9B.7 约束 4)。 */}
            {!folder.locked && (
              <>
                <button
                  type="button"
                  aria-label={`重命名「${folder.name}」`}
                  onClick={() => setEditing(true)}
                  style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-dim)', opacity: 0.5 }}
                >
                  <Pencil size={11} />
                </button>
                {/* 没有别的夹子可并时不给入口 —— 否则点开一个下拉是空的对话框 */}
                {others.length > 0 && (
                  <button
                    type="button"
                    aria-label={`把「${folder.name}」并进别的夹子`}
                    title="并进别的夹子(里面的条目会一起搬过去)"
                    onClick={confirmMerge}
                    style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-dim)', opacity: 0.5 }}
                  >
                    <Combine size={11} />
                  </button>
                )}
                {/* 非空夹不给删 —— 后端也会拒(条目没法表达"去哪了"),不如在这里就说清 */}
                <button
                  type="button"
                  disabled={folder.itemCount > 0}
                  aria-label={`删除「${folder.name}」`}
                  title={
                    folder.itemCount > 0
                      ? `还有 ${folder.itemCount} 条,先把它们移走`
                      : '从方案里删掉这个空夹子'
                  }
                  onClick={confirmDelete}
                  style={{
                    border: 'none', background: 'none', padding: 0,
                    cursor: folder.itemCount > 0 ? 'not-allowed' : 'pointer',
                    color: 'var(--text-dim)', opacity: folder.itemCount > 0 ? 0.15 : 0.5,
                  }}
                >
                  <Trash2 size={11} />
                </button>
              </>
            )}

            <span className="num" style={{ marginLeft: 'auto', fontSize: 'var(--fs-12)', color: 'var(--text-dim)', flex: 'none' }}>
              {folder.itemCount}
            </span>
          </>
        )}
      </div>

      {open && (
        <div style={{ paddingLeft: 24, paddingBottom: 6 }}>
          {/* 规则区:夹子行展开后的第一段 —— 规则从此住在树里(spec §7) */}
          {ruleView && (
            <FolderRuleSection
              view={ruleView}
              tagNameOf={tagNameOf}
              tagTree={tagTree}
              busy={busy}
              editable={!folder.locked && !folder.ai}
              onChanged={onRuleChanged}
            />
          )}
          {/* 「移走」需要的是**源夹子**,不是目标 —— 所以它在展开区里,而不是在
              顶上的动作条里。动作条上只有"移动 / 也放进"(那两个才是选目标)。 */}
          {items.length > 0 && (
            <div style={{ padding: '4px 0 6px' }}>
              <Button
                size="small"
                disabled={selectedHere === 0}
                onClick={() => onRemoveSelected(folder.id, items.filter((it) => selected.has(it.id)).map((it) => it.id))}
              >
                把勾选的 {selectedHere} 条从「{folder.name}」移出
              </Button>
            </div>
          )}
          {items.map((it) => (
            <label
              key={it.id}
              style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '3px 0', fontSize: 'var(--fs-12)', cursor: 'pointer' }}
            >
              <input
                type="checkbox"
                checked={selected.has(it.id)}
                onChange={() => onToggleSelect(it.id)}
                aria-label={`选择「${it.title}」`}
              />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {it.title}
              </span>
            </label>
          ))}
          {items.length === 0 && (
            <div style={{ color: 'var(--text-dim)', fontSize: 'var(--fs-12)', padding: '4px 0' }}>
              这个夹子是空的
            </div>
          )}
        </div>
      )}
    </div>
  );
}
