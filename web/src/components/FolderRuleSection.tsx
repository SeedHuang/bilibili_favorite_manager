import { App as AntApp, Button, Select } from 'antd';
import { Plus, Trash2 } from 'lucide-react';
import { rulesApi } from '../api';
import type { RuleCondition, RuleField, RuleView } from '../types';

/** 条件字段名 —— 规则行与 tag 选择器都用它 */
const FIELD_LABEL: Record<RuleField, string> = {
  title: '标题', intro: '简介', upper: 'UP 名', tag: '标签',
};

/** tag 条件存的是 id,不是关键词 —— 判断"这个字段是不是从词库里选"只有这一处口径 */
const isTagField = (f: RuleField): boolean => f === 'tag';

/**
 * 半写的规则 = **没有规则** —— 和服务端 `renderConditions` 同一个判据。
 * 界面上「新增规则」建出来的就是 `[{ field: 'title', any: [] }]`:它匹配不到任何条目,
 * 所以既不该显示成一条规则,也不该算进「N 条规则」,更不该在来源列标成谁写的。
 */
const hasRule = (r: RuleView): boolean => r.conditions.some((c) => c.any.some((k) => k));

/** 列表里那一行的一句话 —— 树里规则区 + 只读渲染都用它,分两处写迟早分叉 */
const renderRule = (conditions: RuleCondition[], tagNameOf: ReadonlyMap<number, string>): string =>
  conditions
    .filter((c) => c.any.some((k) => k))
    .map((c) => {
      if (!isTagField(c.field)) return `${FIELD_LABEL[c.field]}含 ${c.any.filter((k) => k).join('·')}`;
      // 服务端 renderConditions 只解决"给模型看的那份" —— 这份是给人看的,得一起翻
      const names = c.any.map(Number).map((id) => tagNameOf.get(id)).filter((x): x is string => !!x);
      // 翻不到名字也别印 id —— 印一串数字比留白更让人困惑
      return names.length ? `标签含 ${names.join('·')}` : '标签(词已不在词库里)';
    })
    .join('  ·  ');

/**
 * 夹子行里的规则区(spec 2026-09-21 §7)。
 *
 * 按三分类分叉:
 * - 锁定的默认夹:有规则时只给「删掉这条规则」按钮(改不了,但**必须能删**);
 * - AI 夹子(`editable=false`):只读渲染条件 + 一句提示,不挂编辑器
 *   (规则由建议驱动,采纳/改一下是唯一写入通道);
 * - 人类夹子(`editable=true`):ConditionsEditor 全功能,onChange 走 rulesApi.save。
 */
export default function FolderRuleSection({
  view,
  tagNameOf,
  tagTree,
  busy,
  onChanged,
  editable,
}: {
  view: RuleView;
  tagNameOf: Map<number, string>;
  tagTree: { id: number; name: string }[];
  busy: boolean;
  /** 任一规则改动成功后调用 —— 父层重拉 rules + workbench 视图 */
  onChanged: () => void;
  /** false = AI 夹子(只读);true = 人类夹子(可编辑) */
  editable: boolean;
}) {
  const { modal } = AntApp.useApp();

  const confirmDelete = () =>
    modal.confirm({
      title: `删掉「${view.folderName}」的规则?`,
      content: '只删规则,夹子和里面的条目都不动。',
      okText: '删除', okButtonProps: { danger: true }, cancelText: '算了',
      onOk: () => void (async () => {
        try { await rulesApi.remove(view.folderId); onChanged(); }
        catch (e) { console.error('[规则区] 删除失败', e); }
      })(),
    });

  const save = (next: RuleCondition[]) => {
    void (async () => {
      try { await rulesApi.save(view.folderId, next); onChanged(); }
      catch (e) { console.error('[规则区] 保存失败', e); }
    })();
  };

  // 锁定的默认夹:只给删规则按钮(照 RulesPanel 判据 —— 没规则就什么都不给)
  if (view.locked) {
    if (!hasRule(view)) return null;
    return (
      <div
        style={{
          padding: '4px 4px 12px 26px', display: 'flex', alignItems: 'center',
          gap: 8, fontSize: 'var(--fs-12)', color: 'var(--text-dim)',
        }}
      >
        {/* 锁定是在规则写完之后才可能发生的 —— 这条规则是活的,一直在参与归类。
            不给改(服务端也会拒),但**必须能删**,否则它就成了一个改不掉也去不掉的影子。 */}
        <span>锁定的夹子不能改规则,但这条规则一直在生效:</span>
        <Button size="small" type="text" danger disabled={busy} onClick={confirmDelete}>
          删掉这条规则
        </Button>
      </div>
    );
  }

  // AI 夹子:只读 —— 规则由建议驱动,不给直接编辑入口
  if (!editable) {
    return (
      <div style={{ padding: '4px 4px 12px 26px', fontSize: 'var(--fs-12)', color: 'var(--text-dim)', lineHeight: 1.7 }}>
        <div>{hasRule(view) ? renderRule(view.conditions, tagNameOf) : '—— 还没有规则'}</div>
        <div style={{ marginTop: 2, color: 'var(--ai)' }}>
          AI 夹子的规则由建议驱动 —— 采纳建议或改一下来调整
        </div>
      </div>
    );
  }

  return (
    <ConditionsEditor
      conditions={view.conditions}
      busy={busy}
      tagTree={tagTree}
      onChange={save}
      onDelete={confirmDelete}
    />
  );
}

/**
 * 就地编辑,不弹窗 —— 改规则时你**必须同时看着"命中几条"**,弹窗会把表盖住。
 * 加个词 → 看命中数跳 → 删掉重来,这个来回就是调规则的全部体验(§9C.4 规矩 1)。
 */
function ConditionsEditor({
  conditions, busy, tagTree, onChange, onDelete,
}: {
  conditions: RuleCondition[];
  busy: boolean;
  /** 词库摊平后的词表(id + 名字)—— tag 条件只从这里选,不让手打 id */
  tagTree: { id: number; name: string }[];
  onChange: (next: RuleCondition[]) => void;
  onDelete: () => void;
}) {
  const patch = (i: number, next: Partial<RuleCondition>) =>
    onChange(conditions.map((c, idx) => (idx === i ? { ...c, ...next } : c)));

  return (
    <div style={{ padding: '4px 4px 12px 26px' }}>
      {conditions.map((c, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
          <Select
            size="small"
            value={c.field}
            // 关键词和 tag id 不是同一种值 —— 换过去还留着旧的,就会存下一条
            // 永远匹配不上的规则(半写的规则至少还看得见,这条是**看不出来**的)
            onChange={(v: RuleField) =>
              patch(i, { field: v, ...(isTagField(v) === isTagField(c.field) ? {} : { any: [] }) })}
            style={{ width: 92 }}
            options={(Object.keys(FIELD_LABEL) as RuleField[]).map((f) => ({
              value: f,
              label: FIELD_LABEL[f],
            }))}
          />
          <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>含</span>
          {isTagField(c.field) ? (
            // 标签**从词库里选**(存的是 id)。这和"给模型看的时候印词名不印数字"
            // 是两件事:那条说的是喂给模型的东西,这里说的是给人挑的接口
            <Select
              size="small"
              mode="multiple"
              showSearch
              optionFilterProp="label"
              value={c.any}
              onChange={(v: string[]) => patch(i, { any: v })}
              placeholder="从词库里选标签(选中即匹配它整棵子树)"
              style={{ flex: 1, minWidth: 240 }}
              options={tagTree.map((t) => ({ value: String(t.id), label: t.name }))}
            />
          ) : (
            // 关键词:自由录入,不出下拉 —— 词是打字 + 逗号成的,不是从选项里挑。
            // 修掉了"下拉没有的词就填不了"的缺陷(spec 2026-09-21 §7)。
            <Select
              size="small"
              mode="tags"
              open={false}                    // 关键:不出下拉 —— 词是自由录入的,不是从选项里挑
              tokenSeparators={[',', '、']}   // 逗号成 chip;去掉空格分隔(会把带空格的词拆碎)
              value={c.any}
              onChange={(v: string[]) => patch(i, { any: [...new Set(v)] })}  // 去重
              placeholder="打字,逗号成一个词;点 x 删除"
              style={{ flex: 1, minWidth: 240 }}
            />
          )}
          <Button
            size="small"
            type="text"
            danger
            icon={<Trash2 size={12} />}
            onClick={() => onChange(conditions.filter((_, idx) => idx !== i))}
          />
        </div>
      ))}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
        <Button
          size="small"
          icon={<Plus size={12} />}
          disabled={busy}
          onClick={() => onChange([...conditions, { field: 'title', any: [] }])}
        >
          再加一个条件(或)
        </Button>
        <Button size="small" type="text" danger disabled={busy} onClick={onDelete}>
          删掉这条规则
        </Button>
        <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>改完自动保存,命中数会跟着变</span>
      </div>
    </div>
  );
}
