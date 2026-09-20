# 浏览合并进标签页 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删掉「浏览」页,其"选词看视频"的能力合并进「标签」页;标签页整页锁死不滚动,滚动只发生在树列和视频区内部。

**Architecture:** 新建 TagItemPane 组件承载"视频列表 + 分页 + 取数"(从 BrowsePanel 右半边搬来,删掉 summary 行和归属 chips),放进 TagPanel 的树右侧;ItemGrid 加可选 `badgesOf` 角标替代"跨词条"信息;「上一轮变化」收进 TagLogDrawer;删 /browse 路由、页面、组件和 nav 项。

**Tech Stack:** umijs/max + React + antd 5 + TypeScript(严格模式)

**Spec:** docs/superpowers/specs/2026-09-20-browse-merge-into-tags-design.md

## Global Constraints

- 所有回复、注释、UI 文案用中文。
- **禁止 AI 自行 git add / git commit** —— 每个任务改完代码、跑完检查即停,工作区保持已改好状态,提交由用户本人完成。所以本计划**没有 commit 步骤**。
- `cd web && npm run build` 的**退出码恒为 1**(既有 esbuild 问题),门禁看输出里的 typecheck + `Compiled successfully`,不看退出码。
- `web/tsconfig.json` 开了 strict —— 对象字面量要显式类型,否则 TS7053 过不了门禁。
- 遵循现有代码风格:内联样式、注释解释"为什么"、lucide-react 图标。
- 后端 API 一个不改。

---

### Task 1: ItemGrid 加 badgesOf 角标与 emptyText

**Files:**
- Modify: `web/src/components/ItemGrid.tsx`
- Modify: `web/src/global.css`

**Interfaces:**
- Consumes: 现有 ItemGrid 的 props 与渲染结构(不传新 props 时行为完全不变)。
- Produces: ItemGrid 新增两个可选 prop:
  - `badgesOf?: Record<string, string[]>` —— item id → 封面左上角要显示的词列表(调用方算好,含 "+N" 项)。
  - `emptyText?: string` —— 空态文案,缺省保持原文案。
  Task 3 的 TagItemPane 依赖这两个 prop;总览页 [index.tsx](../../web/src/pages/index.tsx) 不传它们,行为不变。

- [ ] **Step 1: 改 ItemGrid.tsx —— 加两个可选 prop**

props 签名在 `onSelect` 之后加两个字段:

```tsx
  /** 封面左上角的词角标 —— 调用方算好每条要显示什么(最多 3 个 + "+N") */
  badgesOf?: Record<string, string[]>;
  /** 空态文案 —— 缺省保持原文案(总览页语境) */
  emptyText?: string;
```

空态分支的文案改为:

```tsx
{emptyText ?? '选择左侧收藏夹,或在上方搜索'}
```

封面渲染:在 `.cover-card__thumb` 的 div **内部**(img 之后、`cover-card__meta` 之后),加:

```tsx
{(badgesOf?.[it.id] ?? []).length > 0 && (
  <div className="cover-card__tags">
    {badgesOf![it.id].map((t) => (
      <span key={t} className="cover-card__tag">{t}</span>
    ))}
  </div>
)}
```

放 thumb 内部的理由:thumb 有 `overflow:hidden` 且是 relative,角标盖在封面图上、不占卡片外部空间,卡片高度不变。右上角已被「已失效」角标(卡片级 absolute)占用,词角标走**左上角**避让。

- [ ] **Step 2: global.css 加样式**

`.cover-card__badge` 规则之后加:

```css
/* 词角标(浏览合并进标签页):封面左上角,半透明深底 + accent。
   右上角已被「已失效」角标占用,左上角避让。 */
.cover-card__tags {
  position: absolute;
  top: 6px;
  left: 6px;
  z-index: 2;
  display: flex;
  gap: 4px;
  max-width: calc(100% - 12px);
  overflow: hidden;
}
.cover-card__tag {
  font-size: 11px;
  padding: 1px 5px;
  color: var(--accent);
  border: 1px solid var(--accent);
  background: rgba(14, 14, 23, 0.85);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

- [ ] **Step 3: 验证 —— typecheck**

```bash
cd web && npm run typecheck
```

预期:无错误。

**收尾:不提交,报告改动与验证结果,停在工作区已改好的状态。**

---

### Task 2: TagLogDrawer 加"变化"区块

**Files:**
- Modify: `web/src/components/TagLogDrawer.tsx`

**Interfaces:**
- Consumes: `TreeChange`(types.ts:424:`{ kind: 'merge' | 'reparent'; from: string; to: string; detail: string }`)。
- Produces: TagLogDrawer 新增可选 prop `changes?: TreeChange[]`;抽屉内在日志区**上方**渲染"上一轮变化"清单(未传或空数组时不渲染)。Task 3 的 TagPanel 会传它。

- [ ] **Step 1: 加 props 与区块**

import 行加 `TreeChange`:

```tsx
import type { TagLogLine, TreeChange } from '../types';
```

props 加:

```tsx
  /** 「上一轮变化」清单 —— 收进抽屉(浏览合并进标签页),顶部不再放独立面板 */
  changes?: TreeChange[];
```

在滚动日志区(`div ref={scrollRef}`)之前加:

```tsx
{changes && changes.length > 0 && (
  <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--rule)', flex: 'none' }}>
    <div className="hud-label" style={{ marginBottom: 6, color: 'var(--accent)' }}>上一轮变化</div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 'var(--fs-12)', maxHeight: 180, overflowY: 'auto' }}>
      {changes.map((c, i) => (
        <div key={i} style={{ display: 'flex', gap: 8 }}>
          <span style={{ color: c.kind === 'merge' ? 'var(--ok)' : 'var(--accent)', flex: 'none' }}>
            {c.kind === 'merge' ? '→' : '↑'}
          </span>
          <span>{c.from}{c.to ? ` → ${c.to}` : ''}</span>
          <span style={{ color: 'var(--text-dim)' }}>{c.detail}</span>
        </div>
      ))}
    </div>
  </div>
)}
```

- [ ] **Step 2: 验证 —— typecheck**

```bash
cd web && npm run typecheck
```

预期:无错误。

**收尾:不提交,报告改动与验证结果。**

---

### Task 3: TagItemPane + TagPanel 三列锁死布局

**Files:**
- Create: `web/src/components/TagItemPane.tsx`
- Modify: `web/src/components/TagPanel.tsx`
- Modify: `web/src/pages/tag.tsx`

**Interfaces:**
- Consumes: Task 1 的 ItemGrid 新 props(`badgesOf` / `emptyText`)、Task 2 的 TagLogDrawer `changes` prop、现有 `tagApi.items` / `tagApi.tree`、`ContextPane`、`TagTree`。
- Produces: `TagItemPane`,props = `{ tagId: number | null; selectedId: string | null; excludeTag: string | null; onSelect: (item: Item) => void; onTagsOf: (tags: string[]) => void }`。TagPanel 变成:顶栏(AI 标注横栏,flex:none)+ 行容器(树列 300px 内滚 | TagItemPane 内滚 | ContextPane 268px),整页锁死。

**实现方式:以 [BrowsePanel.tsx](../../web/src/components/BrowsePanel.tsx) 全文为模板搬代码** —— 它就是这套逻辑(取数、分页、tagsOf、ContextPane 喂数)的现成实现,不要凭空写。下面只列差异,没列到的照抄。

- [ ] **Step 1: 新建 TagItemPane.tsx**

复制 BrowsePanel.tsx 全文为起点,然后:

1. **删**:左侧树面板(hud-panel width 300 那块)、`expanded` / `icon`、`tree` 的 useRequest、`findName` 函数、顶部 summary 行(「xxx 连同它下面的词…」)、归属 chips 区块、底部 56px 占位、`useSearchParams`。
2. **props 改为**:

```tsx
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
```

3. **保留**:PAGE_SIZE = 60;`items` 的 useRequest(catch 里 `setError` + 返回 EMPTY,refreshDeps `[tagId, page]`);`page` state;`error` state + Alert。**EMPTY 的显式类型保留四字段**(`items/total/foldersOf/tagsOf`)—— `data?.tagsOf` 还要读,foldersOf 声明着不读,收窄成两字段反而引 TS2339。
4. **加三个小逻辑**:

```tsx
// 切词页码归零 —— 不归的话从"有 5 页的词"跳到"只有 1 页的词",画面是空的
useEffect(() => { setPage(1); }, [tagId]);

// 选中变化时把详情栏要的 tags 上报给父层(无选中报空数组)
useEffect(() => {
  onTagsOf(selectedId ? (data?.tagsOf ?? {})[selectedId] ?? [] : []);
}, [selectedId, data]);  // eslint-disable-line react-hooks/exhaustive-deps

// 角标内容:其他词(排除当前词),最多 3 个,超出补 +N
const tagsOf = data?.tagsOf ?? {};
const badgesOf: Record<string, string[]> = {};
for (const it of data?.items ?? []) {
  const others = (tagsOf[it.id] ?? []).filter((t) => t !== excludeTag);
  badgesOf[it.id] = others.slice(0, 3).concat(others.length > 3 ? [`+${others.length - 3}`] : []);
}
```

5. **返回 JSX**(结构从 BrowsePanel 右列改来,注意容器尺寸全变了):

```tsx
<div style={{ flex: 1, minWidth: 0, height: '100%', overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: 10 }}>
  {error && <Alert type="error" showIcon closable message={error} onClose={() => setError('')} />}
  {tagId === null ? (
    <div className="hud-panel" style={{ padding: '48px 20px', textAlign: 'center', color: 'var(--text-dim)', fontSize: 'var(--fs-13)' }}>
      左边选一个词
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
```

- [ ] **Step 2: TagPanel.tsx 改三列锁死布局**

按点改,不重写全文(行号按当前文件):

1. **删「上一轮变化」hud-panel 区块**(现 750-774 行)。`changes` 数据改传日志抽屉:`<TagLogDrawer ... changes={changes?.changes ?? []} />`。
2. **根 div** 从 `display:'flex', flexDirection:'column', gap:12` 改为 `flex:1, minHeight:0, overflow:'hidden', display:'flex', flexDirection:'column', gap:12`(整页锁死从这层开始)。
3. **AI 标注面板**外层 div 加 `flex:'none'`(横栏锁顶)。
4. 面板下加**行容器**,包住三列:

```tsx
<div style={{ display: 'flex', gap: 12, flex: 1, minHeight: 0, alignItems: 'stretch' }}>
  {/* 树列 */} {/* TagItemPane */} {/* ContextPane */}
</div>
```

5. **树列**(原「词库」hud-panel 移进行容器内):`width:300, flex:'none', padding:12, display:'flex', flexDirection:'column', overflow:'hidden'`;头部行(「词库」标题 + 词数 + 健康度 stats + 清除按钮)加 `flex:'none'`;TagTree 包进 `<div style={{ flex:1, minHeight:0, overflowY:'auto' }}>` —— **树自己滚,不顶飞别的模块**。头部加清除按钮(选中时显示):`onClick={() => { setSelectedItem(null); setParams({}); }}`,样式照 BrowsePanel 现有的清除按钮(无边框透明小字)。
6. **树加选中**(从 BrowsePanel 搬,放在组件顶部 state 区):
   - `const [params, setParams] = useSearchParams();` + `const tagId = Number(params.get('tag')) || null;`(import `useSearchParams` from '@umijs/max')
   - `const [selectedItem, setSelectedItem] = useState<Item | null>(null);`(import type `Item` from '../types')
   - `const pick = (id: number) => { setSelectedItem(null); setParams({ tag: String(id) }); };` —— 页码归零由 TagItemPane 自己的 useEffect 做,这里不管。
   - TagTree 加 `selectedId={tagId}` 和 `onSelect={pick}`(renderActions 保留,治理操作不受影响)。
   - 把 BrowsePanel 的 `findName` 函数整个搬过来(文件底部),`const currentTagName = tree?.tree ? findName(tree.tree, tagId) : null;`
7. **中列**:

```tsx
<TagItemPane
  tagId={tagId}
  selectedId={selectedItem?.id ?? null}
  excludeTag={currentTagName}
  onSelect={setSelectedItem}
  onTagsOf={setSelectedItemTags}
/>
```

`const [selectedItemTags, setSelectedItemTags] = useState<string[]>([]);`
8. **右列**:`<ContextPane item={selectedItem} tags={selectedItemTags} />`(原来那份 tags 逻辑删掉)。
9. TagLogDrawer 的调用照旧,加 `changes={changes?.changes ?? []}`。

- [ ] **Step 3: tag.tsx 页面容器**

外层 div 从 `overflowY:'auto'` 改为 `overflow:'hidden'`;删底部 56px 占位 div;`<TagPanel />` 外不再需要别的包裹(TagPanel 根自带 `flex:1, minHeight:0`)。头部那行「标签」说明保留。

- [ ] **Step 4: 验证 —— typecheck**

```bash
cd web && npm run typecheck
```

预期:无错误。

**收尾:不提交,报告改动与验证结果。**

---

### Task 4: 删浏览页

**Files:**
- Delete: `web/src/pages/browse.tsx`
- Delete: `web/src/components/BrowsePanel.tsx`
- Modify: `web/.umirc.ts`
- Modify: `web/src/layouts/index.tsx`

**Interfaces:**
- Consumes: Task 3 完成后标签页已承载浏览能力。
- Produces: 全站无 /browse、BrowsePanel 引用。

- [ ] **Step 1: 删两个文件**(用 `rm`,不走 `git rm` —— 暂存留给用户)

```bash
rm web/src/pages/browse.tsx web/src/components/BrowsePanel.tsx
```

- [ ] **Step 2: .umirc.ts** 删路由行 `{ path: '/browse', component: 'browse' },`

- [ ] **Step 3: layouts/index.tsx** 删 nav 数组里的 `{ to: '/browse', label: '浏览', en: 'BROWSE', icon: Compass },` 和 import 里的 `Compass`。

- [ ] **Step 4: 全局搜残留**

```bash
grep -rn "Browse\|'/browse'" web/src web/.umirc.ts
```

预期:无代码引用(UI 文案里"浏览"二字不算,搜的是标识符和路由串)。

- [ ] **Step 5: 验证**

```bash
cd web && npm run typecheck && npm run build
```

预期:typecheck 无错误;build 输出有 `Compiled successfully`(退出码 1 忽略,既有问题)。

**收尾:不提交,报告改动与验证结果。**

---

### Task 5: 终检

**Files:** 无代码改动,只验证 + 修漏。

- [ ] **Step 1: typecheck + build**

```bash
cd web && npm run typecheck && npm run build
```

预期:typecheck 零错误;build 输出 `Compiled successfully`(退出码 1 是既有 esbuild 问题,忽略)。

- [ ] **Step 2: 手动过一遍(用户配合)**

`cd web && npm run dev`,确认:

1. 标签页整页不滚:树往下滚时,顶部标注横栏和右边视频区纹丝不动。
2. 选词 → 右侧出视频墙,分页正常;没选词 → "左边选一个词"。
3. 点封面 → 详情栏出内容;角标显示其他词(排除当前词,最多 3 个 + 超出 +N)。
4. 日志抽屉里有"上一轮变化"区块;顶部无独立变化面板。
5. nav 里没有「浏览」;`/browse` 打不开。
6. 标注/质检流程(启动/进度/停止/日志)不受影响。
7. 总览页照旧:无角标、空态文案原样。

**收尾:不提交。报告结果,把提交留给用户。**
