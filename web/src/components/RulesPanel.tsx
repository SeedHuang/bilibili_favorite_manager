import { useCallback, useEffect, useState } from 'react';
import { App as AntApp, Button, Select, Tooltip } from 'antd';
import { Bot, Check, ChevronDown, ChevronRight, Pencil, Plus, ScrollText, Sparkles, Square, Trash2, X, Zap } from 'lucide-react';
import { proposalsApi, rulesApi, tagApi } from '../api';
import type {
  DryRun,
  ProposalDraftView,
  ProposalInfo,
  ProposalLogLine,
  RuleCondition,
  RuleField,
  RuleSuggestion,
  RuleView,
  TagNode,
} from '../types';
import { useTaskProgress } from '../hooks/useTaskProgress';
import { useAssistant } from './assistant';
import TaskLogDrawer from './TaskLogDrawer';

/**
 * 规则管理器(spec §9C.4)。
 *
 * 规则是这产品**唯一比 B站 多的东西** —— bilibili 有夹子但没有逻辑,
 * 谁进谁出全靠手。规则就是那个判据,而且它只存在本地。
 */
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

/** 列表里那一行的一句话 —— 表头 + 行都要用它,分两处写迟早分叉 */
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

/** 「2 分钟前」这种说法 —— 这一列回答的是"这条什么时候动过",不是精确时刻 */
function ago(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

// ── 夹子方案生成 ──────────────────────────────────────────
// 10 档名称与定义 —— 与后端 LEVELS 同源(spec §阶梯表);前端不引 server 模块,两份常量
const LEVEL_NAMES: { level: number; name: string; hint: string }[] = [
  { level: 1, name: '专精', hint: '同一具体事物的同一用法/技巧' },
  { level: 2, name: '工具', hint: '同一个具体事物/工具' },
  { level: 3, name: '方案', hint: '解决同一问题的同类工具' },
  { level: 4, name: '方向', hint: '同一技术路线/方法论' },
  { level: 5, name: '领域', hint: '同一领域' },
  { level: 6, name: '邻域', hint: '领域+紧邻领域' },
  { level: 7, name: '大类', hint: '同一大类' },
  { level: 8, name: '行业', hint: '同一行业' },
  { level: 9, name: '生活', hint: '生活大领域' },
  { level: 10, name: '全收', hint: '全库归成几大主题' },
];

export default function RulesPanel({ focusFolderId = null }: { focusFolderId?: number | null }) {
  const { modal } = AntApp.useApp();
  const [rules, setRules] = useState<RuleView[]>([]);
  const [dry, setDry] = useState<DryRun | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // AI 的建议 —— **只在内存里**(服务端也不落库)。采纳即变成规则,忽略即消失,
  // 刷新页面会丢 —— 但它可以从"重跑一次"再得到(spec §9C.5)。
  //
  // 存在**助手 context** 里而不是本组件的 state:建议有两个来源,"归类跑完顺手给的"
  // 那一次跑在全局对话框里、结果要落到这一页 —— 两边得看同一份。
  // 副作用是**忽略过的建议不会因为离开页面又回来而复活**:就一份列表,忽略即移出。
  const { suggestions, setSuggestions } = useAssistant();
  const [suggesting, setSuggesting] = useState(false);
  /** 调用**成功但没建议**时的一句话 —— 不然面板整个消失,看着像按钮没反应 */
  const [suggestNote, setSuggestNote] = useState('');

  const [proposal, setProposal] = useState<ProposalInfo | null>(null);
  const [drafts, setDrafts] = useState<ProposalDraftView[]>([]);
  const [genLevel, setGenLevel] = useState(5);
  const [generating, setGenerating] = useState(false);
  /** 日志存独立 state 而不是从轮询结果读 —— hook 在 generating=false 后不再拉,
      中止后的「已中止」行要靠 actProposal 那次手动 load 送进来;
      组件重挂载时初次 load 也能把服务端还留着的上一轮日志带回来 */
  const [logLines, setLogLines] = useState<ProposalLogLine[]>([]);
  const [logOpen, setLogOpen] = useState(false);

  /** current 的**唯一**写入通道:初次加载、actProposal、轮询 hook 全走它 ——
      generating 从 cur.proposal.status 派生(原有语义),logs 在 proposal 字段外层(Task 1 形状) */
  const loadProposal = useCallback(async () => {
    const cur = await proposalsApi.current();
    setProposal(cur.proposal);
    setDrafts(cur.drafts);
    setLogLines(cur.logs ?? []);
    setGenerating(cur.proposal?.status === 'generating');
  }, []);

  useEffect(() => { void loadProposal().catch((e) => setError((e as Error).message)); }, [loadProposal]);

  /**
   * 草稿操作统一走这里:动作成功后**必须**拉一次方案(草稿列表/待审数都来自它)。
   * 单独包一层就是为了"第五个草稿操作"不再忘刷新 —— 漏了的表现是旧草稿留在屏上、
   * 再点报 404,审查轮抓过一次。
   */
  const actProposal = (fn: () => Promise<unknown>) =>
    act(async () => { await fn(); await loadProposal(); });

  /** 需要留意的行数(warn+error)—— 徽标、标题计数、抽屉 warnCount 三处一个口径 */
  const alertCount = logLines.filter((l) => l.level !== 'info').length;

  // 轮询:generating 时按设置间隔(spec §3 可配),不再手工 setInterval。
  // fetcher 用 loadProposal 而不是裸 current:四样数据(proposal/drafts/logs/generating)
  // 从同一条路落 state,轮询和手动刷新不会各写一份
  useTaskProgress({ taskType: 'proposals', fetcher: loadProposal, enabled: generating });

  const generate = () => {
    modal.confirm({
      title: `按「${LEVEL_NAMES[genLevel - 1].name}」(${genLevel} 档)生成夹子方案?`,
      content: '未采纳的旧草稿会被覆盖;生成花一次模型调用,结果不可复现。',
      okText: '生成', cancelText: '算了',
      onOk: async () => {
        setError('');
        try {
          await proposalsApi.generate(genLevel);
          setGenerating(true);
          await loadProposal();
        } catch (e) {
          // 失败时弹窗关闭,错误落在页级红条 —— 和 TagPanel 的 confirmClearTags 同一惯例;
          // rethrow 保弹窗的话弹窗里没有错误文案,用户只能看到"卡住"的壳
          setError((e as Error).message);
        }
      },
    });
  };

  const reload = useCallback(async () => {
    setRules(await rulesApi.list());
  }, []);

  useEffect(() => {
    reload()
      .then(() => {
        if (focusFolderId !== null) setOpen(focusFolderId);
      })
      .catch((e) => setError((e as Error).message));
  }, [reload, focusFolderId]);

  // 词库树(§9F C11):规则里存的是 tag **id**,所以既要用它给 tag 条件做选项,
  // 也要用它把 id 翻成词名显示 —— 一次请求两个用途。
  //
  // **这一处拉挂了必须出声**(和上面 status 那处的静默不是一回事):它喂的是
  // **标签选择器**,而那是建 tag 规则的唯一入口。静默的话下拉是空的,同时
  // `renderRule` 会把每条已有的 tag 条件印成「标签(词已不在词库里)」—— 用户会
  // 得出"我的标签规则坏了"的结论,而其实只是一个请求失败了。红条一句话把两个
  // 症状一起解释掉,比留白强。
  const [tagTree, setTagTree] = useState<{ id: number; name: string }[]>([]);
  useEffect(() => {
    tagApi.tree()
      .then((t) => {
        const flat: TagNode[] = [];
        const walk = (nodes: TagNode[]) => { for (const n of nodes) { flat.push(n); walk(n.children); } };
        walk(t.tree);
        setTagTree(flat.map((n) => ({ id: n.id, name: n.name })));
      })
      .catch((e) => setError((e as Error).message));
  }, []);
  const tagNameOf = new Map(tagTree.map((t) => [t.id, t.name]));

  /** 返回**这次动作成功没有** —— 失败时调用方不能当它做过了(比如把一条建议当成已处理丢掉) */
  const act = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setError('');
    setBusy(true);
    try {
      await fn();
      // 命中数每次重算 —— 那是调规则时唯一的反馈(§9C.4 规矩 1)
      await reload();
      // 规则变了,上一次的试跑结果就过期了
      setDry(null);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  /**
   * 试跑**不走 `act()`** —— `act` 最后那下 `setDry(null)` 是给"规则变了,旧结果过期了"用的,
   * 而试跑本身正是要**留下**结果。走 act 的话结果会被立刻清掉,按钮点了等于没点。
   */
  const runDryRun = async () => {
    setError('');
    setBusy(true);
    try {
      setDry(await rulesApi.dryRun());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const setConditions = (folderId: number, conditions: RuleCondition[]) =>
    act(() => rulesApi.save(folderId, conditions));

  /** 让 AI 看看规则。不走 act() —— 它不该清掉试跑结果,也不该重算命中数 */
  const askAi = async () => {
    setError('');
    setSuggestNote('');
    setSuggesting(true);
    try {
      const got = (await rulesApi.suggest()).suggestions;
      setSuggestions(got);
      // **调用成功但一条都没有 —— 这也是信息。** 不说的话面板整个消失,用户看到的是
      // "点了没反应",而他刚为此等了几十秒(真机踩过:模型提了 54 条全没过自证)。
      // 服务端那条"用不了"的路已经改成抛错(会走上面的 error 分支),所以走到这里的
      // 只有一种情况:模型确实没提出建议。
      if (got.length === 0) {
        setSuggestNote('AI 这次没提出建议 —— 可以再点一次,或先手写几条规则。');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSuggesting(false);
    }
  };

  const dropSuggestion = (s: RuleSuggestion) =>
    setSuggestions((list) =>
      list.filter((x) => !(x.folderId === s.folderId && x.field === s.field && x.any.join() === s.any.join())),
    );

  /** 采纳 = 追加一条条件(不是覆盖);改一下 = 先采纳再把那一行摊开给你改 */
  const takeSuggestion = async (s: RuleSuggestion, andEdit: boolean) => {
    const { folderId, ...rest } = s;
    // **采纳失败就不算处理过** —— 建议不能因为一次 400 就从面板上消失:
    // 那会让用户以为它被采纳了,而其实什么都没写。只有「忽略」该让它消失。
    if (!(await act(() => rulesApi.adopt(folderId, rest)))) return;
    dropSuggestion(s);
    if (andEdit) setOpen(folderId);
  };

  const current = rules.find((r) => r.folderId === open);
  const withRules = rules.filter((r) => !r.locked && hasRule(r)).length;
  /** 有哪个夹子还没真正写规则 —— 没有的话「新增规则」就没地方可加,按钮该是灰的 */
  const canAddRule = rules.some((r) => !r.locked && !hasRule(r));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {error && (
        <div
          className="hud-panel"
          style={{ padding: 10, borderColor: 'var(--danger)', color: 'var(--danger)', fontSize: 'var(--fs-12)' }}
        >
          {error}
        </div>
      )}

      {/* ── 夹子方案生成:面板顶部、AI 建议栏之上 ── */}
      <div className="hud-panel" style={{ padding: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="hud-label">夹子方案</span>
          <Select
            size="small" value={genLevel} onChange={setGenLevel} style={{ width: 150 }}
            disabled={generating}
            options={LEVEL_NAMES.map((l) => ({ value: l.level, label: `${l.level} · ${l.name}` }))}
          />
          <span style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>
            {LEVEL_NAMES[genLevel - 1].hint} · 数字越大分得越粗
          </span>
          {/* 日志按钮照 TagPanel 的写法(ScrollText 小按钮);日志是内存态,
              生成结束后仍可点开看上一轮 —— 所以不绑 generating */}
          <Button
            size="small" icon={<ScrollText size={13} />}
            style={{ marginLeft: 'auto' }}
            onClick={() => setLogOpen(true)}
          >
            日志
            {alertCount > 0 && (
              <span className="num" style={{ color: 'var(--warn)', marginLeft: 4 }}>
                {alertCount}
              </span>
            )}
          </Button>
          {/* 生成中才有得中止 —— 后端未在跑时 abort 回 409(没有正在进行的生成) */}
          {generating && (
            <Button
              size="small" danger icon={<Square size={12} />}
              disabled={busy}
              onClick={() => actProposal(async () => { await proposalsApi.abort(); })}
            >
              中止
            </Button>
          )}
          <Button
            size="small" type="primary" icon={<Sparkles size={13} />}
            loading={generating} disabled={busy}
            onClick={generate}
          >
            {generating ? '生成中…' : '生成方案'}
          </Button>
        </div>
        {proposal?.status === 'ready' && (
          <div style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)', marginTop: 6 }}>
            方案({proposal.level} 档) · {drafts.filter((d) => d.status === 'pending').length} 个待审
            · 未挂词条目 {proposal.uncoveredCount} 条不参与
            {drafts.some((d) => d.status === 'pending') && (
              <Button size="small" type="link" disabled={busy}
                onClick={() => actProposal(() => proposalsApi.adoptAll())}>
                全部采纳
              </Button>
            )}
          </div>
        )}
      </div>

      {/* ── AI 的建议:置顶且单独一栏 —— 它是"待你处理"的东西(§9C.4 规矩 2)── */}
      {(suggestions.length > 0 || suggesting || suggestNote) && (
        <div className="hud-panel" style={{ padding: 12, borderColor: 'var(--ai)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <Bot size={14} style={{ color: 'var(--ai)' }} />
            <span className="hud-label" style={{ color: 'var(--ai)' }}>AI 的建议</span>
            <span className="num" style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>
              {suggestions.length}
            </span>
            {suggestions.length > 1 && (
              <Button
                size="small"
                style={{ marginLeft: 'auto' }}
                disabled={busy}
                onClick={() => {
                  // 一条一条来 —— adopt 是追加,并发写同一个夹子会互相覆盖
                  void (async () => {
                    for (const s of [...suggestions]) await takeSuggestion(s, false);
                  })();
                }}
              >
                全部采纳
              </Button>
            )}
          </div>

          {suggestions.length === 0 && (
            <div style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>
              {suggestNote || 'AI 正在看……'}
            </div>
          )}

          {suggestions.map((s) => {
            const name = rules.find((r) => r.folderId === s.folderId)?.folderName ?? `夹子 ${s.folderId}`;
            return (
              <div
                key={`${s.folderId}-${s.field}-${s.any.join()}`}
                style={{
                  borderLeft: '2px solid var(--ai)', background: 'var(--surface-2)',
                  padding: '8px 10px', marginBottom: 6,
                }}
              >
                <div style={{ fontSize: 'var(--fs-13)' }}>
                  「{name}」加一条:
                  <span style={{ color: 'var(--ai)' }}>
                    {' '}{FIELD_LABEL[s.field]}含 {s.any.join(' · ')}
                  </span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-dim)', margin: '4px 0 6px', lineHeight: 1.6 }}>
                  依据:{s.because || '(没给依据)'}
                  {/* 自证过的证据 —— 这是"该不该信它"的全部依据(§9C.5 R7) */}
                  <span className="num"> · 命中 {s.evidenceItemIds.length} 条</span>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <Button
                    size="small" type="primary" icon={<Check size={12} />}
                    disabled={busy} onClick={() => void takeSuggestion(s, false)}
                  >
                    采纳
                  </Button>
                  <Button
                    size="small" icon={<Pencil size={12} />}
                    disabled={busy} onClick={() => void takeSuggestion(s, true)}
                  >
                    改一下
                  </Button>
                  <Button
                    size="small" type="text" icon={<X size={12} />}
                    disabled={busy} onClick={() => dropSuggestion(s)}
                  >
                    忽略
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="hud-panel" style={{ padding: 12 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 10 }}>
          <span className="hud-label">规则</span>
          <span className="num" style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>
            {rules.length} 个夹子 · {withRules} 条规则
          </span>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <Button
              size="small"
              icon={<Plus size={13} />}
              disabled={!canAddRule || busy}
              onClick={() => {
                // 找一个还没规则的夹子开一条空规则 —— 锁定的不给
                const target = rules.find((r) => !r.locked && !hasRule(r));
                if (!target) return;
                setOpen(target.folderId);
                if (target.conditions.length === 0) {
                  void setConditions(target.folderId, [{ field: 'title', any: [] }]);
                }
              }}
            >
              新增规则
            </Button>
            <Button
              size="small"
              icon={<Bot size={13} />}
              loading={suggesting}
              disabled={!rules.length || busy}
              onClick={() => void askAi()}
            >
              让 AI 看看规则
            </Button>
            <Button
              size="small"
              icon={<Zap size={13} />}
              loading={busy}
              onClick={() => void runDryRun()}
            >
              试跑:规则 vs AI
            </Button>
          </span>
        </div>

        {dry && (
          <div
            className="hud-panel"
            style={{ padding: '6px 10px', marginBottom: 10, fontSize: 'var(--fs-12)', borderColor: 'var(--accent)' }}
          >
            规则覆盖 <span className="num" style={{ color: 'var(--accent)' }}>{dry.covered.toLocaleString()}</span> 条
            · 剩 <span className="num">{dry.remaining.toLocaleString()}</span> 条要交给 AI
            {dry.batches !== null && <> · 约 <span className="num">{dry.batches}</span> 批</>}
          </div>
        )}

        {/* 表头 —— 密集行 + 发丝线,数据工具该长得像表格(§11:不用卡片装列表) */}
        <div style={{ display: 'flex', gap: 10, padding: '0 4px 6px', borderBottom: '1px solid var(--rule)' }}>
          <span className="hud-label" style={{ width: 150, flex: 'none' }}>夹子</span>
          <span className="hud-label" style={{ flex: 1 }}>规则</span>
          <span className="hud-label" style={{ width: 64, flex: 'none', textAlign: 'right' }}>命中</span>
          <span className="hud-label" style={{ width: 44, flex: 'none', textAlign: 'center' }}>来源</span>
          <span className="hud-label" style={{ width: 68, flex: 'none', textAlign: 'right' }}>改于</span>
        </div>

        {rules.length === 0 && (
          <div style={{ padding: '14px 4px', color: 'var(--text-dim)', fontSize: 'var(--fs-12)' }}>
            还没有工作副本 —— 先去「整理」页改一处,规则才挂得上。
          </div>
        )}

        {rules.map((r) => {
          const isOpen = open === r.folderId;
          const confirmDelete = () =>
            modal.confirm({
              title: `删掉「${r.folderName}」的规则?`,
              content: '只删规则,夹子和里面的条目都不动。',
              okText: '删除', okButtonProps: { danger: true }, cancelText: '算了',
              onOk: () => act(() => rulesApi.remove(r.folderId)),
            });
          return (
            <div key={r.folderId} style={{ borderBottom: '1px solid var(--rule)' }}>
              <div
                // 锁定的夹子**只有真的挂着规则时**才可展开 —— 那是唯一能从界面上
                // 把这条规则删掉的地方(锁定是在规则写完之后才可能发生的)
                onClick={() => (!r.locked || hasRule(r)) && setOpen(isOpen ? null : r.folderId)}
                style={{
                  display: 'flex', gap: 10, alignItems: 'baseline', padding: '7px 4px',
                  cursor: !r.locked || hasRule(r) ? 'pointer' : 'default',
                  background: isOpen ? 'var(--surface-2)' : 'transparent',
                }}
              >
                <span
                  style={{
                    width: 150, flex: 'none', display: 'flex', alignItems: 'center', gap: 5,
                    fontSize: 'var(--fs-13)', color: r.locked ? 'var(--text-dim)' : 'var(--text)',
                  }}
                >
                  {(!r.locked || hasRule(r)) && (isOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
                  {r.locked && !hasRule(r) && <span style={{ width: 12 }} />}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {r.folderName}
                  </span>
                </span>

                <span style={{ flex: 1, minWidth: 0, fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>
                  {/* 锁定的夹子**可能有**规则(先写规则后锁定)—— 不能一口咬定它没有 */}
                  {r.locked
                    ? hasRule(r)
                      ? `${renderRule(r.conditions, tagNameOf)}(锁定的夹子只能删,不能改)`
                      : '—— 锁定的夹子不加规则'
                    : !hasRule(r)
                      ? '—— 还没写规则,归类时靠 AI'
                      : renderRule(r.conditions, tagNameOf)}
                </span>

                <span
                  className="num"
                  style={{
                    width: 64, flex: 'none', textAlign: 'right', fontSize: 'var(--fs-12)',
                    color: r.hit > 0 ? 'var(--accent)' : 'var(--text-dim)',
                  }}
                >
                  {r.hit > 0 ? r.hit : '—'}
                </span>

                <span style={{ width: 44, flex: 'none', textAlign: 'center', fontSize: 12 }}>
                  {!hasRule(r) ? (
                    <span style={{ color: 'var(--text-dim)' }}>—</span>
                  ) : r.origin === 'ai' ? (
                    <Tooltip title="AI 提的"><span style={{ color: 'var(--ai)' }}>🤖</span></Tooltip>
                  ) : (
                    <Tooltip title="你写的"><span style={{ color: 'var(--text-dim)' }}>✎</span></Tooltip>
                  )}
                </span>

                {/* 半写的规则没有"改于"可言 —— 和来源列同一把 hasRule 尺子 */}
                <span
                  className="num"
                  style={{ width: 68, flex: 'none', textAlign: 'right', fontSize: 11, color: 'var(--text-dim)' }}
                >
                  {hasRule(r) && r.updatedAt !== null ? ago(r.updatedAt) : '—'}
                </span>
              </div>

              {isOpen && current?.folderId === r.folderId && (
                // 判据和行上那处一致:`hasRule` 才算"有规则"。锁定的夹子**可能压根没规则**
                // (深链 ?folder= 会无条件展开它,点过看它的规则也会),那时说"这条规则一直在生效"
                // 是句假话,而且旁边那个删除按钮删的是不存在的东西。
                r.locked && hasRule(r) ? (
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
                ) : r.locked ? (
                  // 锁定的夹子没规则可改 —— 什么都不给(而不是给一个空的编辑器)
                  null
                ) : (
                  <ConditionsEditor
                    conditions={r.conditions}
                    busy={busy}
                    tagTree={tagTree}
                    onChange={(next) => setConditions(r.folderId, next)}
                    onDelete={confirmDelete}
                  />
                )
              )}
            </div>
          );
        })}

        {drafts.filter((d) => d.status === 'pending').map((d) => (
          <div key={`draft-${d.id}`} style={{ borderBottom: '1px solid var(--rule)', background: 'rgba(120,119,255,0.06)' }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '7px 4px' }}>
              <span style={{ width: 150, flex: 'none', display: 'flex', alignItems: 'center', gap: 5, fontSize: 'var(--fs-13)' }}>
                {/* 草稿标 —— 用户要求:一眼区分草稿与真夹子 */}
                <Tooltip title="AI 方案草稿 —— 采纳后变成真夹子">
                  <Sparkles size={12} style={{ color: 'var(--ai)', flex: 'none' }} />
                </Tooltip>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</span>
              </span>
              <span style={{ flex: 1, minWidth: 0, fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>
                {d.reason || '(AI 没给理由)'}
                {d.weak && <span style={{ color: 'var(--warning, #d4a017)' }}> · ⚠ 规则偏弱:概念压了很多条目,关键词捞不满</span>}
              </span>
              <span className="num" style={{ width: 64, flex: 'none', textAlign: 'right', fontSize: 'var(--fs-12)', color: 'var(--accent)' }}>
                {d.hitCount}
              </span>
              <span style={{ width: 44, flex: 'none', textAlign: 'center', fontSize: 12 }}>
                <span style={{ color: 'var(--ai)' }}>🤖</span>
              </span>
              <span style={{ width: 68, flex: 'none' }} />
            </div>
            {/* 证据行:样本标题 */}
            <div style={{ padding: '0 4px 8px 26px', fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>
              {d.sampleTitles.length > 0 && <div style={{ marginBottom: 4 }}>命中样本:{d.sampleTitles.slice(0, 5).join(' / ')}</div>}
              <Button size="small" type="primary" icon={<Check size={12} />} disabled={busy}
                onClick={() => actProposal(() => proposalsApi.adopt(d.id))}>
                采纳
              </Button>
              <Button size="small" icon={<Pencil size={12} />} disabled={busy}
                onClick={() => {
                  modal.confirm({
                    title: '改名后采纳',
                    content: (
                      <input id="draft-rename" defaultValue={d.name}
                        style={{ width: '100%', padding: 6, border: '1px solid var(--rule)', borderRadius: 4 }} />
                    ),
                    okText: '采纳', cancelText: '算了',
                    onOk: async () => {
                      const el = document.getElementById('draft-rename') as HTMLInputElement | null;
                      await actProposal(() => proposalsApi.adopt(d.id, el?.value ?? undefined));
                    },
                  });
                }}>
                改名采纳
              </Button>
              <Button size="small" type="text" danger icon={<X size={12} />} disabled={busy}
                onClick={() => actProposal(() => proposalsApi.discard(d.id))}>
                丢弃
              </Button>
            </div>
          </div>
        ))}
      </div>

      <div style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>
        规则命中的条目会<span style={{ color: 'var(--accent)' }}> 0 token 直接归位</span>,
        剩下的才交给 AI。一条条目可以同时命中多个夹子 —— 那就都归(B站 本来也允许)。
      </div>

      {/* 方案生成日志(spec 2026-09-20 规则 4)。lines 读独立 state:生成结束后
          hook 停了,state 里还留着最后一拍 —— 中止后那次手动 load 也会刷新它。
          「清空」只清前端视图:日志在服务端是内存态,下次启动 run 自动清 */}
      <TaskLogDrawer
        open={logOpen} onClose={() => setLogOpen(false)}
        onClear={() => setLogLines([])}
        title="方案生成日志"
        lines={logLines}
        renderLine={(l) => (
          <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
            {/* error 和 warn 同样要扎眼 —— 失败生成如果是暗点就没人看见 */}
            <span style={{ color: l.level === 'info' ? 'var(--text-dim)' : 'var(--warn)', flex: 'none' }}>
              {l.level === 'info' ? '·' : '⚠'}
            </span>
            <span style={{ color: l.level === 'info' ? 'var(--text-dim)' : 'var(--warn)' }}>{l.text}</span>
          </div>
        )}
        serialize={(ls) => ls.map((l) => `${new Date(l.ts).toLocaleTimeString()} [${l.level}] ${l.text}`).join('\n')}
        downloadName={`方案生成-${new Date().toISOString().slice(0, 10)}.txt`}
        warnCount={alertCount}
        waiting={generating && logLines.length === 0}
      />
    </div>
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
            <Select
              size="small"
              mode="tags"
              value={c.any}
              onChange={(v: string[]) => patch(i, { any: v })}
              placeholder="打下关键词,回车确认"
              style={{ flex: 1, minWidth: 240 }}
              tokenSeparators={[',', '、', ' ']}
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
