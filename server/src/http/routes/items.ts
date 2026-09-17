import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { Logger } from '../../logger/index.js';
import {
  getItem,
  listItemIdsByFolder,
  countFolderItems,
  type ItemRow,
} from '../../db/repo/items.js';

/** FTS 表默认返回条数上限(搜索没分页,UI 只展示首屏) */
const SEARCH_LIMIT = 50;

/**
 * 建 FTS5 虚拟表(幂等)。
 *
 * external content 表:只存索引,正文从 items 按 rowid 读,不重复占空间。
 * M2 的 items 没有触发器,而且**同步是独立进程**(sync-live.ts) —— 本进程的
 * 触发器也追不上那边的写入。所以搜索前统一 `rebuild`(3000 条毫秒级),
 * 这是只读 UI + 外部同步下最省心的做法:
 * ponytail: 每次搜索全量 rebuild,数据到十万级再换成同步后调用 + 触发器增量维护。
 */
function ensureFts(db: Database.Database): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
      id UNINDEXED, title, intro, upper_name,
      content='items', content_rowid='rowid'
    );
  `);
}

/**
 * 把用户输入变成安全的 FTS5 MATCH 串。
 * 每个词用双引号包起来做字面量(躲开 `-` `(` `*` 等语法字符),再加 `*` 前缀匹配。
 * ponytail: 用默认 unicode61 分词,CJK 整段是一个 token,中文只能整词命中;
 * 要中文子串搜索就换 trigram tokenizer —— 等真觉得搜不动再加。
 */
function toMatch(q: string): string {
  return q
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"*`)
    .join(' ');
}

/**
 * 统一出口形状 —— 与前端约定的字段名(camelCase)。
 *
 * **导出**给整理工作台的条目接口复用:那一份取的是工作副本口径,但出口形状
 * 必须和这里逐字段相同 —— 前端用同一套渲染,分两份写迟早会分叉。
 */
export function shapeItem(i: ItemRow, favTime: number | null) {
  return {
    id: i.id,
    title: i.title,
    cover: i.cover,
    duration: i.duration,
    pubtime: i.pubtime,
    favTime,
    upperName: i.upper_name,
    invalid: i.invalid,
  };
}

export function registerItemRoutes(
  app: FastifyInstance,
  deps: { db: Database.Database; log: Logger },
): void {
  const { db } = deps;
  ensureFts(db);

  // 某收藏夹下的条目(按收藏时间倒序,分页)
  app.get('/api/folders/:id/items', async (req) => {
    const { id } = req.params as { id: string };
    const folderId = Number(id);
    const q = req.query as { page?: string; pageSize?: string };
    const page = Math.max(1, Number(q.page ?? 1) || 1);
    const pageSize = Math.max(1, Number(q.pageSize ?? 20) || 20);

    const ids = listItemIdsByFolder(db, folderId, {
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });
    const favStmt = db.prepare(
      `SELECT fav_time FROM folder_items WHERE folder_id = ? AND item_id = ?`,
    );
    const items = ids
      .map((iid) => {
        const item = getItem(db, iid);
        if (!item) return null;
        const fav = favStmt.get(folderId, iid) as { fav_time: number | null } | undefined;
        return shapeItem(item, fav?.fav_time ?? null);
      })
      .filter((x) => x !== null);

    return { items, total: countFolderItems(db, folderId) };
  });

  // FTS5 搜索(标题 / 简介 / UP 名)
  app.get('/api/items/search', async (req) => {
    const q = String((req.query as { q?: string }).q ?? '').trim();
    if (!q) return { items: [] };

    db.prepare(`INSERT INTO items_fts(items_fts) VALUES('rebuild')`).run();
    const rows = db
      .prepare(
        `SELECT i.* FROM items_fts f JOIN items i ON i.rowid = f.rowid
         WHERE f.items_fts MATCH ? LIMIT ?`,
      )
      .all(toMatch(q), SEARCH_LIMIT) as ItemRow[];

    return { items: rows.map((r) => shapeItem(r, null)) };
  });

  // 单条目详情 + 它所属的收藏夹
  app.get('/api/items/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const item = getItem(db, id);
    if (!item) return reply.code(404).send({ error: '条目不存在' });

    const folders = db
      .prepare(
        `SELECT f.id, f.title FROM folder_items fi
         JOIN folders f ON f.id = fi.folder_id
         WHERE fi.item_id = ? ORDER BY f.title`,
      )
      .all(id) as { id: number; title: string }[];

    return { item: shapeItem(item, null), folders };
  });
}
