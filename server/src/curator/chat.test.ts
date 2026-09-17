import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openDb } from '../db/index.js';
import type { ModelMeta } from '../llm/registry.js';
import {
  newSession,
  appendMessage,
  getMessages,
  getRollingSummary,
  setRollingSummary,
} from '../db/repo/sessions.js';
import { upsertFolder } from '../db/repo/folders.js';
import { upsertItem, linkFolderItem } from '../db/repo/items.js';
import { ensureWorkcopy, listWorkFolders } from '../db/repo/workbench.js';
import { saveRule } from '../db/repo/rules.js';

// provider 全拦掉 —— 测试不打真实 API(spec §12)
const mocks = vi.hoisted(() => ({
  stream: vi.fn(),
  complete: vi.fn(),
}));
vi.mock('../llm/provider.js', () => ({
  stream: mocks.stream,
  complete: mocks.complete,
}));

const { buildContext, chatStream, compact, RECENT_MESSAGES } = await import('./chat.js');
const { estimateTokens } = await import('../llm/context.js');

/** 小预算:6000 - 1000 - 1500 = 3500 token */
const smallCtx: ModelMeta = {
  provider: 'ollama',
  model: 'qwen2.5:14b',
  contextWindow: 6_000,
  maxOutput: 1_000,
  verified: true,
};

const config = { id: '本地', provider: 'ollama', baseUrl: '', apiKey: '', model: 'qwen2.5:14b' };

/** 每条正好 1000 token 的消息 */
const bigMsg = (tag: string) => tag + '中'.repeat(999);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.stream.mockResolvedValue('好的');
  mocks.complete.mockResolvedValue('用户想把夹子合并到 12 个以内。');
});

const fresh = () => {
  const db = openDb(':memory:');
  return { db, sid: newSession(db, '整理') };
};

/**
 * 种一份库:快照里一个夹子(media_count 42)+ 一条条目。
 *
 * `media_count` 故意和条目数(1)**不一致** —— 于是"名字后面的条数来自哪一边"
 * 变成一个可断言的事实:读工作副本是 `1 条`,读快照才是 `42 条`。
 */
const seedLibrary = (db: ReturnType<typeof openDb>, opts: { workcopy?: boolean } = {}) => {
  upsertFolder(db, { id: 7, title: '深度学习', mediaCount: 42 });
  upsertItem(db, { id: 'BV1', type: 2, title: 'Python 教程' });
  linkFolderItem(db, 7, 'BV1', 1);
  if (opts.workcopy) ensureWorkcopy(db);
};

/** 结构块 —— 模型的体系上下文(以 system 身份注入的那条) */
const structureOf = (messages: { role: string; content: string }[]) =>
  messages.find((m) => m.content.includes('用户当前的结构'));

describe('buildContext', () => {
  it('总是带上 system prompt', () => {
    const { db, sid } = fresh();
    const { messages } = buildContext(db, sid, smallCtx);
    expect(messages[0]!.role).toBe('system');
    expect(messages[0]!.content).toContain('收藏整理管家');
  });

  it('只带最近 N 条原文,更早的不进上下文', () => {
    const { db, sid } = fresh();
    for (let i = 0; i < RECENT_MESSAGES + 5; i++) appendMessage(db, sid, 'user', `第${i}条`);
    const { messages } = buildContext(db, sid, smallCtx);
    expect(messages.some((m) => m.content === '第0条')).toBe(false);
    expect(messages.some((m) => m.content === `第${RECENT_MESSAGES + 4}条`)).toBe(true);
  });

  // 聊天这条路以前读的是会话级草稿(taxonomy_draft),而 m4b 之后没人写它了 ——
  // 于是每条消息发给模型的上下文里一个夹子名都没有,而 SYSTEM_PROMPT 第一条
  // 就要求"先看现有的结构"。来源必须和工作台一样是**工作副本**。
  it('工作副本以 system 身份注入 —— 裁剪时永远活下来', () => {
    const { db, sid } = fresh();
    seedLibrary(db, { workcopy: true });
    const { messages, hasStructure } = buildContext(db, sid, smallCtx);

    const structure = structureOf(messages);
    expect(structure?.role).toBe('system');
    // 条数是**工作副本**口径(1 条),不是快照的 media_count(42)
    expect(structure?.content).toContain('深度学习(1 条)');
    expect(hasStructure).toBe(true);
  });

  it('上下文被挤爆时,结构仍在(这是红队加固的核心)', () => {
    const { db, sid } = fresh();
    seedLibrary(db, { workcopy: true });
    for (let i = 0; i < 20; i++) appendMessage(db, sid, 'user', bigMsg(`m${i}`));
    const { messages } = buildContext(db, sid, smallCtx);
    expect(structureOf(messages)).toBeDefined();
    // 并且确实裁掉了一些聊天
    expect(messages.length).toBeLessThan(22);
  });

  it('有摘要时只取水位线之后的消息', () => {
    const { db, sid } = fresh();
    const a = appendMessage(db, sid, 'user', '很旧的话');
    appendMessage(db, sid, 'assistant', '新的回复');
    setRollingSummary(db, sid, { upToId: a, text: '用户想合并夹子' });

    const { messages, summary } = buildContext(db, sid, smallCtx);
    expect(summary).toBe('用户想合并夹子');
    expect(messages.some((m) => m.content === '很旧的话')).toBe(false);
    expect(messages.some((m) => m.content === '新的回复')).toBe(true);
  });

  // 退回快照:还没有工作副本时,B站 现在的样子**就是**用户此刻看到的东西
  it('没有工作副本时退回快照 —— 注入的是 B站 现在的夹子名', () => {
    const { db, sid } = fresh();
    seedLibrary(db); // 只有快照,没有工作副本
    const { messages, hasStructure } = buildContext(db, sid, smallCtx);
    expect(structureOf(messages)?.content).toContain('深度学习(42 条)');
    expect(hasStructure).toBe(true);
  });

  it('哪里都没有夹子时不注入结构块(模型没有结构可看,不能编一个)', () => {
    const { db, sid } = fresh();
    const { messages, hasStructure } = buildContext(db, sid, smallCtx);
    expect(hasStructure).toBe(false);
    expect(structureOf(messages)).toBeUndefined();
  });

  // spec §9C.5 c:对话框里要能聊规则。而在这之前 renderStructure 只渲染夹子名+条数,
  // 模型一个规则都看不见 —— 无从"分析现有规则"。
  it('结构块带上规则 —— 模型才可能就规则给建议', () => {
    const { db, sid } = fresh();
    seedLibrary(db, { workcopy: true });
    const work = listWorkFolders(db)[0]!;
    saveRule(db, work.id, [{ field: 'title', any: ['Python', 'Rust'] }], 'user');

    const { messages } = buildContext(db, sid, smallCtx);
    expect(structureOf(messages)?.content).toContain('标题含 Python/Rust');
  });

  it('没有规则的夹子明说"还没有规则" —— 别让模型以为规则是空的而不是没有', () => {
    const { db, sid } = fresh();
    seedLibrary(db, { workcopy: true });

    const { messages } = buildContext(db, sid, smallCtx);
    const content = structureOf(messages)?.content ?? '';
    // 条数那段原样保留(工作副本口径)
    expect(content).toContain('深度学习(1 条)');
    expect(content).toContain('还没有规则');
  });

  it('退回快照时不谈规则 —— 规则挂在工作副本的夹子上,快照里没有这回事', () => {
    const { db, sid } = fresh();
    seedLibrary(db);
    const { messages } = buildContext(db, sid, smallCtx);
    expect(structureOf(messages)?.content).not.toContain('规则');
  });
});

describe('chatStream', () => {
  it('用户消息和完整回复都落库', async () => {
    const { db, sid } = fresh();
    mocks.stream.mockImplementation(async ({ onChunk }: { onChunk: (s: string) => void }) => {
      onChunk('整理');
      onChunk('完了');
      return '整理完了';
    });

    const chunks: string[] = [];
    const full = await chatStream({
      db,
      sessionId: sid,
      config,
      ctx: smallCtx,
      userMessage: '帮我整理',
      onChunk: (d) => chunks.push(d),
    });

    expect(chunks).toEqual(['整理', '完了']);
    expect(full).toBe('整理完了');
    expect(getMessages(db, sid).map((m) => [m.role, m.content])).toEqual([
      ['user', '帮我整理'],
      ['assistant', '整理完了'],
    ]);
  });

  it('把拼好的上下文交给 provider(不是裸的用户消息)', async () => {
    const { db, sid } = fresh();
    seedLibrary(db, { workcopy: true });
    await chatStream({ db, sessionId: sid, config, ctx: smallCtx, userMessage: '嗨', onChunk: () => {} });

    const sent = mocks.stream.mock.calls[0]![0].messages as { role: string; content: string }[];
    expect(sent[0]!.content).toContain('收藏整理管家');
    expect(structureOf(sent)?.content).toContain('深度学习');
    expect(sent.at(-1)).toEqual({ role: 'user', content: '嗨' });
  });

  it('流断了(抛错)也不会存半条 assistant 消息', async () => {
    const { db, sid } = fresh();
    mocks.stream.mockRejectedValue(new Error('连接断了'));
    await expect(
      chatStream({ db, sessionId: sid, config, ctx: smallCtx, userMessage: '嗨', onChunk: () => {} }),
    ).rejects.toThrow('连接断了');
    expect(getMessages(db, sid).map((m) => m.role)).toEqual(['user']);
  });

  // §9D B3:用户点停止 → 半截回复也落库(带标注),而且**不抛** ——
  // 抛的话路由只有 error 帧,那半截内容就凭空丢了,刷新后聊天记录里也没有。
  it('被中止 → 返回半截并落库(带 (已中断) 标注),不抛', async () => {
    const { db, sid } = fresh();
    mocks.stream.mockImplementation(async ({ onChunk }: { onChunk: (s: string) => void }) => {
      onChunk('第一段');
      throw new Error('This operation was aborted');
    });
    const controller = new AbortController();
    controller.abort();

    const full = await chatStream({
      db, sessionId: sid, config, ctx: smallCtx, userMessage: '问',
      onChunk: () => {}, signal: controller.signal,
    });

    // 返回值和落库内容都是"半截 + 标注" —— 标注必须进 DB,不然刷新就没了
    expect(full).toBe('第一段\n\n(已中断)');
    expect(getMessages(db, sid).map((m) => [m.role, m.content])).toEqual([
      ['user', '问'],
      ['assistant', '第一段\n\n(已中断)'],
    ]);
  });
});

describe('compact', () => {
  it('没超预算时一次 LLM 都不调', async () => {
    const { db, sid } = fresh();
    for (let i = 0; i < 5; i++) appendMessage(db, sid, 'user', '短消息');
    await compact({ db, sessionId: sid, config, ctx: smallCtx });
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(getRollingSummary(db, sid)).toBeNull();
  });

  it('超预算时压最旧的 1/3,并把水位线推到那一段末尾', async () => {
    const { db, sid } = fresh();
    for (let i = 0; i < 20; i++) appendMessage(db, sid, 'user', bigMsg(`m${i}`));

    await compact({ db, sessionId: sid, config, ctx: smallCtx });

    expect(mocks.complete).toHaveBeenCalledTimes(1);
    const summary = getRollingSummary(db, sid)!;
    expect(summary.text).toBe('用户想把夹子合并到 12 个以内。');
    // 20 条 - 最近 16 条 = 4 条在窗口外,压最旧的 1/3 = 2 条 → 水位线落在 id 2
    expect(summary.upToId).toBe(getMessages(db, sid)[1]!.id);
  });

  it('压缩不删消息 —— 用户翻历史还能看到原文', async () => {
    const { db, sid } = fresh();
    for (let i = 0; i < 20; i++) appendMessage(db, sid, 'user', bigMsg(`m${i}`));
    const before = getMessages(db, sid).length;
    await compact({ db, sessionId: sid, config, ctx: smallCtx });
    expect(getMessages(db, sid)).toHaveLength(before);
  });

  it('二次压缩把已有摘要一起带上(滚动,不是覆盖)', async () => {
    const { db, sid } = fresh();
    for (let i = 0; i < 20; i++) appendMessage(db, sid, 'user', bigMsg(`m${i}`));
    await compact({ db, sessionId: sid, config, ctx: smallCtx });
    await compact({ db, sessionId: sid, config, ctx: smallCtx });

    const prompt = mocks.complete.mock.calls[1]![0].messages.at(-1)!.content as string;
    expect(prompt).toContain('已有摘要');
    expect(getRollingSummary(db, sid)!.upToId).toBeGreaterThan(0);
  });

  it('压缩不动体系 —— 工作副本一条没变', async () => {
    const { db, sid } = fresh();
    seedLibrary(db, { workcopy: true });
    for (let i = 0; i < 20; i++) appendMessage(db, sid, 'user', bigMsg(`m${i}`));
    await compact({ db, sessionId: sid, config, ctx: smallCtx });
    expect(listWorkFolders(db).map((w) => w.name)).toEqual(['深度学习']);
  });

  it('LLM 返回空摘要就不推进水位线 —— 不能把那段对话凭空吃掉', async () => {
    const { db, sid } = fresh();
    mocks.complete.mockResolvedValue('   ');
    for (let i = 0; i < 20; i++) appendMessage(db, sid, 'user', bigMsg(`m${i}`));
    await compact({ db, sessionId: sid, config, ctx: smallCtx });
    expect(getRollingSummary(db, sid)).toBeNull();
  });

  it('消息还不够多时直接返回', async () => {
    const { db, sid } = fresh();
    await compact({ db, sessionId: sid, config, ctx: smallCtx });
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it('摘要用的上下文口径与 buildContext 一致(不然两边会互相打架)', () => {
    // 20 条 1000 token 的消息,预算 3500 —— 显然超了
    const { db, sid } = fresh();
    for (let i = 0; i < 20; i++) appendMessage(db, sid, 'user', bigMsg(`m${i}`));
    const total = getMessages(db, sid).reduce((n, m) => n + estimateTokens(m.content), 0);
    expect(total).toBeGreaterThan(smallCtx.contextWindow - smallCtx.maxOutput - 1500);
  });
});

// 真机踩的坑:流式接口能"静默失败" —— 流正常结束但一个 chunk 都没有。
// 存成空消息的话用户只看到一句空白回复,完全不知道出了什么事。
describe('空回复不能当成功存下来', () => {
  it('模型一个 chunk 都不给 → 抛错,而且不落库 assistant 消息', async () => {
    const { db, sid } = fresh();
    mocks.stream.mockResolvedValue('');

    await expect(
      chatStream({ db, sessionId: sid, config, ctx: smallCtx, userMessage: '嗨', onChunk: () => {} }),
    ).rejects.toThrow(/没有返回任何内容/);

    // 只留用户那条 —— 界面上能重发
    expect(getMessages(db, sid).map((m) => m.role)).toEqual(['user']);
  });

  it('只有空白字符也算空', async () => {
    const { db, sid } = fresh();
    mocks.stream.mockResolvedValue('   \n  ');
    await expect(
      chatStream({ db, sessionId: sid, config, ctx: smallCtx, userMessage: '嗨', onChunk: () => {} }),
    ).rejects.toThrow(/没有返回任何内容/);
  });

  it('上游错误原样冒出来,不被换成"空回复"', async () => {
    const { db, sid } = fresh();
    mocks.stream.mockRejectedValue(new Error('Invalid prompt: System messages are not allowed'));
    await expect(
      chatStream({ db, sessionId: sid, config, ctx: smallCtx, userMessage: '嗨', onChunk: () => {} }),
    ).rejects.toThrow(/System messages are not allowed/);
  });
});
