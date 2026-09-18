import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, App as AntApp, Button, Progress, Select, Spin } from 'antd';
import { Combine, Pencil, Check, Square, Tag, X, Trash2, ScrollText } from 'lucide-react';
import { useRequest } from '@umijs/max';
import { rawResult, tagApi } from '../api';
import type { TagLogLine, TagNode, TagProgressPayload, TagRunStatus } from '../types';
import TagTree from './TagTree';
import TagLogDrawer from './TagLogDrawer';

/**
 * 词库治理 —— 四层:顶上「AI 标注」(这一跑长出下面的一切)、「树的变化」清单、
 * 那棵树、行内操作。
 *
 * **这一页不做自动整理** —— 整理在标注跑完时自动发生(§9F C10)。这里只有
 * "按下这一跑"、"看它变成了什么"和"手动纠正"。用户的原话是"我不想管",所以不设审批闸;
 * 但结构必须**看得见**在长什么,这一页就是那个"看得见"。
 */
export default function TagPanel() {
  // state 全放在取数前面 —— 下面那个 `onError` 要写 `setError`,把它写在声明上面
  // 读起来像"用了一个还没声明的变量"(其实不会:回调只在渲染之后跑,没有 TDZ)
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');

  // ── AI 标注(spec §9E C8)── **专用开关、不碰 `busy`**。
  // 共用 busy 会让"标注跑着"把改名/合并/删除全锁死,反过来也一样 —— §9D.5 已经踩过一次。
  //
  // **入口在这一页,不在「规则」页**(§9F 改址)── §9E C8 当初把它摆在规则页,理由是
  // "标注服务于归类质量,和规则/试跑是同一件事的三面"。§9F 改掉了那个前提:这一跑会
  // **长出词库树**(C5),而树有自己的页面 —— 让"产出这一页全部内容的动作"要求用户
  // 去别处按,说不通。所以搬过来,规则页那边不再留副本。
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

  // ── 标注日志(§9D.7)──────────────────────────────────
  // **缓冲区放在这一页,不在抽屉里**:关掉抽屉不能丢,而"关掉就没了"正是用户两次
  // 报过的那个错("跑完了,我不知道刚才发生了什么")的另一种形态。跑完仍可读,
  // 直到页面刷新。
  const [logLines, setLogLines] = useState<TagLogLine[]>([]);
  const [logOpen, setLogOpen] = useState(false);
  /** 按钮角标要报的 warn 数 —— 失败不打开抽屉也要看得见 */
  const logWarn = logLines.filter((l) => l.type === 'note' && l.level === 'warn').length;
  // **合并写**:日志帧是每条/每词一发,全库一轮几千帧 —— 一帧一 `setLogLines`
  // 就是几千次整页重渲染,而这恰恰发生在用户**正盯着这一页**看的那段时间。
  // 新行先攒进 ref,按固定节奏一次性倒进 state(见 runTag 里 onLog 那段)。
  // **只推迟渲染,不丢行**:ref 攒着,后台跑完切回来也全在
  const logPending = useRef<TagLogLine[]>([]);
  const logFlushScheduled = useRef(false);

  // **拉挂了必须出声**(和「规则」页那棵树的取法一致)。少了 onError,一次 500
  // 或后端没起来渲染出来的就是下面那句"词库还是空的。点上面的「AI 标注」"
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

  // 标注状态和词库无关,单独取一次。**拉挂了就不显示那行**:少一行,比谎报一个
  // "已标注 0 条"强 —— 也不能让它把整页的 error 条顶起来(那不是词库出的错)。
  useEffect(() => {
    tagApi.status().then(setTagStatus).catch(() => {});
  }, []);

  // 卸载时中止在跑的那轮标注。不作清理的话:人离开页面,SSE 还在后台排干,
  // 而按钮已经回到空闲态 —— 再点一次就会在**同一个池子上**开出第二轮同跑。
  // 只中止,不 setState(卸载后的 state 写无所谓,但没必要)
  useEffect(
    () => () => {
      tagAbort.current?.abort();
    },
    [],
  );

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

  /**
   * 跑一遍标注。**不走 `act()`** —— 那个外壳会置 `busy`,而这一跑有自己的开关
   * `tagging`:标注跑着的时候,改名/合并/删除照常能用(§9D.5)。
   *
   * 反过来,`act()` 顺手做的那件事这里**必须**做:跑完重拉树和「上一轮变化」——
   * 这一跑产出的就是它们俩(§9F C5),不拉的话界面还停在旧树上,而上面刚刚报完
   * "新增词 N 个"。
   *
   * `scope='missing'` 只标没标过的(增量,默认),`'all'` 全量重标(「重新标注全部」走它)。
   */
  /**
   * 把攒着的日志行倒进 state —— **计时器里唯一的动作**。
   *
   * 为什么不在 onLog 里直接 setLogLines:那样一帧一次整页重渲染(见上面那段)。
   * 这个函数只干"清空待写 + 追加"两件事,留给 setTimeout 一个稳定的闭包
   */
  const flushLog = useCallback(() => {
    logFlushScheduled.current = false;
    if (logPending.current.length === 0) return; // 空批别碰 state
    const batch = logPending.current;
    logPending.current = [];
    setLogLines((ls) => [...ls, ...batch]);
  }, []);

  const runTag = async (scope: 'missing' | 'all') => {
    setError('');
    setTagNote('');
    setTagging(true);
    setTagProgress(null);
    // 新的一轮,日志从零开始(§9D.7)—— 上一轮的留在缓冲区里会把两轮混成一团。
    // **ref 里的残批也一起清** —— 上一轮末尾 100ms 内可能还攒着没倒完的行,
    // 不清的话它们会在新轮开跑后跟着第一轮 flush 冒出来,污染新日志
    setLogLines([]);
    logPending.current = [];
    logFlushScheduled.current = false;
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
        {
          signal: controller.signal,
          // 日志四种帧全进同一个缓冲区(§9D.7)。**先清空再开跑** —— 上一轮的日志
          // 是上一轮的,留着会和这一轮混成一片分不清。
          // 帧先进 ref,按 100ms 节奏整批倒进 state —— 一帧一 setState 的话,
          // 全库几千帧 = 几千次整页重渲染(合并写,见上面那段注释)
          onLog: (l) => {
            logPending.current.push(l);
            if (logFlushScheduled.current) return; // 已在排队,别堆计时器
            logFlushScheduled.current = true;
            // **固定节奏而不是 rAF**:rAF 在标签页切后台时不触发,行会一直攒到用户
            // 切回来 —— 那正是他"回来看看跑完没"的时刻,不该让日志在那之后才挤出来。
            // 100ms:行跟着跑动刷新不粘手,又不至于为省几次渲染把人晾着
            setTimeout(flushLog, 100);
          },
        },
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
      // 落库是**逐批**的,所以成功和中断都得刷新:状态行要重算"已标 N/M",树和
      // 「上一轮变化」也要重拉 —— 中断时已落库的那几批同样长在树上。
      //
      // **三个都得吞掉自己的错误**:这里在 `finally` 里,调用方又是 `void runTag(...)`,
      // 没人接住的 rejection 会直接冒成 unhandled —— 后端一挂,一次普通的刷新失败就
      // 会变成控制台的报错。而且 `refreshChanges` 没有 `onError`,不吞的话它单独失败
      // 就会变成"上面报着「新增词 N 个」、下面「上一轮变化」静悄悄停在旧数据"。
      // 树那下来的错不吞也白搭:`useRequest` 的 `onError` 已经会画红条,这里吞掉
      // 不隐藏任何东西。
      await Promise.all([
        tagApi.status().then(setTagStatus).catch(() => {}),
        refreshTree().catch(() => {}),
        refreshChanges().catch(() => {}),
      ]);
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
   *
   * 两句都不适用时(既没子词、自己也没挂着视频)给一句兜底 —— 那种词删掉**什么都不影响**,
   * 而一个空白的对话框会让人以为"是不是没加载出来"。
   */
  const confirmDelete = (node: TagNode) =>
    modal.confirm({
      title: `从词库里删掉「${node.name}」?`,
      content:
        [
          node.children.length > 0
            ? `它下面还有 ${node.children.length} 个词,那些词会回到顶层(不是它的上一级),不会被删。`
            : '',
          node.count > 0 ? `挂着它的 ${node.count} 条视频会失去这个标签,视频本身不会动。` : '',
        ].join('') || '这个词没有挂着任何视频,删掉不影响别的东西。',
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

  /**
   * 这轮会拿哪个模型打标 —— status 专门报 `source` 就是为了这一句(tagRoutes 的注释原话):
   * 不说的话用户以为在烧本地 4b,实际每批都在打贵的主模型。两个模型都没配就没有提示。
   */
  const tagModelHint = !tagStatus?.model
    ? ''
    : tagStatus.model.source === 'tag'
      ? `用 ${tagStatus.model.provider}/${tagStatus.model.model}`
      : '当前用主模型打标 —— 想省成本可在授权页配本地小模型';

  /**
   * 进度条要的那一个数。**分母为 0 时给 0** —— 空池子(一条待标的都没有)下
   * `done/total` 是 `0/0` = NaN,而 `0/0` 根本不是个数:0% 才是真话,这一跑确实
   * 没有可标的东西。(antd 内部会把 NaN 夹成 0 —— `progress/utils.js` 的
   * `validProgress` 用 `!progress` 一把捞掉 —— 所以条不会真的画坏;但那**是它的
   * 实现细节**,不该由我们依赖,该由我们说出 0。)
   *
   * 取**下取整**不四舍五入:199/200 舍上去就是 100% —— "还没跑完却报跑完了",
   * 而进度条正好卡在 100% 不动(下一批还在跑),比停在 99% 更让人以为卡死。
   */
  const tagPct =
    tagProgress && tagProgress.total > 0
      ? Math.floor((tagProgress.done / tagProgress.total) * 100)
      : 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {error && <Alert type="error" showIcon closable message={error} onClose={() => setError('')} />}

      {/* ── AI 标注(spec §9E C8)置顶:树和「上一轮变化」都是这一跑长出来的,入口就该在它们上面。
          两态(§9D B1):空闲 = 开始增量,运行中 = 停止。**不绑 busy** ——
          它自己在跑的时候,下面的改名/合并/删除照样能点(§9D.5) ── */}
      <div className="hud-panel" style={{ padding: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="hud-label">AI 标注</span>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            {/* 日志按钮**永远可点**(§9D.7)—— 跑着能看当下,跑完能看这一轮。
                角标带 warn 数:失败不打开抽屉也看得见。icon 只在"有内容"时才出现,
                否则一枚空按钮加一个假数字,比"看起来没事"更绕 */}
            <Button
              size="small"
              icon={<ScrollText size={13} />}
              onClick={() => setLogOpen(true)}
            >
              日志
              {logWarn > 0 && (
                <span className="num" style={{ color: 'var(--warn)', marginLeft: 4 }}>
                  {logWarn}
                </span>
              )}
            </Button>
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

        {/* 常显:首屏就该看到"标了多少、这轮用哪个模型"。跑起来换成进度行
            (§9D.2:数字走 num 等宽,位数不抖) */}
        {(tagStatus || tagging) && (
          <div style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)', marginTop: 8 }}>
            {tagging ? (
              <>
                标注中:已标{' '}
                <span className="num" style={{ color: 'var(--accent)' }}>
                  {(tagProgress?.done ?? 0).toLocaleString()}
                </span>
                {/* 分母是**这一跑自己的池子大小**(增量跑的是"缺的那些",不是全库总数)——
                    服务端在第一批之前先发一帧把它带过来,所以它「一开始就知道」,不是等出来的。
                    这个 `> 0` 只兜两件小事:那一帧还在路上的一瞬,和空池子(total=0 时
                    报分母等于报"没有可标的",那行数字反而更绕) */}
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

        {/* 进度条 —— 只在跑的时候有(空闲那行说的是"库里标了多少",不是一次跑的进度,
            给它配一根条会让人以为有个东西正在动)。
            §9D.2 那行等宽数字照旧是准确读数,这根条是**一眼看到大概到哪**;
            颜色走 `--accent`(不留给 antd 的默认色:`Progress` 用的是 `colorInfo`,
            主题里那几个色(primary/error/success/warning 和底色)都改过,唯独没碰
            `colorInfo` —— 它还是 antd 种子里的蓝 #1677ff,和这块面板的青色对不上) */}
        {tagging && (
          <div style={{ marginTop: 6 }}>
            <Progress percent={tagPct} size="small" strokeColor="var(--accent)" />
          </div>
        )}

        {/* 中断/完成的话 —— warn 色,不用顶上那个红条(§9D B4) */}
        {tagNote && (
          <div style={{ fontSize: 'var(--fs-12)', color: 'var(--warn)', marginTop: 8 }}>{tagNote}</div>
        )}
      </div>

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
          // 拉失败时那句"点一次 AI 标注"是**照它做要花钱**的建议,不能挂在一次
          // 失败的取数上(红条已经在上面了)
          <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--text-dim)', fontSize: 'var(--fs-13)' }}>
            {treeError
              ? '词库没拉下来 —— 看上面那条报错'
              : '词库还是空的。点上面的「AI 标注」,它会自己长出来'}
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

      {/* 日志抽屉(§9D.7)。**开/关由这一页管** —— 按钮在这里,抽屉自己开就跟它脱节了。
          缓冲区和清空也在这里:`onClear` 清的是这一页手里的 state,关抽屉再开不丢 */}
      <TagLogDrawer
        open={logOpen}
        onClose={() => setLogOpen(false)}
        lines={logLines}
        onClear={() => setLogLines([])}
      />
    </div>
  );
}
