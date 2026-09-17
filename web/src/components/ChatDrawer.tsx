import { useCallback, useEffect, useRef, useState } from 'react';
import { App as AntApp, Drawer, Button, Input, Alert, Spin } from 'antd';
import { Send, History, Plus, Sparkles, Square } from 'lucide-react';
import { curatorApi, classifyStream, streamMessage } from '../api';
import type { ChatMessage, ProgressPayload, SessionDetail, SessionSummary } from '../types';
import { useAssistant } from './assistant';
import Markdown from './Markdown';

/**
 * AI 管家聊天抽屉(spec §9.0 对话 + §11.9)。
 *
 * 默认动作是「整理文件夹」:打开先给一句起始提示,而不是空白的输入框 ——
 * 用户不知道能说什么的时候,得有个按钮告诉他。
 */
export default function ChatDrawer() {
  // 静态 Modal.confirm 拿不到 ConfigProvider 的主题,用 App.useApp() 这套
  const { modal } = AntApp.useApp();
  const { open, close, sessionId, setSessionId, setStatus, setSuggestions } = useAssistant();

  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [streaming, setStreaming] = useState('');
  /** 思考流(§9D.5)—— 推理型模型才有;**不落库**,只活在这次流式里 */
  const [reasoning, setReasoning] = useState('');
  const [pendingUser, setPendingUser] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  // **busy 按事拆分(§9D.5)**:共用一个 busy 时,聊天跑着归类按钮也显示「停止」——
  // 点了是死键(另一边的 controller 是 null)。真机被撞过:归类进行中,点发送键上的
  // 停止毫无反应。apply 也单独一档 —— 它要等的只是结果落地,不该被归类的时长连坐。
  const [sending, setSending] = useState(false);
  const [classifying, setClassifying] = useState(false);
  const [applying, setApplying] = useState(false);
  /** 兼容旧引用:任何一件事在跑都算"忙"(输入框占位、会话禁用等粗粒度场景用) */
  const busy = sending || classifying || applying;
  const [showHistory, setShowHistory] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // §9D B1:进行中 = 最需要可点的时刻,loading 转圈不可点是对"进行中"的错误表达。
  // 聊天和归类各持一个 controller —— 一次「停止」只该停它自己那件事。
  const chatAbort = useRef<AbortController | null>(null);
  const classifyAbort = useRef<AbortController | null>(null);
  // §9D B4 的「已中断:N/M 批完成」要用最后一次进度 —— progress 会在 finally 里清掉,
  // 所以单独记一份在 ref 上(渲染走 state,这里只为中断文案留底)
  const lastProgress = useRef<ProgressPayload | null>(null);
  const [progress, setProgress] = useState<ProgressPayload | null>(null);
  // 归类被中断后的说明。**不走 error 那条红条** —— 用户自己按的停止不是错误
  const [interrupted, setInterrupted] = useState('');
  // 当前这份 streaming/pendingUser(活的半截)属于哪个会话。切会话时要靠它判断
  // 那份残影该不该丢 —— 见下面 `[open, sessionId]` 那个 effect
  const streamOwner = useRef<number | null>(null);

  const refreshSessions = useCallback(async () => {
    setSessions(await curatorApi.listSessions());
  }, []);

  useEffect(() => {
    if (open) refreshSessions().catch(() => {});
  }, [open, refreshSessions]);

  useEffect(() => {
    if (!open) {
      // 抽屉关了 = 这一场到此为止,重开时按全新的一面来(重开不换会话也算"换了场面")
      streamOwner.current = null;
      return;
    }
    // 上一场的中断残影必须清掉 —— 半截没落进 detail,留着会渲染进另一个会话的视图里,
    // 或者和重拉回来的落库版本并排重复一遍。
    // **但不能无条件清**:`send()` 给新会话开张时会 setSessionId(null → sid),
    // 这个 effect 于是也跟着跑 —— 那时 streaming/pendingUser 正是刚发出去的那一轮,
    // 清掉会让用户自己的那条消息在整段流式期间凭空消失。判据是"这份半截属于谁":
    // 属于当前会话 = 是这一场,留着;属于别的会话 = 残影,丢掉
    if (streamOwner.current !== sessionId) {
      setStreaming('');
      setPendingUser(null);
      streamOwner.current = null;
    }
    if (sessionId === null) {
      setDetail(null);
      return;
    }
    curatorApi.getSession(sessionId).then(setDetail).catch((e) => setError((e as Error).message));
  }, [open, sessionId]);

  // 新内容进来就贴底 —— 聊天窗里"停在上面"没有意义
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [detail, streaming, pendingUser]);

  const send = useCallback(
    async (text: string) => {
      const content = text.trim();
      if (!content || sending) return;

      setSending(true);
      setError('');
      setInput('');
      setPendingUser(content);
      setStreaming('');
      setReasoning('');
      setStatus('working');

      const controller = new AbortController();
      chatAbort.current = controller;
      try {
        // 没有会话就先开一个 —— 用户不该为了说句话先去点"新建会话"
        const sid = sessionId ?? (await curatorApi.newSession('整理文件夹'));
        // 先认领再翻页:下面 setSessionId 会把 [open, sessionId] 那个 effect 叫起来,
        // 它靠 streamOwner 认出"这一轮就是新会话自己的",才不会把刚发的消息清掉
        streamOwner.current = sid;
        if (sessionId === null) setSessionId(sid);

        await streamMessage(
          sid,
          content,
          (delta) => setStreaming((s) => s + delta),
          {
            signal: controller.signal,
            // 思考流进折叠块,不混进正文(§9D.5)
            onReasoning: (delta) => setReasoning((r) => r + delta),
          },
        );

        // 流式只负责"看得见",落库的那份以服务端为准
        setDetail(await curatorApi.getSession(sid));
        setStreaming('');
        setPendingUser(null);
        setReasoning('');
        await refreshSessions();
      } catch (e) {
        // 用户自己按的「停止」—— 不是错误,静默收场:半截就留在气泡里,
        // 不把话塞回输入框(那不是"发失败了",是"就说这么多")
        if (controller.signal.aborted) {
          // 服务端落库的那份带 `(已中断)` 标注,但客户端 abort 后 done 帧永远到不了它
          // —— 气泡里就地补上同一个标注,和重拉详情之后的样子一致;没有它,停在一句话
          // 中间的半截和"本来就答这么短"长得一模一样。`s ?` 挡住"一个字都没吐就停"的空标注
          setStreaming((s) => (s ? `${s}\n\n(已中断)` : s));
          return;
        }
        setError((e as Error).message);
        // 保留用户那条,别让它凭空消失 —— 他能直接重发
        setPendingUser(null);
        setInput(content);
      } finally {
        chatAbort.current = null;
        setSending(false);
        setStatus('idle');
      }
    },
    [sending, sessionId, setSessionId, setStatus, refreshSessions],
  );

  /**
   * 应用归类提案。默认**不覆盖** —— 后端发现你期间手改过就回 409,
   * 那时先把「哪几处会被盖掉」摆出来,点「继续应用」才带 force 重来。
   */
  const applyProposal = async (force = false) => {
    if (sessionId === null) return;
    setApplying(true);
    setError('');
    try {
      const r = await curatorApi.apply(sessionId, force);
      setNotice(
        `已应用 ${r.applied} 条` +
          // AI 拿不准的条目留在原处 —— 不说的话"归类完成"就是句假话
          (r.unclassified > 0 ? `;${r.unclassified} 条 AI 拿不准,保持原样` : '') +
          (r.skipped > 0 ? `;${r.skipped} 条因为夹子没了被跳过` : '') +
          // overwritten 是**操作次数**,不是条目数 —— 一次操作可能动了 412 条
          (r.overwritten > 0 ? `;有 ${r.overwritten} 次操作被覆盖` : ''),
      );
      setDetail(await curatorApi.getSession(sessionId));
    } catch (e) {
      const err = e as Error & { status?: number };
      if (err.status === 409 && !force) {
        modal.confirm({
          title: '你手改过的地方会被覆盖',
          content: err.message,
          okText: '继续应用',
          cancelText: '算了',
          onOk: () => applyProposal(true),
        });
      } else {
        setError(err.message);
      }
    } finally {
      setApplying(false);
    }
  };

  /**
   * 归类。**空抽屉上也能点** —— 会话自己开,和 `send()` 一样。
   *
   * 之前按钮挂在 `sessionId === null` 上禁用:用户第一次进来看到的是一句
   * "按现在这份结构归类",旁边一个看得见点不动、也不说为什么的按钮。
   */
  const runClassify = async () => {
    setClassifying(true);
    setError('');
    // 上一次的中断说明只说到这次起跑为止 —— 新的一跑开始了,它就不成立了
    setInterrupted('');
    setProgress(null);
    // 上一次跑剩下的进度不能留到这一跑的中断文案里 —— 起跑就归零
    lastProgress.current = null;
    setStatus('working');
    const controller = new AbortController();
    classifyAbort.current = controller;
    // 在 try **外面**声明 —— 中断分支里也要靠它重拉详情。不是 number 就是"连会话都还没开出来"
    let sid: number | undefined;
    try {
      sid = sessionId ?? (await curatorApi.newSession('归类'));
      if (sessionId === null) {
        setSessionId(sid);
        await refreshSessions();
      }
      const r = await classifyStream(
        sid,
        (p) => {
          setProgress(p);
          // 中断文案要在 progress 被 finally 清掉之后还能用 —— 单独留一份
          lastProgress.current = p;
        },
        { signal: controller.signal },
      );
      // 归类顺手给的规则建议 —— 这是建议的**第一个来源**(spec §9C.5),
      // 落到共享的那份里,/rules 页的建议栏就看得到。
      // **只在成功时写**:失败的一次跑不该把上一次的建议清掉(和面板那个按钮一致)
      setSuggestions(r.suggestions);
      setDetail(await curatorApi.getSession(sid));
      const unclassified = r.assignments.filter((a) => a.folderTempId === null).length;
      setNotice(
        // **分栏要如实**(spec §9C.3 ③):一条条目可以命中多个夹子,所以
        // `assignments.length` 会大于条目数 —— 那个数不能拿来当"归了几条"显示
        `归类完成:规则 ${r.ruleCount} 条 · AI ${r.aiCount} 条 · 未归类 ${unclassified} 条` +
          `(共 ${r.total} 条)` +
          // 「未归类」是唯一的说法(spec §9B.5):AI 语境里也别另起一个词,
          // 而且界面上根本没有"待定"那一栏
          (r.failedBatches.length
            ? `;${r.failedBatches.length} 批没成功,那些条目没归上,留在原处`
            : ''),
      );
    } catch (e) {
      if (controller.signal.aborted) {
        // 停止不是错误(§9D B5):每跑完一批就 upsert 过一次,已完成的那些
        // 已经在归类结果里了 —— 说清楚"留了什么、下次会怎样"就够了。
        // 重拉一次让面板跟着更新:否则上面还写着旧条数、『应用』按钮也不出来,
        // 跟下面这句"已完成的保留在结果里"自相矛盾。批次是**先于**中断落库的,
        // 这里不是和落库赛跑;拉挂了也不能顶掉这句话,所以 errors 吞掉
        if (sid !== undefined) {
          await curatorApi.getSession(sid).then(setDetail).catch(() => {});
        }
        // §9D B4 原文「已中断:N/M 批完成」—— ref 里是最后一次进度(finally 已清 state)
        const done = lastProgress.current as ProgressPayload | null;
        setInterrupted(
          `已中断:${done ? `${done.batch}/${done.batches} 批完成 · ` : ''}` +
            '已完成的批次保留在归类结果里,重跑会算剩下的',
        );
      } else {
        setError((e as Error).message);
      }
    } finally {
      classifyAbort.current = null;
      setProgress(null);
      setClassifying(false);
      setStatus('idle');
    }
  };

  const messages: ChatMessage[] = detail?.messages ?? [];
  const empty = messages.length === 0 && !pendingUser && !streaming;

  return (
    <Drawer
      className="bfm-drawer"
      open={open}
      onClose={close}
      placement="right"
      width={400}
      maskClosable
      styles={{ body: { display: 'flex', flexDirection: 'column', height: '100%' } }}
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="hud-label" style={{ color: 'var(--ai)' }}>
            AI 管家
          </span>
          <span
            style={{
              fontSize: 'var(--fs-12)',
              color: 'var(--text-dim)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {detail?.session.title ?? '新会话'}
          </span>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 2 }}>
            <Button
              type="text"
              size="small"
              aria-label={showHistory ? '收起历史' : '历史会话'}
              icon={<History size={14} />}
              onClick={() => setShowHistory((v) => !v)}
            />
            <Button
              type="text"
              size="small"
              aria-label="新建会话"
              icon={<Plus size={14} />}
              onClick={() => {
                setSessionId(null);
                setDetail(null);
                setShowHistory(false);
              }}
            />
          </span>
        </div>
      }
    >
      {showHistory && (
        <div
          style={{
            flex: 'none',
            maxHeight: 200,
            overflowY: 'auto',
            borderBottom: '1px solid var(--rule)',
            background: 'var(--surface)',
          }}
        >
          {sessions.length === 0 && (
            <div style={{ padding: 12, color: 'var(--text-dim)', fontSize: 'var(--fs-12)' }}>
              还没有历史会话
            </div>
          )}
          {sessions.map((s) => (
            <button
              key={s.id}
              onClick={() => {
                setSessionId(s.id);
                setShowHistory(false);
              }}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '8px 14px',
                border: 'none',
                borderLeft: s.id === sessionId ? '2px solid var(--accent)' : '2px solid transparent',
                background: s.id === sessionId ? 'var(--surface-2)' : 'transparent',
                color: s.id === sessionId ? 'var(--accent)' : 'var(--text)',
                font: 'inherit',
                fontSize: 'var(--fs-12)',
                cursor: 'pointer',
              }}
            >
              <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {s.title ?? '未命名'}
              </div>
              {/* 会话列表只显示摘要一句话(spec §9.0) */}
              <div
                style={{
                  color: 'var(--text-dim)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {s.preview ?? '—'}
              </div>
            </button>
          ))}
        </div>
      )}

      <div
        ref={scrollRef}
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 14 }}
      >
        {empty && (
          <div style={{ textAlign: 'center', paddingTop: 32 }}>
            <Sparkles size={26} style={{ color: 'var(--ai)', opacity: 0.8 }} />
            <p style={{ color: 'var(--text-dim)', fontSize: 'var(--fs-13)', lineHeight: 1.8 }}>
              我可以先看看你的收藏夹结构,
              <br />
              给你一套更清爽的整理方案。
            </p>
            <Button type="primary" icon={<Sparkles size={14} />} onClick={() => send('帮我整理收藏夹')}>
              整理文件夹
            </Button>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {messages.map((m) => (
            <Bubble key={m.id} role={m.role} content={m.content} />
          ))}
          {pendingUser && <Bubble role="user" content={pendingUser} />}
          {/* 思考中(§9D.5):折叠块,点击展开看过程。**流式正文一来就藏起折叠头** ——
              大多数模型是"先想后说",正文开始时思考已经结束,再挡着正文就是噪音 */}
          {reasoning && !streaming && (
            <details
              style={{
                alignSelf: 'flex-start', maxWidth: '88%', padding: '4px 10px', margin: '2px 0',
                background: 'var(--surface)', borderLeft: '2px solid var(--rule)',
                fontSize: 'var(--fs-12)', color: 'var(--text-dim)',
              }}
            >
              <summary style={{ cursor: 'pointer' }}>
                思考中…<span className="num" style={{ marginLeft: 6 }}>{reasoning.length.toLocaleString()}</span> 字
              </summary>
              <div style={{ whiteSpace: 'pre-wrap', marginTop: 6, lineHeight: 1.6 }}>{reasoning}</div>
            </details>
          )}
          {streaming && <Bubble role="assistant" content={streaming} />}
          {sending && !streaming && !reasoning && (
            <div style={{ padding: '4px 0' }}>
              <Spin size="small" />
            </div>
          )}
        </div>
      </div>

      {error && (
        <Alert
          type="error"
          message={error}
          showIcon
          closable
          onClose={() => setError('')}
          style={{ flex: 'none', margin: '0 14px 8px' }}
        />
      )}

      {notice && (
        <Alert
          type="success"
          message={notice}
          showIcon
          closable
          onClose={() => setNotice('')}
          style={{ flex: 'none', margin: '0 14px 8px' }}
        />
      )}

      {/* 触发器**不能**藏在 classification 的判空里面 —— 那会让它被自己的前置条件锁住:
          要有提案才看得到按钮,要有按钮才生得出提案。第一次归类就没有入口了。 */}
      <div
        style={{
          flex: 'none',
          padding: '8px 14px',
          borderTop: '1px solid var(--rule)',
          background: 'var(--surface)',
        }}
      >
        <div style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)', marginBottom: 6 }}>
          {detail?.classification
            ? `AI 提了一版归类(${
                // assignments 是 (条目 × 命中夹子) 的条数,不是条目数 —— 数**不同的条目**
                new Set(detail.classification.assignments.map((a) => a.itemId)).size
              } 条)。确认后才会落到「整理」页的结构上。`
            : '按「整理」页里现在的结构,把收藏归类一遍。'}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button
            size="small"
            danger={classifying}
            icon={classifying ? <Square size={12} /> : undefined}
            onClick={() => (classifying ? classifyAbort.current?.abort() : void runClassify())}
          >
            {classifying ? '停止' : detail?.classification ? '重新归类' : '按现在这份结构归类'}
          </Button>
          {/* loading 只绑 applying —— 归类跑多久它都不该转圈,它等的只是结果落地(§9D.5) */}
          {detail?.classification && (
            <Button type="primary" size="small" loading={applying} disabled={applying} onClick={() => void applyProposal()}>
              应用到现在的结构
            </Button>
          )}
        </div>
        {/* §9D.2 的进度行。`num` 是 HUD 的等宽数字,跳动时位数不抖 */}
        {classifying && progress && (
          <div style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)', marginTop: 6 }}>
            第 <span className="num">{progress.batch}</span>/<span className="num">{progress.batches}</span> 批
            · 已归 <span className="num">{progress.done.toLocaleString()}</span>/<span className="num">{progress.total.toLocaleString()}</span> 条
            {progress.ruleCount > 0 && <> · 规则已接 <span className="num" style={{ color: 'var(--accent)' }}>{progress.ruleCount.toLocaleString()}</span> 条</>}
          </div>
        )}
        {!classifying && interrupted && (
          <div style={{ fontSize: 'var(--fs-12)', color: 'var(--warn)', marginTop: 6 }}>{interrupted}</div>
        )}
      </div>

      <div
        style={{
          flex: 'none',
          borderTop: '1px solid var(--rule)',
          padding: 12,
          display: 'flex',
          gap: 8,
          background: 'var(--surface)',
        }}
      >
        <Input.TextArea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="说说你想怎么整理…"
          autoSize={{ minRows: 1, maxRows: 4 }}
          // 忙碌时**不禁用**输入框 —— 停止键就在旁边,没理由把键盘也锁上
          onPressEnter={(e) => {
            if (!e.shiftKey) {
              e.preventDefault();
              void send(input);
            }
          }}
        />
        <Button
          type="primary"
          danger={sending}
          icon={sending ? <Square size={14} /> : <Send size={14} />}
          aria-label={sending ? '停止生成' : '发送'}
          // 忙碌时**不禁用** —— 它现在就是那枚停止键
          disabled={!sending && !input.trim()}
          onClick={() => (sending ? chatAbort.current?.abort() : void send(input))}
        />
      </div>
    </Drawer>
  );
}

function Bubble({ role, content }: { role: ChatMessage['role']; content: string }) {
  const isUser = role === 'user';
  return (
    <div
      className={`bfm-msg ${isUser ? 'bfm-msg--user' : 'bfm-msg--ai'}`}
      style={{ alignSelf: isUser ? 'flex-end' : 'flex-start', maxWidth: '88%' }}
    >
      {/* 只有 AI 的消息走 markdown;用户输入按字面显示 —— 渲染器是给模型输出用的 */}
      {isUser ? content : <Markdown text={content} />}
    </div>
  );
}
