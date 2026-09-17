import { describe, it, expect } from 'vitest';
import { openDb } from '../index.js';
import {
  newSession,
  listSessions,
  getSession,
  appendMessage,
  getMessages,
  countMessages,
  archiveSession,
  setRollingSummary,
  getRollingSummary,
  upsertDraft,
  getLatestDraft,
  type FolderSpec,
} from './sessions.js';

const fresh = () => {
  const db = openDb(':memory:');
  return { db, sid: newSession(db, '整理文件夹 2026-09-15') };
};

const folders: FolderSpec[] = [
  { tempId: 'f1', name: 'AI/编程', description: '编程相关', rule: '标题含 Python/JS', estCount: 120 },
];

describe('会话 CRUD', () => {
  it('新建会话返回 id,状态 active', () => {
    const { db, sid } = fresh();
    expect(sid).toBeGreaterThan(0);
    expect(getSession(db, sid)!.status).toBe('active');
    expect(getSession(db, sid)!.title).toBe('整理文件夹 2026-09-15');
  });

  it('消息按时间正序返回', () => {
    const { db, sid } = fresh();
    appendMessage(db, sid, 'user', '第一条');
    appendMessage(db, sid, 'assistant', '第二条');
    appendMessage(db, sid, 'user', '第三条');
    expect(getMessages(db, sid).map((m) => m.content)).toEqual(['第一条', '第二条', '第三条']);
  });

  it('给了 limit 取最近 N 条,但仍按正序返回', () => {
    const { db, sid } = fresh();
    for (const t of ['a', 'b', 'c', 'd']) appendMessage(db, sid, 'user', t);
    expect(getMessages(db, sid, { limit: 2 }).map((m) => m.content)).toEqual(['c', 'd']);
  });

  it('afterId 只取水位线之后的消息(压缩后接着聊)', () => {
    const { db, sid } = fresh();
    const first = appendMessage(db, sid, 'user', 'a');
    appendMessage(db, sid, 'assistant', 'b');
    expect(getMessages(db, sid, { afterId: first }).map((m) => m.content)).toEqual(['b']);
  });

  it('首条用户消息顺手当预览,且不会被后续消息覆盖', () => {
    const { db, sid } = fresh();
    appendMessage(db, sid, 'assistant', '你好');
    appendMessage(db, sid, 'user', '把收藏夹整理一下');
    appendMessage(db, sid, 'user', '再合并几个');
    expect(getSession(db, sid)!.preview).toBe('把收藏夹整理一下');
    expect(getSession(db, sid)!.preview).toBe('把收藏夹整理一下');
  });

  it('长预览截断到 40 字', () => {
    const { db, sid } = fresh();
    appendMessage(db, sid, 'user', '啊'.repeat(200));
    expect(getSession(db, sid)!.preview).toHaveLength(40);
  });

  it('归档 = 改状态,消息仍在(历史可续)', () => {
    const { db, sid } = fresh();
    appendMessage(db, sid, 'user', '别删我');
    archiveSession(db, sid);
    expect(getSession(db, sid)!.status).toBe('archived');
    expect(countMessages(db, sid)).toBe(1);
  });

  it('会话列表按最近更新倒序 —— 刚聊过的在最上面', () => {
    const db = openDb(':memory:');
    const a = newSession(db, 'A');
    const b = newSession(db, 'B');
    appendMessage(db, a, 'user', '刚聊过');
    expect(listSessions(db)[0]!.id).toBe(a);
    expect(listSessions(db)).toHaveLength(2);
    expect(b).toBeGreaterThan(0);
  });
});

describe('滚动摘要', () => {
  it('存了能读回来(带水位线)', () => {
    const { db, sid } = fresh();
    setRollingSummary(db, sid, { upToId: 12, text: '用户想把 42 个夹子合并到 12 个' });
    expect(getRollingSummary(db, sid)).toEqual({
      upToId: 12,
      text: '用户想把 42 个夹子合并到 12 个',
    });
  });

  it('没压缩过返回 null', () => {
    const { db, sid } = fresh();
    expect(getRollingSummary(db, sid)).toBeNull();
  });

  it('坏 JSON 当作没压缩过,不炸掉整轮对话', () => {
    const { db, sid } = fresh();
    db.prepare(`UPDATE sessions SET summary = ? WHERE id = ?`).run('{不是 json', sid);
    expect(getRollingSummary(db, sid)).toBeNull();
  });
});

describe('体系草稿', () => {
  it('没有草稿返回 null', () => {
    const { db, sid } = fresh();
    expect(getLatestDraft(db, sid)).toBeNull();
  });

  it('存了能读回完整结构(含 reuseFolderId)', () => {
    const { db, sid } = fresh();
    upsertDraft(db, sid, [{ ...folders[0]!, reuseFolderId: 42 }], '控制在 12 个以内');
    const draft = getLatestDraft(db, sid)!;
    expect(draft.folders).toHaveLength(1);
    expect(draft.folders[0]!.reuseFolderId).toBe(42);
    expect(draft.constraints).toBe('控制在 12 个以内');
  });

  it('同一会话 upsert 是覆盖,不是追加 —— 草稿永远只有一份', () => {
    const { db, sid } = fresh();
    upsertDraft(db, sid, folders);
    upsertDraft(db, sid, [...folders, { ...folders[0]!, tempId: 'f2', name: '前端' }]);
    expect(getLatestDraft(db, sid)!.folders).toHaveLength(2);
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM taxonomy_draft`).get() as { n: number },
    ).toEqual({ n: 1 });
  });

  it('草稿是会话级隔离的', () => {
    const db = openDb(':memory:');
    const a = newSession(db, 'A');
    const b = newSession(db, 'B');
    upsertDraft(db, a, folders);
    expect(getLatestDraft(db, b)).toBeNull();
  });
});
