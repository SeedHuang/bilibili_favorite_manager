import { useState } from 'react';
import { Alert, App as AntApp, Select, Spin } from 'antd';
import { Combine, Pencil, Check, X, Trash2 } from 'lucide-react';
import { useRequest } from '@umijs/max';
import { rawResult, tagApi } from '../api';
import type { TagNode } from '../types';
import TagTree from './TagTree';

/**
 * 词库治理 —— 三层:顶上「树的变化」清单、中间那棵树、行内操作。
 *
 * **这一页不做自动整理** —— 整理在标注跑完时自动发生(§9F C10)。这里只有
 * "看它变成了什么"和"手动纠正"。用户的原话是"我不想管",所以不设审批闸;
 * 但结构必须**看得见**在长什么,这一页就是那个"看得见"。
 */
export default function TagPanel() {
  // **拉挂了必须出声**(和「规则」页那棵树的取法一致)。少了 onError,一次 500
  // 或后端没起来渲染出来的就是下面那句"词库还是空的。去「规则」页点一次「AI 标注」"
  // —— 建议的补救是一次**全库 LLM 跑**,而库根本没坏。空词库和"没拉到"长得一样,
  // 是这两件事里唯一不能忍的那件。
  const { data: tree, loading, error: treeError, refresh: refreshTree } = useRequest(
    () => tagApi.tree(),
    { formatResult: rawResult, onError: (e) => setError(e.message) },
  );
  // 变化清单跟着树一起刷 —— 手动合并/删除也会改变"上一轮变化"的读法,
  // 只挂载时拉一次的话,你改完词库回头看顶部那块,数字还是旧的
  const { data: changes, refresh: refreshChanges } = useRequest(() => tagApi.changes(), {
    formatResult: rawResult,
  });
  // 静态 Modal.confirm 拿不到 ConfigProvider 的主题,必须走 App.useApp()
  const { modal } = AntApp.useApp();

  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');

  /** 写操作的统一外壳:清错误 → 忙 → 执行 → 重拉 → 失败报错。返回成功与否 */
  const act = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setError('');
    setBusy(true);
    try {
      await fn();
      await Promise.all([refreshTree(), refreshChanges()]);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: number) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /**
   * **没有"新建词"入口** —— 这是刻意的。
   *
   * 词库靠标注自己长(§9F C5),用户说过"我不想管标注 tag 的事情"。手动建的词
   * 没有视频挂它,在树上就是一个 count=0 的孤点,只会让画面变脏。真要加一个领域,
   * 正确做法是去「规则」页加一条规则把它喂出来。
   *
   * 手动操作只留三件**纠正**的事:改名(模型的写法不对)、合并(重复了)、
   * 删除(那是个泛词)。它们都是"把已经长歪的掰回来"。
   */

  /**
   * 合并 —— 目标用 Select 现选,选之前「合并」是禁着的。
   * 少了这一步,用户点确定会毫无反应,而"点了没反应"比报错更难查。
   */
  const confirmMerge = (node: TagNode, flat: TagNode[]) => {
    let targetId: number | null = null;
    const others = flat.filter((n) => n.id !== node.id);
    const inst = modal.confirm({
      title: `把「${node.name}」并进哪个词?`,
      content: (
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 6 }}>
            挂着它的 {node.count} 条视频会一起改挂过去,之后这个词就不在了。
            它的旧名字会记进别名表 —— 下次模型再吐「{node.name}」也认得出。
          </div>
          <Select
            autoFocus
            showSearch
            optionFilterProp="label"
            placeholder="并进哪个词(打字可以搜)"
            style={{ width: '100%' }}
            options={others.map((n) => ({ value: n.id, label: `${n.name}(${n.count} 条)` }))}
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
        // 抄进 const 再判空 —— `targetId` 是在 onChange 那个嵌套闭包里改的 let,
        // TS 不会把外层的 `!== null` 收窄带进下面这个箭头里(抄一次就带得进来)
        const target = targetId;
        if (target !== null) act(() => tagApi.merge(node.id, target));
      },
    });
  };

  /**
   * 删除确认。**这两句都要说,而且各按各的条件** ——
   *
   * ① `deleteTag` 把子节点的 `parent_id` 置 NULL,所以它们是**回到顶层**,不是
   *    "提到上一级"(后者只在删根的时候碰巧成立)。原来的文案说的是一句代码没做的事。
   * ② 它自己的视频会掉标签这件事,和有没有子节点**无关** —— 原来写成三元的
   *    else 分支,于是"有子节点 且 有其他视频挂着它"时用户从未被告知后半句。
   */
  const confirmDelete = (node: TagNode) =>
    modal.confirm({
      title: `从词库里删掉「${node.name}」?`,
      content: [
        node.children.length > 0
          ? `它下面还有 ${node.children.length} 个词,那些词会回到顶层(不是它的上一级),不会被删。`
          : '',
        node.count > 0 ? `挂着它的 ${node.count} 条视频会失去这个标签,视频本身不会动。` : '',
      ].join(''),
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '算了',
      onOk: () => act(() => tagApi.remove(node.id)),
    });

  // 把树摊平 —— 合并的目标选择要跨层级搜,不能只在同级里挑
  const flat: TagNode[] = [];
  const walk = (nodes: TagNode[]) => { for (const n of nodes) { flat.push(n); walk(n.children); } };
  walk(tree?.tree ?? []);

  const actions = (node: TagNode) =>
    editing === node.id ? (
      <>
        <input
          autoFocus
          aria-label={`重命名「${node.name}」`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { setEditing(null); if (draft.trim()) void act(() => tagApi.update(node.id, { name: draft.trim() })); }
            if (e.key === 'Escape') setEditing(null);
          }}
          style={{
            flex: 1, minWidth: 0, font: 'inherit', fontSize: 'var(--fs-13)',
            background: 'var(--surface-2)', color: 'var(--text)',
            border: '1px solid var(--accent)', padding: '1px 5px',
          }}
        />
        <button type="button" aria-label="确认"
          onClick={() => { setEditing(null); if (draft.trim()) void act(() => tagApi.update(node.id, { name: draft.trim() })); }}
          style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--ok)', lineHeight: 0 }}>
          <Check size={13} />
        </button>
        <button type="button" aria-label="取消" onClick={() => setEditing(null)}
          style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--text-dim)', lineHeight: 0 }}>
          <X size={13} />
        </button>
      </>
    ) : (
      <>
        <button type="button" aria-label={`重命名「${node.name}」`}
          onClick={() => { setEditing(node.id); setDraft(node.name); }}
          style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-dim)', opacity: 0.5, lineHeight: 0 }}>
          <Pencil size={11} />
        </button>
        {flat.length > 1 && (
          <button type="button" aria-label={`把「${node.name}」并进别的词`}
            title="并进别的词(挂着它的视频会一起改挂过去)"
            onClick={() => confirmMerge(node, flat)}
            style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-dim)', opacity: 0.5, lineHeight: 0 }}>
            <Combine size={11} />
          </button>
        )}
        <button type="button" aria-label={`删除「${node.name}」`}
          title={node.children.length > 0 ? '它下面的词会回到顶层' : '从词库里删掉这个词'}
          onClick={() => confirmDelete(node)}
          style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer', color: 'var(--text-dim)', opacity: 0.5, lineHeight: 0 }}>
          <Trash2 size={11} />
        </button>
      </>
    );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {error && <Alert type="error" showIcon closable message={error} onClose={() => setError('')} />}

      <div className="hud-panel" style={{ padding: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <span className="hud-label">上一轮变化</span>
          <span style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>
            每轮标注跑完自动整理一次,结果是这些 —— 不需要你确认
          </span>
        </div>
        {(changes?.changes ?? []).length === 0 ? (
          <div style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>
            还没有跑过标注,或者上一轮什么都没变
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 'var(--fs-12)' }}>
            {changes!.changes.map((c, i) => (
              <div key={i} style={{ display: 'flex', gap: 8 }}>
                <span style={{ color: c.kind === 'merge' ? 'var(--ok)' : 'var(--accent)', flex: 'none' }}>
                  {c.kind === 'merge' ? '→' : '↑'}
                </span>
                <span>{c.from}{c.to ? ` → ${c.to}` : ''}</span>
                <span style={{ color: 'var(--text-dim)' }}>{c.detail}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="hud-panel" style={{ padding: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <span className="hud-label">词库</span>
          <span className="num" style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>
            {tree?.total ?? 0} 个词
          </span>
          {busy && <Spin size="small" />}
        </div>

        {loading ? (
          <div style={{ padding: 20, textAlign: 'center' }}><Spin /></div>
        ) : (tree?.tree ?? []).length === 0 ? (
          // 拉失败时那句"去点一次 AI 标注"是**照它做要花钱**的建议,不能挂在一次
          // 失败的取数上(红条已经在上面了)
          <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--text-dim)', fontSize: 'var(--fs-13)' }}>
            {treeError
              ? '词库没拉下来 —— 看上面那条报错'
              : '词库还是空的。去「规则」页点一次「AI 标注」,它会自己长出来'}
          </div>
        ) : (
          <TagTree
            nodes={tree!.tree}
            expanded={expanded}
            onToggleExpand={toggle}
            renderActions={actions}
          />
        )}
      </div>
    </div>
  );
}
