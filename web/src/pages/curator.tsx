import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useRequest } from '@umijs/max';
import { App as AntApp, Button, Input, Alert, Select, Tabs } from 'antd';
import { Bot, Undo2, Plus, FolderInput, MoveRight, FolderX, Lock, Sparkles, Wand2, ScrollText, Square, Check, Pencil, X } from 'lucide-react';
import { api, rawResult, workbenchApi, setFolderLock, proposalsApi, reviewsApi, rulesApi, tagApi } from '../api';
import type {
  Folder,
  Item,
  WorkbenchView,
  ReviewCurrent,
  ProposalInfo,
  ProposalDraftView,
  ProposalLogLine,
  RuleView,
  RuleSuggestion,
  RuleField,
  TagNode,
} from '../types';
import WorkFolderTree from '../components/WorkFolderTree';
import OperationLog from '../components/OperationLog';
import { useAssistant } from '../components/assistant';
import { useTaskProgress } from '../hooks/useTaskProgress';
import TaskLogDrawer from '../components/TaskLogDrawer';
import DraftsArea from '../components/ReviewDrafts';

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

/** 条件字段名 —— AI 建议栏的展示用它 */
const FIELD_LABEL: Record<RuleField, string> = {
  title: '标题', intro: '简介', upper: 'UP 名', tag: '标签',
};

/** 整理 —— 一份结构,改动带标记。AI 不在这里(在右下角对话框里)。 */
export default function CuratorPage() {
  // 静态 `Modal.confirm` 认不到主题(它在另一个 React root 里)——
  // 用 `App.useApp()` 拿的那套才走 ConfigProvider
  const { modal } = AntApp.useApp();
  // 建议存在助手 context 里:归类跑完顺手给的那批落在全局对话框里,两边看同一份
  const { openWith, suggestions, setSuggestions } = useAssistant();

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

  // ── 运行锁 + 审查/整理(spec 2026-09-21 §5)─────────────────
  // 三个长任务(生成方案 / 审查勾选 / 整理)共享一把锁:任一在跑,其余全灰。
  const [runState, setRunState] = useState<'idle' | 'generating' | 'reviewing' | 'tidying'>('idle');
  const [review, setReview] = useState<ReviewCurrent | null>(null);
  /** 「改一下」采纳后要就地展开的夹子规则行(Task 9 接入树) */
  const [ruleOpenId, setRuleOpenId] = useState<number | null>(null);

  const loadReview = useCallback(async () => {
    const next = await reviewsApi.current();
    setReview(next);
    // 审查跑完(running true→false)→ 释放运行锁(照 RulesPanel 里 generating 的派生写法)
    setRunState((s) => (s === 'reviewing' && !next.running ? 'idle' : s));
  }, []);
  useTaskProgress({ taskType: 'reviews', fetcher: loadReview, enabled: runState === 'reviewing' });
  // 挂载时先拉一次:刷新 / 切页回来后,库里 pending 的审查草稿也要能看见(loadProposal 同款职责)
  useEffect(() => { void loadReview().catch((e) => setError((e as Error).message)); }, [loadReview]);

  const runReview = () => {
    modal.confirm({
      title: `审查这 ${checkedFolders.size} 个夹子?`,
      content: 'AI 按各夹子的标签构成给规则/合并/删除草稿;花一次模型调用。',
      okText: '审查', cancelText: '算了',
      onOk: async () => {
        setRunState('reviewing');
        try {
          await reviewsApi.generate([...checkedFolders]);
          await loadReview();
        } catch (e) { setError((e as Error).message); setRunState('idle'); }
      },
    });
  };

  const runTidy = async (ids?: Set<number>) => {
    setRunState('tidying');
    try {
      const r = await workbenchApi.tidy([...(ids ?? checkedFolders)]);
      setNotice(`整理完成:对账 ${r.reconciled.length} 个,规则补进 ${r.ruleAdded.reduce((s, x) => s + x.added, 0)} 条`);
    } catch (e) { setError((e as Error).message); }
    finally {
      setRunState('idle');
      // 最后这一拍刷新被 void 掉时(三个调用点都不 await),失败必须出声而不是抛 unhandled rejection
      await reload().catch((e) => setError((e as Error).message));
    }
  };

  // ── 夹子方案生成(从 RulesPanel 迁来)─────────────────────
  const [proposal, setProposal] = useState<ProposalInfo | null>(null);
  const [drafts, setDrafts] = useState<ProposalDraftView[]>([]);
  const [genLevel, setGenLevel] = useState(5);
  const [generating, setGenerating] = useState(false);
  /** 日志存独立 state 而不是从轮询结果读 —— hook 在 generating=false 后不再拉,
      中止后的「已中止」行要靠 actProposal 那次手动 load 送进来 */
  const [logLines, setLogLines] = useState<ProposalLogLine[]>([]);
  const [logOpen, setLogOpen] = useState(false);
  /** 短动作(采纳/丢弃/中止)的忙锁 —— 长任务用 runState,两者互不替代 */
  const [busy, setBusy] = useState(false);

  /** current 的**唯一**写入通道:初次加载、actProposal、轮询 hook 全走它 ——
      generating 从 cur.proposal.status 派生(原有语义),logs 在 proposal 字段外层 */
  const loadProposal = useCallback(async () => {
    const cur = await proposalsApi.current();
    // 这行是"页面为什么显示生成中"的第一现场 —— 状态、草稿、日志长度一起打,
    // 看一眼就知道是后端真在跑、还是库里残留的状态
    console.log('[proposals-ui] current →', JSON.stringify({
      status: cur.proposal?.status ?? 'none',
      level: cur.proposal?.level ?? null,
      drafts: cur.drafts.length,
      logs: cur.logs?.length ?? 0,
    }));
    setProposal(cur.proposal);
    setDrafts(cur.drafts);
    setLogLines(cur.logs ?? []);
    setGenerating(cur.proposal?.status === 'generating');
    // 生成结束 → 释放运行锁
    setRunState((s) => (s === 'generating' && cur.proposal?.status !== 'generating' ? 'idle' : s));
  }, []);

  useEffect(() => { void loadProposal().catch((e) => setError((e as Error).message)); }, [loadProposal]);

  // 生成已耗时(秒)—— 长任务里"还在动吗"靠这个回答,不定态条只答"动没动"
  const [genSeconds, setGenSeconds] = useState(0);
  useEffect(() => {
    if (!generating) { setGenSeconds(0); return; }
    const t = setInterval(() => setGenSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [generating]);

  // 轮询:generating 时按设置间隔,不再手工 setInterval。
  useTaskProgress({ taskType: 'proposals', fetcher: loadProposal, enabled: generating });

  /** 需要留意的行数(warn+error)—— 徽标、标题计数、抽屉 warnCount 三处一个口径 */
  const alertCount = logLines.filter((l) => l.level !== 'info').length;

  /** 草稿操作统一走这里:动作成功后**必须**拉一次方案(草稿列表/待审数都来自它) */
  const actProposal = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setError('');
    setBusy(true);
    try {
      await fn();
      await loadProposal();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const generate = () => {
    modal.confirm({
      title: `按「${LEVEL_NAMES[genLevel - 1].name}」(${genLevel} 档)生成夹子方案?`,
      content: '未采纳的旧草稿会被覆盖;生成花一次模型调用,结果不可复现。',
      okText: '生成', cancelText: '算了',
      onOk: async () => {
        setError('');
        console.log(`[proposals-ui] 点了生成方案 档位 L${genLevel} —— 等后端受理`);
        setRunState('generating');
        try {
          await proposalsApi.generate(genLevel);
          console.log('[proposals-ui] 后端已受理(202)—— 进入运行态,开始轮询');
          setGenerating(true);
          await loadProposal();
        } catch (e) {
          // 失败时弹窗关闭,错误落在页级红条
          console.log('[proposals-ui] 启动失败', String(e));
          setRunState('idle');
          setError((e as Error).message);
        }
      },
    });
  };

  /** 草稿区任一动后重拉两类草稿数据(proposal + review) */
  const reloadDrafts = useCallback(async () => {
    await Promise.all([loadReview(), loadProposal()]);
  }, [loadReview, loadProposal]);

  // ── 规则住进树(spec 2026-09-21 §7)────────────────────────
  const [rules, setRules] = useState<RuleView[]>([]);
  const reloadRules = useCallback(async () => {
    setRules(await rulesApi.list());
  }, []);
  useEffect(() => { void reloadRules().catch((e) => setError((e as Error).message)); }, [reloadRules]);

  // 词库树:规则里存的是 tag **id**,既用它给 tag 条件做选项,也用它把 id 翻成词名显示
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

  /**
   * 展开某一行的规则区。规则区渲染在**行展开体**里(`WorkFolderTree` 的 `{open && ...}`),
   * 只设 ruleOpenId 看不见 —— 必须同时把行展开(采纳建议/草稿后的 auto-expand 全走这里)。
   */
  const openRuleRow = (folderId: number) => {
    setRuleOpenId(folderId);
    if (expanded?.folderId !== folderId) void toggleExpand(folderId);
  };

  /** 点夹子行规则按钮:就地展开/收起该行规则区(不再跳 /rules) */
  const toggleRule = (folderId: number) => {
    setRuleOpenId((cur) => (cur === folderId ? null : folderId));
    if (expanded?.folderId !== folderId) void toggleExpand(folderId);
  };

  /** 规则区任一改动后:重拉 rules(命中数/来源重算)+ workbench 视图 */
  const onRuleChanged = useCallback(() => {
    void (async () => {
      try {
        await reloadRules();
        await reload();
      } catch (e) { setError((e as Error).message); }
    })();
  }, [reloadRules, reload]);

  // ── AI 的建议(从 RulesPanel 迁来)─────────────────────────
  /** 建议动作:采纳后重拉 rules(命中数/来源重算) */
  const actSuggestion = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setError('');
    setBusy(true);
    try {
      await fn();
      await reloadRules();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
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
    if (!(await actSuggestion(() => rulesApi.adopt(folderId, rest)))) return;
    dropSuggestion(s);
    if (andEdit) openRuleRow(folderId);
  };

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
   * 生成方案 / 审查勾选 / 整理 共享一把运行锁(spec §5 状态表):任一在跑,其余全灰。
   */
  const hasChecked = checkedFolders.size > 0;
  /**
   * §9F C14:夹子 id → 离群条目 id。摊平一次给树用 —— 树里逐行 find 就是 O(n²),
   * 而夹子有几十个、每行都渲染。
   */
  const outliersByFolder = new Map((view?.profiles ?? []).map((p) => [p.folderId, p.outliers]));
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
      <Button
        key="gen"
        icon={<Sparkles size={14} />}
        loading={runState === 'generating'}
        disabled={runState !== 'idle'}
        onClick={generate}
      >
        生成方案
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
          <Button
            key="review"
            icon={<Sparkles size={14} />}
            loading={runState === 'reviewing'}
            disabled={runState !== 'idle'}
            onClick={runReview}
          >
            审查勾选的夹子 {checkedFolders.size > 0 ? `(${checkedFolders.size})` : ''}
          </Button>,
          <Button
            key="tidy"
            icon={<Wand2 size={14} />}
            loading={runState === 'tidying'}
            disabled={runState !== 'idle'}
            onClick={() => void runTidy()}
          >
            整理 {checkedFolders.size > 0 ? `(${checkedFolders.size})` : ''}
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

      {/* ── 夹子方案生成(从 RulesPanel 迁来)── */}
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
          {/* 生成按钮在顶栏常驻组;这里只在运行时给「中止」 */}
          {generating && (
            <Button
              size="small" danger icon={<Square size={12} />}
              disabled={busy}
              onClick={() => {
                console.log('[proposals-ui] 点了中止 —— 等后端回执');
                void actProposal(async () => { await proposalsApi.abort(); });
              }}
            >
              中止
            </Button>
          )}
        </div>
        {/* 生成中的进度:**不定态**流动条 + 已耗时 —— 单次 LLM 调用没有 done/total,
            编百分比是假信息;"还在动 + 动了多久"才是这里能诚实回答的 */}
        {generating && (
          <div style={{ marginTop: 8 }}>
            <div className="bfm-indeterminate" />
            <div style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)', marginTop: 4 }}>
              生成中 · 已 <span className="num">{genSeconds}</span> 秒 —— 过程看「日志」
            </div>
          </div>
        )}
        {proposal?.status === 'ready' && (
          <div style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)', marginTop: 6 }}>
            方案({proposal.level} 档) · {drafts.filter((d) => d.status === 'pending').length.toLocaleString()} 个待审
            · 未挂词条目 {proposal.uncoveredCount.toLocaleString()} 条不参与
          </div>
        )}
      </div>

      {/* ── AI 的建议:置顶且单独一栏 —— 它是"待你处理"的东西(§9C.4 规矩 2)──
          唯一来源是**归类跑完顺手给的那批**(那一次跑在全局对话框里,结果落到这一页) */}
      {suggestions.length > 0 && (
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

      {/* ── 草稿区:生成草稿 + 审查草稿混合显示(spec §6)── */}
      <DraftsArea
        drafts={drafts}
        reviewDrafts={review?.drafts ?? []}
        busy={busy}
        onChanged={() => void reloadDrafts()}
        onEditRule={(folderId) => openRuleRow(folderId)}
        onProposalAdopt={(folderId) => {
          // 生成草稿逐个采纳后:展开规则行 + 默认勾上(spec 拍板 8 / Task 10 bug 修复)
          setCheckedFolders((prev) => {
            const next = new Set(prev);
            next.add(folderId);
            return next;
          });
          openRuleRow(folderId);
        }}
        onReviewAdoptAll={() => void runTidy()}
        onProposalAdoptAll={(folderIds) => {
          // 新采纳的夹子默认勾上(自动整理链路不能断)+ 展开规则行
          setCheckedFolders((prev) => {
            const next = new Set(prev);
            folderIds.forEach((id) => next.add(id));
            return next;
          });
          if (folderIds.length > 0) openRuleRow(folderIds[0]);
          void runTidy(new Set([...checkedFolders, ...folderIds]));
        }}
      />

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
                onToggleRule={toggleRule}
                onRuleChanged={onRuleChanged}
                rules={rules}
                ruleOpenId={ruleOpenId}
                tagNameOf={tagNameOf}
                tagTree={tagTree}
                busy={busy}
                // mergeInto(into, from):into 在前 —— 传反了就是把目标并进自己
                onMerge={(fromId, intoId) =>
                  void act(() => workbenchApi.mergeInto(intoId, [fromId]), '已合并')
                }
                onDelete={(folderId) =>
                  void act(() => workbenchApi.deleteFolder(folderId), '已删除')
                }
                checked={checkedFolders}
                onToggleCheck={toggleCheckFolder}
                outliersByFolder={outliersByFolder}
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

      <div style={{ height: 56, flex: 'none' }} aria-hidden />
    </div>
  );
}
