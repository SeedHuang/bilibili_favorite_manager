import type Database from 'better-sqlite3';
import type { BiliClient } from '../bilibili/client.js';
import type { Logger } from '../logger/index.js';
import { upsertFolder } from '../db/repo/folders.js';
import { parseFolder } from './parse.js';

export interface SyncDeps {
  client: BiliClient;
  db: Database.Database;
  log: Logger;
}

export interface FolderSyncResult {
  count: number;
  totalItems: number;
}

interface FolderListPayload {
  list?: unknown[];
}

/**
 * 拉取收藏夹列表并落库。
 *
 * **实测结论(2026-09-14)**:`type` 参数被忽略 —— 传 11(视频)和 21(文章)
 * 返回完全相同的数据。所以这里**只请求一次**,不要写 type 循环。
 * 夹子类型改由条目的 type 反推(M3/M4 再说)。
 *
 * 实测该接口**不需要 wbi**,所以 signed:false,省掉一次 nav 请求。
 */
export async function syncFolderList(
  deps: SyncDeps,
  upMid: number,
): Promise<FolderSyncResult> {
  const { client, db, log } = deps;

  const data = await client.get<FolderListPayload>(
    '/x/v3/fav/folder/created/list-all',
    { up_mid: upMid },
    { signed: false },
  );

  // data 为 null 是合法响应(用户没有任何该类型收藏夹),不是错误。
  // list 也校验是数组:这是外部数据的信任边界 —— 形状变了应该退化成「没有收藏夹」,
  // 而不是在事务里抛 TypeError 把整次同步带崩(字符串还会被逐字符遍历)。
  const list = Array.isArray(data?.list) ? data.list : [];

  let count = 0;
  let totalItems = 0;
  let skipped = 0;

  const write = db.transaction((rows: unknown[]) => {
    for (const row of rows) {
      const folder = parseFolder(row);
      if (!folder) {
        skipped += 1;
        continue;
      }
      upsertFolder(db, folder);
      count += 1;
      totalItems += folder.mediaCount;
    }
  });
  write(list);

  if (skipped > 0) {
    log.event({
      level: 'warn',
      category: 'sync',
      code: 'FOLDER_PARSE_SKIP',
      message: `收藏夹列表有 ${skipped} 条无法解析,已跳过`,
    });
  }

  log.event({
    level: 'info',
    category: 'sync',
    message: `收藏夹列表同步完成:${count} 个,共 ${totalItems} 条`,
  });

  return { count, totalItems };
}
