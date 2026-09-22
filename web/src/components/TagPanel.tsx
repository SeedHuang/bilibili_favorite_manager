import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, App as AntApp, Button, Input, Progress, Radio, Select, Spin } from 'antd';
import { Combine, Pencil, Check, Square, Tag, X, Trash2, ScrollText, Eraser, ScanSearch } from 'lucide-react';
import { useRequest, useSearchParams } from '@umijs/max';
import { rawResult, settingsApi, tagApi } from '../api';
import type { Item, TagCheckProgressPayload, TagLogLine, TagNode, TagProgressPayload, TagRunStatus } from '../types';
import TagTree from './TagTree';
import TagLogDrawer from './TagLogDrawer';
import TagItemPane from './TagItemPane';
import ContextPane from './ContextPane';

/**
 * 词库治理 + 按词看视频 —— 顶上「AI 标注」横栏(锁顶),下面一行三列:
 * 树列(300px,自己滚)| TagItemPane(选中的词 → 视频墙)| ContextPane(详情)。
 * 整页锁死(overflow:hidden),滚动只发生在各列内部 —— 不然树一长就把详情栏顶出屏。
 *
 * **这一页不做自动整理** —— 整理在标注跑完时自动发生(§9F C10)。这里只有
 * "按下这一跑"、"看它变成了什么"和"手动纠正"。用户的原话是"我不想管",所以不设审批闸;
 * 但结构必须**看得见**在长什么,这一页就是那个"看得见"。
 *
 * 选中的词存 URL(`?tag=`):刷新和后退键都还在原地,树列的「清除」按钮把它抹掉。
 */
export default function TagPanel() {
  // state 全放在取数前面 —— 下面那个 `onError` 要写 `setError`,把它写在声明上面
  // 读起来像"用了一个还没声明的变量"(其实不会:回调只在渲染之后跑,没有 TDZ)
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');

  // ── 树选中(照 BrowsePanel)── 存 URL 不放 state:刷新/后退都在原地。
  // 选中条目的详情 ContextPane 要,角标的排除名 findName 要,都在这一层收口。
  const [params, setParams] = useSearchParams();
  const tagId = Number(params.get('tag')) || null;
  const [selectedItem, setSelectedItem] = useState<Item | null>(null);
  // tagId 是 URL 派生的:后退/前进或粘贴 ?tag= 都会改它而不走 pick ——
  // 旧选中项已不属于当前词,清掉,别让详情栏挂着上一个词下的视频
  useEffect(() => { setSelectedItem(null); }, [tagId]);
  /** 选中项的标签列表 —— TagItemPane 手里有 tagsOf,由它上报(它取数它报数) */
  const [selectedItemTags, setSelectedItemTags] = useState<string[]>([]);

  // ── AI 标注(spec §9E C8)── **专用开关、不碰 `busy`**。
  // 共用 busy 会让"标注跑着"把改名/合并/删除全锁死,反过来也一样 —— §9D.5 已经踩过一次。
  //
  // **入口在这一页,不在「规则」页**(§9F 改址)── §9E C8 当初把它摆在规则页,理由是
  // "标注服务于归类质量,和规则/试跑是同一件事的三面"。§9F 改掉了那个前提:这一跑会
  // **长出词库树**(C5),而树有自己的页面 —— 让"产出这一页全部内容的动作"要求用户
  // 去别处按,说不通。所以搬过来,规则页那边不再留副本。
  const [tagging, setTagging] = useState(false);
  const [tagProgress, setTagProgress] = useState<TagProgressPayload | null>(null);
  /** 手动质检的运行态 —— 和 tagging 同一套三件套(进度/轮询/停止) */
  const [checking, setChecking] = useState(false);
  const [checkProgress, setCheckProgress] = useState<TagCheckProgressPayload | null>(null);
  /** 常显那行的两个数:打开页面取一次,每跑完一轮(成功或中断)再刷一次 */
  const [tagStatus, setTagStatus] = useState<TagRunStatus | null>(null);
  /** 中断/完成的一句话 —— warn 色,不走顶上那个红条(§9D B4) */
  const [tagNote, setTagNote] = useState('');
  /** 中断文案里要报"已标了多少" —— 轮询结束会清 state,所以单独留一份 */
  const lastTagProgress = useRef<TagProgressPayload | null>(null);
  /** 当前活动轮询的停止函数 —— runTag/质检/恢复三个入口共用,卸载时统一清理 */
  const stopPollingRef = useRef<(() => void) | null>(null);

  // 任务三件套(spec §2):轮询间隔按任务可配,挂载时拉一次设置。
  // ref 而不是 state:间隔只被 setTimeout 读,不该为它整页重渲染。
  // 拉失败兜底 500ms 保持现节奏;配置返回的 tag/tagcheck 默认是 2000/3000ms
  const tagIntervalRef = useRef(500);
  const checkIntervalRef = useRef(500);
  useEffect(() => {
    settingsApi.getPolls()
      .then((polls) => {
        if (polls.tag) tagIntervalRef.current = polls.tag.intervalMs;
        if (polls.tagcheck) checkIntervalRef.current = polls.tagcheck.intervalMs;
      })
      .catch(() => {}); // 拉不到照旧 500ms
  }, []);

  // ── 标注日志(§9D.7)──────────────────────────────────
  // **缓冲区放在这一页,不在抽屉里**:关掉抽屉不能丢,而"关掉就没了"正是用户两次
  // 报过的那个错("跑完了,我不知道刚才发生了什么")的另一种形态。跑完仍可读,
  // 直到页面刷新。
  const [logLines, setLogLines] = useState<TagLogLine[]>([]);
  const [logOpen, setLogOpen] = useState(false);
  /** 按钮角标要报的 warn 数 —— 失败不打开抽屉也要看得见 */
  const logWarn = logLines.filter((l) => l.type === 'note' && l.level === 'warn').length;
  // 日志从 `run-progress` 轮询里全量取 —— 后端累积,前端按配置的间隔一拍替换 state,
  // 天然就是合并写节奏(不需要 SSE 时代那套 ref + 100ms flush)。

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
  // 词库健康度(M4h):活跃词数是整理成本的决定量,和树一起刷 —— 标注跑完、手动
  // 合并都会改变它。拉挂了就不显示那行(和上面 status 同一个待遇:少一行,不谎报)
  const { data: stats, refresh: refreshStats } = useRequest(() => tagApi.reconcileStats(), {
    formatResult: rawResult,
  });
  // 静态 Modal.confirm 拿不到 ConfigProvider 的主题,必须走 App.useApp()
  const { modal } = AntApp.useApp();

  // 标注状态和词库无关,单独取一次。**拉挂了就不显示那行**:少一行,比谎报一个
  // "已标注 0 条"强 —— 也不能让它把整页的 error 条顶起来(那不是词库出的错)。
  useEffect(() => {
    tagApi.status().then(setTagStatus).catch(() => {});
  }, []);

  /** 写操作的统一外壳:清错误 → 忙 → 执行 → 重拉 → 失败报错。返回成功与否 */
  const act = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setError('');
    setBusy(true);
    try {
      await fn();
      await Promise.all([refreshTree(), refreshChanges(), refreshStats()]);
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
   * `scope='missing'` 只标没标过的(增量,弹窗默认),`'all'` 全量重标(弹窗选项走它)。
   */

  /**
   * 跑完(成功/中断/失败)的收尾:落库是**逐批**的,所以都得刷新 —— 状态行要重算
   * "已标 N/M",树和「上一轮变化」也要重拉(中断时已落库的那几批同样长在树上)。
   */
  const finishPoll = useCallback(async () => {
    await Promise.all([
      tagApi.status().then(setTagStatus).catch(() => {}),
      refreshTree().catch(() => {}),
      refreshChanges().catch(() => {}),
      refreshStats().catch(() => {}),
    ]);
  }, [refreshTree, refreshChanges, refreshStats]);

  /**
   * 开始轮询 `run-progress` 并驱动界面。**`runTag` 和"重进页面恢复"都走它**。
   *
   * 用 `setTimeout` 递归而不是 `setInterval`:上一拍还没回来就不发下一拍,
   * 天然不会重叠(轮询慢于配置的间隔时也稳定)。
   */
  const startPolling = useCallback(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    // 请求在途时被停:timer 还是 null,clearTimeout 清不掉 —— 用 stopped 挡在
    // 重排之前,否则这一拍回来照旧 setTimeout(tick, 配置的间隔),轮询永远停不下来
    const stopTimer = () => { stopped = true; if (timer) clearTimeout(timer); };

    const tick = async () => {
      try {
        const p = await tagApi.getRunProgress();
        if (stopped) return;
        setTagProgress({ done: p.done, total: p.total, tagged: p.tagged });
        lastTagProgress.current = { done: p.done, total: p.total, tagged: p.tagged };
        // 日志从后端累积数组全量替换。**没新行就不 set** —— 否则每一拍(配置的间隔)
        // 整棵 TagTree 跟着重渲染(后端 append-only,长度没变就是没变)
        setLogLines((prev) => (prev.length === p.logs.length ? prev : p.logs));

        if (p.error) {
          setError(p.error);
          setTagging(false);
          await finishPoll();
          return;
        }
        if (!p.running) {
          if (p.result) {
            const r = p.result;
            // `newWordCount` 是**质检的可见性**:质检只对本轮新词开口,所以"新增 900 个词、
            // 而「标签」页的上一轮变化是空的"就是它没干活(输出被截断是一条真路,服务端会记
            // TAGCHECK_EMPTY)。不显示的话这个信号在界面上根本不存在 —— 这个数服务端一直在
            // 发、注释还写着"界面上要的是这轮长了多少新词",而界面从来没读过它。
            if (r.tagged === 0 && r.failedBatches.length === 0) {
              // **空池子没有"本轮"** —— 服务端一个模型调用都没发(池子里全是标过的,
              // 剩下的只有已失效)。报「完成 0 条 · 新增 0 个」就是用户这次撞上的那句谎话:
              // 它读起来像"跑过了但什么都没标上",而真相是"没什么可跑的"。分开说。
              // (非空池子不会走到这里:模型对每批都回空的话,补两轮会把它记成失败批次 ——
              // 所以 tagged=0 且零失败只可能是空池子)
              setTagNote('没有需要标注的条目(有效的都标过了)');
            } else {
              setTagNote(
                `本轮标注完成:${r.tagged.toLocaleString()} 条 · 新增词 ${r.newWordCount.toLocaleString()} 个` +
                  // 失败的批次**会留在 ai_checked_at IS NULL 里** —— 下次增量自然再试一遍,
                  // 所以说清楚而不是把它当错误(§9D B4 同款语气)
                  (r.failedBatches.length ? ` · ${r.failedBatches.length} 批失败(没标上的下次会再试)` : '') +
                  // 一条都没标上时,只报"N 批失败"等于没说(模型都没连上,用户完全不知道
                  // 为什么)—— 原因才是他唯一能照着改的东西,带上第一条的
                  (r.tagged === 0 && r.failedBatches.length ? `:${r.failedBatches[0]!.reason}` : ''),
              );
            }
          } else {
            // running=false 且 result=null = 被中止(§9D B5,停止不是错误):
            // 标注是逐批落库的,已完成的那些已经在库里了 —— 说清"留了什么、再点会怎样"
            const last = lastTagProgress.current as TagProgressPayload | null;
            setTagNote(`已中断:已标 ${(last?.done ?? 0).toLocaleString()} 条 · 已完成的保留在库里,再点会接着标`);
          }
          setTagging(false);
          await finishPoll();
          return;
        }
      } catch {
        // 单次轮询失败不炸 —— 下一拍再试(后端瞬断不该让界面卡死在"标注中")
      }
      if (stopped) return;
      timer = setTimeout(tick, tagIntervalRef.current);
    };

    void tick();
    return stopTimer;
  }, [finishPoll]);

  const runTag = async (scope: 'missing' | 'all') => {
    setError('');
    setTagNote('');
    setTagging(true);
    setTagProgress(null);
    // 新的一轮,日志从零开始(§9D.7)—— 上一轮的留在 state 里会把两轮混成一团
    setLogLines([]);
    lastTagProgress.current = null;

    try {
      // 启动即返回;真正的"跑完/中断"由轮询从 run-progress 里读到
      await tagApi.startRun(scope);
    } catch (e) {
      setTagging(false);
      setError((e as Error).message);
      return;
    }
    stopPollingRef.current?.();
    stopPollingRef.current = startPolling();
  };

  // **重进页面恢复**:后端可能还有一轮在跑(用户上次离开时没停,后台继续标了)。
  // 进页面先查一次 run-progress —— 还在跑就把界面恢复成"标注中"并接管轮询。
  // 这样用户一进来就看到真相,想停点「停止」就真停了。
  /**
   * 启动标注(spec 规则 3):按钮只表明任务,弹窗交代范围。话术与词库质检的
   * confirmTagCheck 同一模板:继续X(默认)/ 全部重X(后果红字)——
   * 两个弹窗是同一个 UI 模式,用户学一次就会两个。
   */
  const confirmTagRun = () => {
    let scope: 'missing' | 'all' = 'missing';
    modal.confirm({
      title: 'AI 标注',
      content: (
        <div style={{ fontSize: 13 }}>
          <div style={{ color: 'var(--text-dim)', marginBottom: 10 }}>
            让模型逐个判定条目的标签和类别;跑的过程在「日志」里全程可见。
            已标 {(tagStatus?.tagged ?? 0).toLocaleString()}/{(tagStatus?.total ?? 0).toLocaleString()}。
          </div>
          {/* 非受控(同 confirmTagCheck):content 只求值一次,onChange 只更新闭包 */}
          <Radio.Group defaultValue="missing" onChange={(e) => { scope = e.target.value; }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Radio value="missing">继续标注 —— 只标还没标过的(之前漏的 + 这次新收的)</Radio>
              <Radio value="all">
                全部重标 —— 对所有条目重新标注,包括已有标注的。
                <b style={{ color: 'var(--warn)' }}>已有标注会被覆盖</b>,慎选
              </Radio>
            </div>
          </Radio.Group>
        </div>
      ),
      okText: '开始标注',
      cancelText: '算了',
      onOk: () => void runTag(scope),
    });
  };

  /** 清空标注:高危、不可撤销,必须输入「清空」二字才可点确定(二次确认) */
  const confirmClearTags = () => {
    let typed = '';
    const inst = modal.confirm({
      title: '清空所有标注?',
      content: (
        <div style={{ fontSize: 13 }}>
          <div style={{ color: 'var(--text-dim)', marginBottom: 8 }}>
            会把 <b>整棵词库树</b>(tags + 条目关联)和所有条目的 AI 标注一起删掉,
            规则里的标签条件也会移除。这个动作<b>不可撤销</b> —— 想测「继续标注」
            性能时,用它回到「从没标过」的状态。
          </div>
          <div style={{ color: 'var(--text-dim)', marginBottom: 4 }}>输入「清空」以确认:</div>
          {/* 受控 bug:value 绑的是闭包变量不是 state,modal 重渲染会把它重置成初始值,
              用户打的字被 React 还原 → 「清空」永远打不进去。改非受控,onChange 照常累积 */}
          <Input
            autoFocus
            onChange={(e) => {
              typed = e.target.value;
              // HookModal.update 顶层浅合并,okButtonProps 整体替换 —— 丢了 danger
              // 就没了红底(不可撤销的破坏性操作,红警示不能丢),所以补回
              inst.update({ okButtonProps: { danger: true, disabled: typed !== '清空' } });
            }}
            style={{ width: '100%' }}
          />
        </div>
      ),
      okText: '清空',
      okButtonProps: { danger: true, disabled: true },
      cancelText: '算了',
      onOk: async () => {
        await act(async () => {
          await tagApi.clearTags();
          setTagNote('已清空标注 —— 所有条目回到未标注状态');
        });
        // act 只刷 tree/changes/stats;按钮态靠 tagStatus 算,清空后要一起刷回 0
        await tagApi.status().then(setTagStatus).catch(() => {});
      },
    });
  };

  /**
   * 手动质检的轮询 —— 照 startPolling(标注)的结构:按配置的间隔一拍、stopped 标志防
   * 竞态、跑完刷树/变化/健康度。日志(verdict 带 reason)进同一个抽屉。
   */
  const startCheckPolling = useCallback(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const stopTimer = () => { stopped = true; if (timer) clearTimeout(timer); };

    const tick = async () => {
      try {
        const p = await tagApi.getCheckProgress();
        console.log('[check-poll] tick', JSON.stringify({ running: p.running, done: p.done, total: p.total, logs: p.logs?.length, error: p.error }));
        if (stopped) return;
        setCheckProgress({ done: p.done, total: p.total });
        setLogLines((prev) => (prev.length === p.logs.length ? prev : p.logs));

        if (p.error) {
          console.log('[check-poll] 出错收尾', p.error);
          setError(p.error);
          setChecking(false);
          await finishPoll();
          return;
        }
        if (!p.running) {
          console.log('[check-poll] 跑完收尾', JSON.stringify(p.result));
          if (p.result) {
            const r = p.result;
            // checked=0 = 根本没词可检(没跑过标注/库空),和"检完都没问题"分开说
            setTagNote(
              r.checked === 0
                ? '质检完成 —— 没有可检的词(还没跑过标注,或词库是空的)'
                : `质检完成(查了 ${r.checked.toLocaleString()} 个词):删 ${r.dropped} · 合 ${r.merged} · 挪 ${r.moved}`,
            );
          } else {
            setTagNote('已中断:已判定的词保留在库里');
          }
          setChecking(false);
          await finishPoll();
          return;
        }
      } catch {
        // 单次轮询失败不炸 —— 下一拍再试
      }
      if (stopped) return;
      timer = setTimeout(tick, checkIntervalRef.current);
    };

    void tick();
    return stopTimer;
  }, [finishPoll]);

  // **重进页面恢复**:标注或手动质检可能还在后台跑(用户切走没停)。进页面先查
  // 两处 run-progress / check-progress —— 在跑就恢复界面并接管轮询。
  // **卸载不中止后端** —— 用户在跑着时关页面/切走,后台照常跑完(逐批落库,
  // 停了才是浪费)。下次进来由这个 effect 接管。
  useEffect(() => {
    let cancelled = false;
    // resolve 前可能已卸载 —— 用 cancelled 挡在启动轮询之前,不然泄漏一个
    // 在已卸载组件上 setState 的轮询
    tagApi.getRunProgress().then((p) => {
      if (cancelled || !p.running) return;
      setTagging(true);
      setTagProgress({ done: p.done, total: p.total, tagged: p.tagged });
      setLogLines(p.logs);
      stopPollingRef.current?.();
      stopPollingRef.current = startPolling();
    }).catch(() => {});
    // 手动质检也要恢复 —— 后端在跑时切走再回来,同样接管轮询
    tagApi.getCheckProgress().then((p) => {
      if (cancelled || !p.running) return;
      setChecking(true);
      setCheckProgress({ done: p.done, total: p.total });
      setLogLines(p.logs);
      stopPollingRef.current?.();
      stopPollingRef.current = startCheckPolling();
    }).catch(() => {});
    return () => {
      cancelled = true;
      stopPollingRef.current?.();
      stopPollingRef.current = null;
    };
  }, [startPolling, startCheckPolling]);

  /** 手动质检:弹窗单选范围。「全部审查」会删模型判定为泛词的词,不可逆,默认不选 */
  const confirmTagCheck = () => {
    let scope: 'continue' | 'all' = 'continue';
    modal.confirm({
      title: '词库质检',
      content: (
        <div style={{ fontSize: 13 }}>
          <div style={{ color: 'var(--text-dim)', marginBottom: 10 }}>
            跑一遍质检,模型会逐个判定词的去向 —— 泛词该删、重复词该并、归错层的该挪。
          </div>
          {/* 非受控(照 confirmClearTags 的 Input):content 只在调用时求值一次,
              value 绑定会把 'continue' 冻结进不可变 element,inst.update 也换不走 ——
              onChange 只更新闭包 scope 供 onOk 读。defaultValue 补上默认勾选
              (非受控下缺了它,初始一个都不勾) */}
          <Radio.Group
            defaultValue="continue"
            onChange={(e) => {
              scope = e.target.value;
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Radio value="continue">继续质检 —— 只检还没质检过的词(之前漏的 + 这次新长的)</Radio>
              <Radio value="all">
                全部重检 —— 对词库里所有词重新判定,包括已有词。模型可能把挂得多的大类词
                判为"泛词"而删掉。<b style={{ color: 'var(--warn)' }}>删词不可逆</b>,慎选
              </Radio>
            </div>
          </Radio.Group>
        </div>
      ),
      okText: '开始质检',
      cancelText: '算了',
      onOk: () => {
        // 照 runTag:启动即返回,进度/判定/理由靠轮询 check-progress,日志抽屉全程可见
        console.log('[check-ui] 点了开始质检 scope=' + scope + ' —— 进入运行态');
        setError('');
        setTagNote('');
        setLogLines([]);
        setChecking(true);
        setCheckProgress(null);
        // **先等启动请求返回,再开轮询** —— 不然第一拍 tick 读到后端还没初始化的
        // running:false,把"还没开跑"当成"跑完了",轮询直接收尾(实测踩过的竞态)
        tagApi.tagcheck(scope).then(() => {
          console.log('[check-ui] 后端已接受启动(tagcheck 返回 ok)—— 开始轮询');
          stopPollingRef.current?.();
          stopPollingRef.current = startCheckPolling();
        }).catch((e) => {
          console.log('[check-ui] 启动失败', String(e));
          setChecking(false);
          setError((e as Error).message);
        });
      },
    });
  };

  const toggle = (id: number) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /** 选词(照 BrowsePanel)。页码归零由 TagItemPane 的 key={tagId} 重挂载做,这里不管 */
  const pick = (id: number) => {
    setSelectedItem(null);
    setParams({ tag: String(id) });
  };

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

  // 选中词的名字(从树里查)—— 角标要排除它(自己不算"别的词"),空态要用它
  const currentTagName = tree?.tree ? findName(tree.tree, tagId) : null;

  const actions = (node: TagNode) =>
    // 标注/质检在跑时不渲染行内操作 —— 两边都会改同一棵树,跑了改名/合并/删除
    // 会让轮询回来看到的世界和界面动作打架
    tagging || checking ? null
      : editing === node.id ? (
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
   * **保留小数不取整**:total 大(几千)批小时,整数百分比要攒好几批才跳 1%,
   * 进度条看起来卡死而数字每批都动 —— 用户报的正是这个。percent 接受小数,
   * antd 自己会画,保留两位就够平滑了。
   */
  const tagPct =
    tagProgress && tagProgress.total > 0
      ? Math.round(((tagProgress.done / tagProgress.total) * 100) * 100) / 100
      : 0;

  return (
    <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: 12 }}>
      {error && <Alert type="error" showIcon closable message={error} onClose={() => setError('')} />}

      {/* ── AI 标注(spec §9E C8)置顶:树是这一跑长出来的,入口就该在它上面。
          两态(§9D B1):空闲 = 开始增量,运行中 = 停止。**不绑 busy** ——
          它自己在跑的时候,下面的改名/合并/删除照样能点(§9D.5) ── */}
      <div className="hud-panel" style={{ padding: 12, flex: 'none' }}>
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
            {/* 运行中只有一个「停止」 —— 两个"发动标注"的按钮在跑着的时候都藏着,
                不然"已经有两个能发动的按钮"同时杵在「停止」旁边很奇怪。停止走显式
                abort 端点(轮询版没有可 abort 的 fetch) */}
            {tagging || checking ? (
              <>
                {/* 标注或质检在跑:只留「停止」+「日志」—— 两边都会改同一棵树,
                    其他按钮(质检/清空/树行操作)运行中一律不可见 */}
                <Button
                  size="small"
                  danger
                  icon={<Square size={13} />}
                  onClick={() => {
                    // 停止失败要出声 —— 不然用户点了"停止"却完全不知道没生效
                    void tagApi.abortRun().catch((e) => setError((e as Error).message));
                  }}
                >
                  停止
                </Button>
                <span style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>
                  {tagging ? '标注运行中' : '质检运行中'}
                </span>
              </>
            ) : (
              <>
                {/* 标注一颗按钮(spec 规则 3):按钮只表明任务,不带数据状态 ——
                    和旁边「词库质检」一致;范围与覆盖语义都在弹窗里交代。
                    空库(total=0)不渲染:没有可标的对象 */}
                {(!tagStatus || tagStatus.total > 0) && (
                  <Button size="small" icon={<Tag size={13} />} onClick={confirmTagRun}>
                    AI 标注
                  </Button>
                )}
                {/* 词库质检:手动触发,弹窗选范围(全部 / 只查新的) */}
                <Button size="small" icon={<ScanSearch size={13} />} onClick={confirmTagCheck}>
                  词库质检
                </Button>
                {/* 清空标注:高危、连词库树一起清,必须输入「清空」二字才可确定 */}
                <Button size="small" danger icon={<Eraser size={13} />} onClick={confirmClearTags}>
                  清空标注
                </Button>
              </>
            )}
          </span>
        </div>

        {/* 常显:首屏就该看到"标了多少、这轮用哪个模型"。跑起来换成进度行
            (§9D.2:数字走 num 等宽,位数不抖) */}
        {(tagStatus || tagging || checking) && (
          <div style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)', marginTop: 8 }}>
            {checking ? (
              <>
                {/* total 在第一批判完前是 0 —— 那段时间明确说"第一批判定中",
                    不然用户只看到"已判 0 个词"分不清是在跑还是卡死 */}
                {(checkProgress?.total ?? 0) === 0 ? (
                  <>质检中:第一批判定中……(每批 200 个词,批量越大等得越久)</>
                ) : (
                  <>
                    质检中:已判{' '}
                    <span className="num" style={{ color: 'var(--accent)' }}>
                      {(checkProgress?.done ?? 0).toLocaleString()}
                    </span>
                    /<span className="num">{(checkProgress?.total ?? 0).toLocaleString()}</span> 个词
                  </>
                )}
              </>
            ) : tagging ? (
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
                {/* 分母排掉了已失效 —— 那个 M 用户数不出别的数,不说清楚就是"数字悄悄变了" */}
                {tagStatus?.invalid ? `(另有 ${tagStatus.invalid.toLocaleString()} 条已失效,不参与标注)` : ''}
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
        {/* 质检的进度条 —— **点击确定立刻出现**:total=0(第一批判定中)时画 0%,
            状态 active 让它有流动动画,别让用户面对一片空白怀疑没点上 */}
        {checking && (
          <div style={{ marginTop: 6 }}>
            <Progress
              percent={
                (checkProgress?.total ?? 0) > 0
                  ? Math.round(((checkProgress!.done / checkProgress!.total) * 100) * 100) / 100
                  : 0
              }
              size="small"
              status="active"
              strokeColor="var(--accent)"
            />
          </div>
        )}

        {/* 中断/完成的话 —— warn 色,不用顶上那个红条(§9D B4) */}
        {tagNote && (
          <div style={{ fontSize: 'var(--fs-12)', color: 'var(--warn)', marginTop: 8 }}>{tagNote}</div>
        )}
      </div>

      {/* ── 行容器:树列 | 视频墙 | 详情栏,三列同高,滚动各自负责 ── */}
      <div style={{ display: 'flex', gap: 12, flex: 1, minHeight: 0, alignItems: 'stretch' }}>
        {/* 树列 —— **树自己滚**(TagTree 包在内滚容器里),不顶飞别的模块。
            头部行(标题/词数/健康度/清除)flex:none,树长了先压缩的是滚动区 */}
        <div className="hud-panel" style={{ width: 300, flex: 'none', padding: 12, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flex: 'none' }}>
            <span className="hud-label">词库</span>
            <span className="num" style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>
              {tree?.total ?? 0} 个词
            </span>
            {busy && <Spin size="small" />}
          {/* 词库健康度(M4h):活跃词是"挂 ≥5 条视频"的词,整理成本由它的平方决定 ——
              这个数持续涨就是词库在膨胀的早期信号。上次整理耗时大于 5s 说明超时守卫触发过。
              外层条件必须含 unchecked:新词批量长出时 activeTags 可能还是 0,而待检数
              恰恰在那个时刻最该被看见(只 guard 活跃词部分,别把待检一起藏了) */}
          {stats && (stats.activeTags > 0 || stats.unchecked > 0) && (
            // **必须可收缩**(flex:1 + minWidth:0)—— 这行最长能到三四百 px,300px 列里
            // 撑不动:写死 flex:'none' 会把行挤溢出,DOM 末尾的「清除」按钮被列的
            // overflow:hidden 裁掉,选着词时清除入口直接消失。长文案让它截断,别顶人。
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>
              {stats.activeTags > 0 && (
                <>活跃词 <span className="num">{stats.activeTags.toLocaleString()}</span> / {stats.totalTags.toLocaleString()}</>
              )}
              {/* 待检 N = 质检台账的欠账数 —— 用户随时看得到「继续质检」还欠多少活 */}
              {stats.unchecked > 0 && <> · 待检 <span className="num">{stats.unchecked.toLocaleString()}</span></>}
              {stats.reconcileMs !== null && <> · 上次整理 <span className="num">{stats.reconcileMs.toLocaleString()}</span>ms</>}
            </span>
          )}
            {/* 清除选中(照 BrowsePanel):抹掉 URL 上的 tag,右侧回到空态。
                只在选着的时候显示 —— 没选中就没有"清除"可言 */}
            {tagId !== null && (
              <button
                type="button"
                onClick={() => { setSelectedItem(null); setParams({}); }}
                style={{
                  marginLeft: 'auto', border: 'none', background: 'none', cursor: 'pointer',
                  color: 'var(--text-dim)', fontSize: 'var(--fs-12)',
                }}
              >
                清除
              </button>
            )}
          </div>

          {loading ? (
            <div style={{ padding: 20, textAlign: 'center' }}><Spin /></div>
          ) : (tree?.tree ?? []).length === 0 ? (
            // 拉失败时那句"点一次 AI 标注"是**照它做要花钱**的建议,不能挂在一次
            // 失败的取数上(红条已经在上面了)
            <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--text-dim)', fontSize: 'var(--fs-13)', flex: 'none' }}>
              {treeError
                ? '词库没拉下来 —— 看上面那条报错'
                : '词库还是空的。点上面的「AI 标注」,它会自己长出来'}
            </div>
          ) : (
            // **树自己滚** —— 树长了只滚这一块,不会把详情栏顶出屏
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
              <TagTree
                nodes={tree!.tree}
                expanded={expanded}
                selectedId={tagId}
                onToggleExpand={toggle}
                onSelect={pick}
                renderActions={actions}
              />
            </div>
          )}
        </div>

        {/* 中列:选中的词 → 视频墙。tagsOf 在它手里,详情栏要的由它 onTagsOf 上报。
            key={tagId}:切词重挂载,page/error state 归位,不用「新词+旧页码」先打一次废请求 */}
        <TagItemPane
          key={tagId}
          tagId={tagId}
          selectedId={selectedItem?.id ?? null}
          excludeTag={currentTagName}
          onSelect={setSelectedItem}
          onTagsOf={setSelectedItemTags}
        />

        {/* tags 由 TagItemPane 上报,不再像浏览页那样自己从 data 里捞 —— 取数在那边 */}
        <ContextPane item={selectedItem} tags={selectedItemTags} />
      </div>

      {/* 日志抽屉(§9D.7)。**开/关由这一页管** —— 按钮在这里,抽屉自己开就跟它脱节了。
          缓冲区和清空也在这里:`onClear` 清的是这一页手里的 state,关抽屉再开不丢。
          「上一轮变化」收进抽屉(浏览合并进标签页):顶部不再有独立面板,数据从这传 */}
      <TagLogDrawer
        open={logOpen}
        onClose={() => setLogOpen(false)}
        lines={logLines}
        onClear={() => setLogLines([])}
        waiting={tagging || checking}
        changes={changes?.changes ?? []}
      />
    </div>
  );
}

/** 树里按 id 找名字(只用于角标的排除名 —— 排除的是"当前选中的词") */
function findName(nodes: TagNode[], id: number | null): string | null {
  if (id === null) return null;
  for (const n of nodes) {
    if (n.id === id) return n.name;
    const hit = findName(n.children, id);
    if (hit) return hit;
  }
  return null;
}
