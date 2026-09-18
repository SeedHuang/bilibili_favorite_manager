/**
 * AI 管家的聊天流(spec §9.0)。
 *
 * 上下文 = 最近 N 轮原文 + 用户当前的结构快照 + 旧轮滚动摘要。
 *
 * **体系上下文只认工作副本**(W1/W3)。以前这里读的是会话级草稿
 * (`taxonomy_draft`),但 m4b 取消了那个模型、草稿已经没人写 —— 于是每条消息
 * 发给模型的上下文里一个夹子名都没有,而 SYSTEM_PROMPT 第一条就要求
 * "先看用户现有的收藏夹结构和名字"。老库里留下的旧草稿还会把一份**过期体系**
 * 当成"以它为准"喂进去。
 *
 * **压缩只动聊天,不动体系**(红队 2026-09-15)。这就是为什么结构快照走的是
 * `role:'system'` —— `trimToContext` 永远保留 system 消息,所以体系状态
 * 在任何裁剪下都不会丢,而聊天消息可以先被摘要掉。
 */
import type Database from 'better-sqlite3';
import type { ModelConfig } from '../llm/provider.js';
import { complete, stream } from '../llm/provider.js';
import type { ModelMeta } from '../llm/registry.js';
import {
  RESERVED_FOR_SYSTEM,
  estimateTokens,
  trimToContext,
  type ChatMessage,
} from '../llm/context.js';
import {
  appendMessage,
  getMessages,
  getRollingSummary,
  setRollingSummary,
} from '../db/repo/sessions.js';
import { listFolders } from '../db/repo/folders.js';
import { listWorkFolders, workItemIds } from '../db/repo/workbench.js';
import { listRules } from '../db/repo/rules.js';
import { listTagsWithParent } from '../db/repo/tags.js';
import { renderConditions } from './rules.js';

/** 保留原文的最近消息条数(8 轮问答) */
export const RECENT_MESSAGES = 16;

export const SYSTEM_PROMPT = `你是 bilibili 收藏整理管家。用户的收藏散落在几十个收藏夹里,你的任务是帮他把它们理成一套更少、更清晰的体系。

工作原则:
1. 先看用户**现有的收藏夹结构和名字**,再给建议 —— 必须先说清"你现在是怎么分的",才能说"该怎么合并"。
2. 按**主题/内容类型**分,不要按 UP 主分(按 UP 太碎,几十个 UP 就是几十个夹子)。
3. **优先复用现有收藏夹**而不是新建。bilibili 只能给收藏夹改名/删除,不能改归属,所以新建同义夹子只会越堆越乱。
4. 尊重用户的硬约束(比如"控制在 15 个以内""保留 xx 夹子")。
5. 一次只推进一件事。先聊体系,用户说"就这样"之前不要急着归类。

绝对禁令:
- **永远不要提议删除任何收藏条目**。删失效内容只能由用户在界面上手动操作。
- 不要编造你没看到的收藏夹或条目。

回答用中文,简洁直接,不要客套话。
用户问「规则该怎么改 / 这个夹子该加什么规则」时,直接说你看到的问题和该加的词。
规则由用户在「规则」页维护,你不能直接改它。`;

const COMPACT_PROMPT = `把下面这段收藏整理对话压缩成一段摘要,供后续对话当背景用。

必须保留:用户的偏好和硬约束、已经确认的结论、被否掉的方案及原因。
可以丢掉:寒暄、重复表述、中间过程。
不要保留:任何具体条目的归类细节(那些在结构快照里,不靠摘要传递)。

直接输出摘要正文,不要前言,不要 markdown 标题。`;

/**
 * 用户当前的结构 —— 一行一个夹子,模型照着这个说话。
 *
 * **工作副本优先**:那是"你桌上这份",和 /curator 页面上看到的是同一个来源。
 * 还没有工作副本时退回快照 —— 那是 B站 现在的样子,也正是用户此刻看到的东西。
 * 两边都空(还没同步过)就返回空串,调用方据此不注入。
 */
function renderStructure(db: Database.Database): string {
  const work = listWorkFolders(db);
  if (work.length > 0) {
    // 规则一起带上 —— 用户问「规则该怎么改」时,模型必须先看得见现有规则
    // (spec §9C.5 c)。规则只挂在工作副本的夹子上,所以快照那条路不带它。
    const ruleOf = new Map(listRules(db).map((r) => [r.folderId, r]));
    // 规则里的 tag 条件存的是 id —— 聊天里给模型看的这份得翻成词名(见 renderConditions)
    const tagNameOf = new Map(listTagsWithParent(db).map((r) => [r.id, r.name]));
    return work
      .map((w) => {
        const rule = renderConditions(ruleOf.get(w.id)?.conditions ?? [], tagNameOf);
        return `- ${w.name}(${workItemIds(db, w.id).length} 条) —— ${
          rule ? `规则:${rule}` : '还没有规则'
        }`;
      })
      .join('\n');
  }
  return listFolders(db).map((f) => `- ${f.title}(${f.media_count} 条)`).join('\n');
}

/** 上下文预算 —— 与 context.ts 里 trimToContext 用的是同一个口径 */
function budgetOf(ctx: ModelMeta): number {
  return Math.max(0, ctx.contextWindow - ctx.maxOutput - RESERVED_FOR_SYSTEM);
}

/**
 * 拼这一轮要发给模型的消息。
 *
 * 只读数据库,不调 LLM —— 所以可以随便调,用来做 UI 预览也行。
 */
export function buildContext(
  db: Database.Database,
  sessionId: number,
  ctx: ModelMeta,
): { messages: ChatMessage[]; summary: string; hasStructure: boolean } {
  const rolling = getRollingSummary(db, sessionId);
  const structure = renderStructure(db);

  const messages: ChatMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }];

  // 摘要和结构都走 system:它们是"必须活下来"的状态,不是可裁的聊天
  if (rolling) {
    messages.push({ role: 'system', content: `【之前对话的摘要】\n${rolling.text}` });
  }
  if (structure) {
    messages.push({ role: 'system', content: `【用户当前的结构 —— 以它为准】\n${structure}` });
  }

  const recent = getMessages(db, sessionId, {
    limit: RECENT_MESSAGES,
    afterId: rolling?.upToId ?? 0,
  });
  messages.push(...recent.map((m) => ({ role: m.role, content: m.content })));

  return {
    messages: trimToContext(messages, ctx),
    summary: rolling?.text ?? '',
    hasStructure: structure !== '',
  };
}

/**
 * 超预算时把最旧的 1/3 聊天消息压成摘要(spec §9.0)。
 *
 * 没超预算就**一次 LLM 都不调** —— 所以放在每轮对话开头是免费的。
 * 压缩不删消息,只推进水位线;用户翻历史还能看到原文。
 */
export async function compact(opts: {
  db: Database.Database;
  sessionId: number;
  config: ModelConfig;
  ctx: ModelMeta;
}): Promise<void> {
  const { db, sessionId, ctx } = opts;
  const prev = getRollingSummary(db, sessionId);
  const watermark = prev?.upToId ?? 0;

  const window = getMessages(db, sessionId, { limit: RECENT_MESSAGES });
  // 窗口为空说明消息还不够多,没什么可压
  if (window.length === 0) return;
  const windowStartId = window[0]!.id;

  const afterWatermark = getMessages(db, sessionId, { afterId: watermark });
  const older = afterWatermark.filter((m) => m.id < windowStartId);
  if (older.length === 0) return;

  const used = afterWatermark.reduce((n, m) => n + estimateTokens(m.content), 0);
  if (used <= budgetOf(ctx)) return;

  const take = Math.max(1, Math.ceil(older.length / 3));
  const chunk = older.slice(0, take);
  const lastId = chunk.at(-1)!.id;

  const transcript = chunk.map((m) => `${m.role === 'user' ? '用户' : '管家'}: ${m.content}`).join('\n\n');
  const raw = await complete({
    config: opts.config,
    messages: [
      { role: 'system', content: COMPACT_PROMPT },
      {
        role: 'user',
        content: prev ? `已有摘要:\n${prev.text}\n\n新对话:\n${transcript}` : transcript,
      },
    ],
    // 滚动摘要同属批量:喂进去一整段对话,输出只是几行摘要 —— 开着思考纯属白烧 token
    thinking: false,
  });
  // 兼容坏响应(空串 / undefined / 非字符串):拿不到有效摘要就不推进水位线,
  // 绝不把那段对话凭空吃掉。trimToContext 是永远在的兜底。
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text) setRollingSummary(db, sessionId, { upToId: lastId, text });
}

/**
 * 跑一轮聊天:落库用户消息 → 按需压缩 → 拼上下文 → 流式产出 → 落库回复。
 *
 * 用回调而不是 AsyncGenerator:与 provider.stream 的签名保持一致,
 * 中间少一层搬运。SSE 路由直接把回调接到 `reply.raw.write`。
 *
 * **可中止**(§9D B3):用户点停止 / 关页面 → 路由 abort 这个 signal,
 * provider 真的停下。此时**不抛** —— 半截回复照样落库,带 `(已中断)` 标注
 * 返回给路由。理由:流到一半的内容也是信息,丢掉它用户白等一场,而且
 * 界面上会只剩前半句、刷新后又消失(库里没有),更莫名其妙。
 */
export async function chatStream(opts: {
  db: Database.Database;
  sessionId: number;
  config: ModelConfig;
  ctx: ModelMeta;
  userMessage: string;
  onChunk: (delta: string) => void;
  /** 思考流(§9D.5)—— 推理型模型才有;不落库,不算正式回复 */
  onReasoning?: (delta: string) => void;
  /** 调用方断开时中断生成 —— 不传 = 不可中断(和旧行为一致) */
  signal?: AbortSignal;
}): Promise<string> {
  const { db, sessionId } = opts;
  appendMessage(db, sessionId, 'user', opts.userMessage);

  // 摘要失败不该挡住建档对话 —— trimToContext 是真正的兜底,它保证永远不超预算
  await compact(opts).catch(() => {});

  const { messages } = buildContext(db, sessionId, opts.ctx);

  // 自己也在 onChunk 里累计一份 —— stream 内部那份全文在中止时拿不到,
  // 而 `partial` 正是要落库的"半截"。
  let partial = '';
  let full: string;
  try {
    full = await stream({
      config: opts.config,
      messages,
      onChunk: (delta) => {
        partial += delta;
        opts.onChunk(delta);
      },
      // **reasoning 只透传,不累计** —— 它是过程不是回复,落库的那份(§9D B3)不含它
      ...(opts.onReasoning ? { onReasoning: opts.onReasoning } : {}),
      ...(opts.signal ? { abortSignal: opts.signal } : {}),
    });
  } catch (e) {
    // 中止和真故障要分开:中止不是错误,是用户改主意了(spec §9D B5)。
    // **认 signal 或错误的 name,不认文案** —— SDK 内部的超时中止也是 AbortError 形状、
    // 文案里照样带 "aborted",扫字面会把"上游把我掐了"误当成"用户点了停止":
    // 错误被吞掉、半截带着 `(已中断)` 落库、用户还一句话都不知道。name 才是精确判据。
    const aborted = opts.signal?.aborted || (e as Error)?.name === 'AbortError';
    if (!aborted) throw e;

    // 落库内容带标注(§9D B3 原文)—— 这句是最后写进 DB 的东西,标注必须在这里,
    // 不能只在前端展示层加:刷新后从库里读出来的必须还是带标注的那版。
    const text = partial + '\n\n(已中断)';
    appendMessage(db, sessionId, 'assistant', text);
    return text;
  }

  // 空回复**不能当成功存下来**。流式接口有静默失败:参数校验错、上游报错都可能
  // 表现为"流正常结束但一个 chunk 都没有"。存成空消息的话,用户看到的是一句
  // 空白回复,完全不知道发生了什么 —— 抛错至少能在界面上说出原因。
  if (!full.trim()) {
    throw new Error('模型没有返回任何内容 —— 检查模型是否正常,或换个模型再试');
  }

  appendMessage(db, sessionId, 'assistant', full);
  return full;
}
