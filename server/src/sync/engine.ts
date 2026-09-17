import { randomUUID } from 'node:crypto';
import { listFolders, type FolderRow } from '../db/repo/folders.js';
import { countFolderItems } from '../db/repo/items.js';
import { getState, setState, stateKey } from '../db/repo/state.js';
import { syncFolderList, type FolderSyncResult, type SyncDeps } from './folders.js';
import { syncFolderItems } from './items.js';
import { RiskControlError, AuthError } from '../bilibili/errors.js';

export interface SyncProgress {
  phase: 'folders' | 'items';
  current: number;
  total: number;
  folderTitle?: string;
}

export interface SyncReport {
  folders: number;
  foldersSynced: number;
  foldersSkipped: number;
  /** 拉取失败的夹子数 —— 已经算在 foldersSynced 之外 */
  foldersFailed: number;
  items: number;
  durationMs: number;
  /** 串联这次同步产生的所有 api_calls */
  traceId: string;
}

/** 读出夹子当前记录的 mtime(没记录/行不存在 → null) */
function folderMtime(db: SyncDeps['db'], folderId: number): number | null {
  const row = db.prepare(`SELECT mtime FROM folders WHERE id = ?`).get(folderId) as
    | { mtime: number | null }
    | undefined;
  return row?.mtime ?? null;
}

/**
 * 增量判据。
 *
 * **刻意不依赖 mtime** —— 实测未确认 list-all 是否返回它(见 spec §14)。
 * 有 mtime 就当作额外的变更信号,没有就只比数量。
 *
 * `prevMtime` 是**本次同步之前**本地记录的 mtime。runSync 必须在
 * `syncFolderList` 落库**之前**取快照 —— 那个函数会把 B站 的 mtime 覆盖进
 * folders 表,之后再读就只能读到刚写进去的新值,比较恒为相等,mtime 信号
 * 就成了死代码。不传(undefined)时退回读表:调用方传进来的若是尚未落库的
 * folder 对象,表里存的就是上一轮的值,等价于快照。
 *
 * **已知局限**:「删掉一条 + 新增一条」导致 media_count 不变时,这里判定为
 * 无需同步。要兜底就用 `full: true` 做一次全量。这是刻意的取舍:
 * 为这个少见情况让每次启动都全量重拉 64 个夹子,不划算。
 */
export function needsSync(
  db: SyncDeps['db'],
  folder: FolderRow,
  prevMtime?: number | null,
): boolean {
  // 基准是「上次**完整**拉完时 B站 报的条数」,不是本地条数。
  //
  // 用 `localCount !== media_count` 会恒真:失效视频被 B站 从列表里滤掉、
  // 却不从 media_count 里扣,所以本地条数**永远**比它小 —— 结果就是每次启动
  // 全量重拉 64 个夹子,而且永远追不平。(M1 spec 里标记要修的那个病。)
  const synced = getState(db, stateKey.folderSyncedCount(folder.id));
  if (synced === undefined) return true; // 从没完整拉过 → 要拉
  if (Number(synced) !== folder.media_count) return true; // B站报的条数变了

  // 本地比远端报的还多 = 异常(上次对账没跑完之类),值得重拉。
  // 正常情况本地只会 ≤ media_count(失效视频被滤掉),所以这条不会恒真 ——
  // 它是安全的兜底,不是把老毛病加回来。
  if (countFolderItems(db, folder.id) > folder.media_count) return true;

  if (folder.mtime == null) return false;
  const prev = prevMtime !== undefined ? prevMtime : folderMtime(db, folder.id);
  return prev != null && prev !== folder.mtime;
}

/**
 * 跑一次同步。
 *
 * 顺序:先拉夹子列表(1 次请求)→ 对比判据挑出变化的夹子 → 只对它们分页拉条目。
 * 单个夹子失败不中断整体 —— 记 error 事件后继续下一个。
 */
export async function runSync(
  deps: SyncDeps,
  upMid: number,
  opts: { full?: boolean; pageSize?: number; onProgress?: (p: SyncProgress) => void } = {},
): Promise<SyncReport> {
  const { db, log } = deps;
  const traceId = randomUUID();
  const startedAt = Date.now();

  // 把本次 run 的所有请求串到同一个 trace 上(spec §6)
  deps.client.setRequestListener((r) => log.apiCall(traceId, r));

  // ① 取 mtime 快照必须在 syncFolderList **之前** —— 它会把 B站 的 mtime
  // 覆盖进 folders 表,之后再读就只能读到新值,增量判据里的 mtime 信号会变成死代码。
  const prevMtimes = new Map(listFolders(db).map((f) => [f.id, f.mtime]));

  // ② 夹子列表(唯一一次全量请求)
  // 失败时先记一条 error 事件再抛 —— 这个错误会直接终止整次同步,
  // 不写日志的话 /logs 上是完全静默的,用户只看得到 CLI 的一句报错。
  let folderResult: FolderSyncResult;
  try {
    folderResult = await syncFolderList(deps, upMid);
  } catch (e) {
    log.event({
      level: 'error',
      category: 'sync',
      code: 'FOLDER_LIST_FAILED',
      message: '拉取收藏夹列表失败,同步已终止',
      detail: { error: (e as Error)?.message ?? String(e) },
    });
    throw e;
  }
  opts.onProgress?.({ phase: 'folders', current: folderResult.count, total: folderResult.count });

  // ③ 挑出需要同步的夹子
  const folders = listFolders(db);
  const targets = opts.full
    ? folders
    : folders.filter((f) => needsSync(db, f, prevMtimes.get(f.id) ?? null));

  // ④ 逐个同步,单个失败不影响其余
  let items = 0;
  let failed = 0;
  let done = 0;
  for (const folder of targets) {
    try {
      const r = await syncFolderItems(deps, folder.id, {
        ...(opts.pageSize !== undefined ? { pageSize: opts.pageSize } : {}),
      });
      items += r.fetched;
    } catch (e) {
      // 风控 / 未登录不是「这个夹子失败了」,而是「整个队列必须立刻停」(spec §8)。
      // 在这里吞掉它,循环会继续往下走,客户端就会对着一个正在拒绝服务的接口
      // 再打 60 多次请求 —— 正是风控最不该做的事。原样抛穿,让调用方去提示用户。
      if (e instanceof RiskControlError || e instanceof AuthError) throw e;
      failed += 1;
      log.event({
        level: 'error',
        category: 'sync',
        code: 'FOLDER_SYNC_FAILED',
        message: `同步收藏夹「${folder.title}」失败`,
        detail: { error: (e as Error)?.message ?? String(e), folderId: folder.id },
        folderId: folder.id,
      });
    }
    done += 1;
    opts.onProgress?.({
      phase: 'items', current: done, total: targets.length, folderTitle: folder.title,
    });
  }

  const report: SyncReport = {
    folders: folderResult.count,
    foldersSynced: targets.length - failed,
    foldersSkipped: folders.length - targets.length,
    foldersFailed: failed,
    items,
    durationMs: Date.now() - startedAt,
    traceId,
  };

  // 注意:stateKey.lastFull 每次同步都会写(含增量),这里记录的是「上次同步时间」
  // 而不是「上次全量同步时间」—— key 名沿用了旧约定。
  setState(db, stateKey.lastFull, String(Date.now()));
  log.event({
    level: 'info',
    category: 'sync',
    message:
      `同步完成:${report.folders} 个收藏夹,拉取 ${items} 条,` +
      `跳过 ${report.foldersSkipped} 个未变化的` +
      (failed > 0 ? `,${failed} 个失败` : '') +
      `,耗时 ${Math.round(report.durationMs / 1000)}s`,
    detail: report,
  });

  return report;
}
