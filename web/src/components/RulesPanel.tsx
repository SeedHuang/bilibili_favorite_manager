import { useCallback, useEffect, useRef, useState } from 'react';
import { App as AntApp, Button, Select, Tooltip } from 'antd';
import { Bot, Check, ChevronDown, ChevronRight, Pencil, Plus, Square, Tag, Trash2, X, Zap } from 'lucide-react';
import { rulesApi, tagApi } from '../api';
import type {
  DryRun, RuleCondition, RuleField, RuleSuggestion, RuleView, TagNode, TagProgressPayload,
  TagRunStatus,
} from '../types';
import { useAssistant } from './assistant';

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

  // ── AI 标注(spec §9E C8)── 照 `suggesting` 那套:**自己的开关,不碰 `busy`**。
  // 共用 busy 会让"标注跑着"把读规则/看建议/试跑全锁死,反过来也一样 —— §9D.5 已经踩过一次。
  // 标注服务于归类质量,和规则/试跑是同一件事的三面,所以按钮就摆在试跑旁边。
  const [tagging, setTagging] = useState(false);
  const [tagProgress, setTagProgress] = useState<TagProgressPayload | null>(null);
  /** 常显那行的两个数:打开页面取一次,每跑完一轮(成功或中断)再刷一次 */
  const [tagStatus, setTagStatus] = useState<TagRunStatus | null>(null);
  /** 中断/完成的一句话 —— warn 色,不走顶上那个红条(§9D B4) */
  const [tagNote, setTagNote] = useState('');
  /** 停止按钮要拿到**这次跑**的那个 controller */
  const tagAbort = useRef<AbortController | null>(null);
  /** 中断文案里要报"已标了多少" —— finally 会把 state 清掉,所以单独留一份(照 ChatDrawer) */
  const lastTagProgress = useRef<TagProgressPayload | null>(null);

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

  // 标注状态和规则无关,单独取一次。**拉挂了就不显示那行**:少一行,比谎报一个
  // "已标注 0 条"强 —— 也不能让它把整页的 error 条顶起来(那不是规则出的错)。
  useEffect(() => {
    tagApi.status().then(setTagStatus).catch(() => {});
  }, []);

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

  // 卸载时中止在跑的那轮标注。不作清理的话:人离开页面,SSE 还在后台排干,
  // 而按钮已经回到空闲态 —— 再点一次就会在**同一个池子上**开出第二轮同跑。
  // 只中止,不 setState(卸载后的 state 写无所谓,但没必要)
  useEffect(
    () => () => {
      tagAbort.current?.abort();
    },
    [],
  );

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

  /**
   * 跑一遍标注。**不走 `act()`** —— 它不碰规则,也不该清掉试跑结果(照 runDryRun 的道理)。
   * 开关是自己的 `tagging`,不是 `busy`:标注跑着的时候,读规则/看建议/试跑照常能用(§9D.5)。
   *
   * `scope='missing'` 只标没标过的(增量,默认),`'all'` 全量重标(「重新标注全部」走它)。
   */
  const runTag = async (scope: 'missing' | 'all') => {
    setError('');
    setTagNote('');
    setTagging(true);
    setTagProgress(null);
    lastTagProgress.current = null;
    const controller = new AbortController();
    tagAbort.current = controller;
    try {
      const r = await tagApi.run(
        scope,
        (p) => {
          setTagProgress(p);
          lastTagProgress.current = p;
        },
        { signal: controller.signal },
      );
      // `newWordCount` 是**质检的可见性**:质检只对本轮新词开口,所以"新增 900 个词、
      // 而「标签」页的上一轮变化是空的"就是它没干活(输出被截断是一条真路,服务端会记
      // TAGCHECK_EMPTY)。不显示的话这个信号在界面上根本不存在 —— 这个数服务端一直在
      // 发、注释还写着"界面上要的是这轮长了多少新词",而界面从来没读过它。
      setTagNote(
        `本轮标注完成:${r.tagged.toLocaleString()} 条 · 新增词 ${r.newWordCount.toLocaleString()} 个` +
          // 失败的批次**会留在 ai_checked_at IS NULL 里** —— 下次增量自然再试一遍,
          // 所以说清楚而不是把它当错误(§9D B4 同款语气)
          (r.failedBatches.length ? ` · ${r.failedBatches.length} 批失败(没标上的下次会再试)` : '') +
          // 一条都没标上时,只报"N 批失败"等于没说(模型都没连上,用户完全不知道
          // 为什么)—— 原因才是他唯一能照着改的东西,带上第一条的
          (r.tagged === 0 && r.failedBatches.length ? `:${r.failedBatches[0]!.reason}` : ''),
      );
    } catch (e) {
      // **停止不是错误(§9D B5)**:标注是逐批落库的,已完成的那些已经在库里了 ——
      // 说清"留了什么、再点会怎样"就够了,不用红条吓人。
      // 两处都认:用户点停止(fetch 自己抛 AbortError),以及服务端回 `aborted` 帧
      // (tagApi 抛 DOMException('已中止','AbortError'))。
      if (controller.signal.aborted || (e as Error)?.name === 'AbortError') {
        // 起跑时把它置过 null,TS 的收窄会一路带到这儿 —— 显式写回类型(照 ChatDrawer)
        const last = lastTagProgress.current as TagProgressPayload | null;
        setTagNote(`已中断:已标 ${(last?.done ?? 0).toLocaleString()} 条 · 已完成的保留在库里,再点会接着标`);
      } else {
        setError((e as Error).message);
      }
    } finally {
      tagAbort.current = null;
      setTagging(false);
      setTagProgress(null);
      // 落库是**逐批**的,所以成功和中断都得刷新状态行;拉挂了也不能顶掉上面那句话
      await tagApi.status().then(setTagStatus).catch(() => {});
    }
  };

  /** 「重新标注全部」= 全量重标,**会覆盖旧标注**(spec §9E.4),所以先问一句 */
  const retagAll = () =>
    modal.confirm({
      title: '把所有条目重新标一遍?',
      content: '已有的标注会被覆盖(标签和类别都重写)。只想补没标过的,点「AI 标注」就行。',
      okText: '全部重标', cancelText: '算了',
      onOk: () => void runTag('all'),
    });

  const current = rules.find((r) => r.folderId === open);
  const withRules = rules.filter((r) => !r.locked && hasRule(r)).length;
  /** 有哪个夹子还没真正写规则 —— 没有的话「新增规则」就没地方可加,按钮该是灰的 */
  const canAddRule = rules.some((r) => !r.locked && !hasRule(r));

  /**
   * 这轮会拿哪个模型打标 —— status 专门报 `source` 就是为了这一句(tagRoutes 的注释原话):
   * 不说的话用户以为在烧本地 4b,实际每批都在打贵的主模型。两个模型都没配就没有提示。
   */
  const tagModelHint = !tagStatus?.model
    ? ''
    : tagStatus.model.source === 'tag'
      ? `用 ${tagStatus.model.provider}/${tagStatus.model.model}`
      : '当前用主模型打标 —— 想省成本可在授权页配本地小模型';

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
            {/* 两态(§9D B1):空闲 = 开始增量,运行中 = 停止。**不绑 busy** ——
                它自己在跑的时候,旁边三个按钮照样能点(§9D.5) */}
            <Button
              size="small"
              danger={tagging}
              icon={tagging ? <Square size={13} /> : <Tag size={13} />}
              onClick={() => (tagging ? tagAbort.current?.abort() : void runTag('missing'))}
            >
              {tagging ? '停止' : 'AI 标注'}
            </Button>
          </span>
        </div>

        {/* ── 标注状态行(spec §9E C8)── 常显:标注服务于归类质量,首屏就该看到
            "标了多少、这轮用哪个模型"。跑起来换成进度行(§9D.2:数字走 num 等宽,位数不抖) ── */}
        {(tagStatus || tagging) && (
          <div style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)', marginBottom: 8 }}>
            {tagging ? (
              <>
                标注中:已标{' '}
                <span className="num" style={{ color: 'var(--accent)' }}>
                  {(tagProgress?.done ?? 0).toLocaleString()}
                </span>
                {/* 第一帧还没到时不知道本轮的分母 —— 增量跑的是"缺的那些",不等于全库总数,
                    硬报一个会紧跟着跳一下。所以先不报,不是省事 */}
                {(tagProgress?.total ?? 0) > 0 && (
                  <>/<span className="num">{(tagProgress?.total ?? 0).toLocaleString()}</span></>
                )}{' '}
                条
              </>
            ) : (
              <>
                已标注 <span className="num">{(tagStatus?.tagged ?? 0).toLocaleString()}</span>
                /<span className="num">{(tagStatus?.total ?? 0).toLocaleString()}</span> 条
                {' · '}
                <Button
                  type="link" size="small"
                  style={{ padding: 0, fontSize: 'var(--fs-12)' }}
                  onClick={retagAll}
                >
                  重新标注全部
                </Button>
              </>
            )}
            {tagModelHint && <> · {tagModelHint}</>}
          </div>
        )}

        {/* 中断/完成的话 —— warn 色,不用顶上那个红条(§9D B4) */}
        {tagNote && (
          <div style={{ fontSize: 'var(--fs-12)', color: 'var(--warn)', marginBottom: 8 }}>{tagNote}</div>
        )}

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
      </div>

      <div style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>
        规则命中的条目会<span style={{ color: 'var(--accent)' }}> 0 token 直接归位</span>,
        剩下的才交给 AI。一条条目可以同时命中多个夹子 —— 那就都归(B站 本来也允许)。
      </div>
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
