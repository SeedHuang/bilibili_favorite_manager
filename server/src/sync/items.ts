import { upsertItem, linkFolderItem } from '../db/repo/items.js';
import { getFolder } from '../db/repo/folders.js';
import { getState, setState, deleteState, stateKey } from '../db/repo/state.js';
import { parseItem } from './parse.js';
import type { SyncDeps } from './folders.js';

/** 实测 20 条/页是 B站默认;调大不保证被接受,保守用 20 */
const DEFAULT_PAGE_SIZE = 20;
/** 兜底上限 —— 一个夹子 200 页 = 4000 条,超过说明逻辑出问题了 */
const DEFAULT_MAX_PAGES = 200;

export interface ItemSyncResult {
  folderId: number;
  fetched: number;
  pages: number;
  /** 从第几页开始拉的(>1 说明是断点续传) */
  resumedFrom: number;
}

interface MediaListPayload {
  medias?: unknown[];
  /** B站自己说"后面还有" —— 唯一可靠的翻页信号(实测第 12 页返回 true) */
  has_more?: boolean;
}

/**
 * 对账:删掉本地还挂着、但这一趟远端没返回的关联行。
 *
 * SQLite 自带的 JSON1(`json_each`)就是为这种「把一小撮 id 传进 SQL」准备的,
 * 不值得为此建临时表。
 */
function reconcileFolderItems(
  db: SyncDeps['db'],
  folderId: number,
  seen: Set<string>,
): void {
  if (seen.size === 0) {
    // 远端这个夹子真的空了。走 json_each 也行,但少一次序列化。
    db.prepare(`DELETE FROM folder_items WHERE folder_id = ?`).run(folderId);
    return;
  }
  db.prepare(
    `DELETE FROM folder_items
      WHERE folder_id = ? AND item_id NOT IN (SELECT value FROM json_each(?))`,
  ).run(folderId, JSON.stringify([...seen]));
}

/**
 * 分页拉取某个收藏夹的条目。
 *
 * 断点续传语义:每页写一次游标(`sync:cursor:<folderId>` = **下一页**页码),
 * 中断后重跑从游标继续;全部拉完删游标。
 *
 * 实测该接口**不需要 wbi**,所以 signed:false。
 */
export async function syncFolderItems(
  deps: SyncDeps,
  folderId: number,
  opts: { pageSize?: number; maxPages?: number; restart?: boolean } = {},
): Promise<ItemSyncResult> {
  const { client, db, log } = deps;
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const cursorKey = stateKey.cursor(folderId);

  if (opts.restart) deleteState(db, cursorKey);

  const saved = getState(db, cursorKey);
  let pn = saved ? Number(saved) : 1;
  if (!Number.isFinite(pn) || pn < 1) pn = 1; // 游标坏了就从头来,不要卡死
  const resumedFrom = pn;

  let fetched = 0;
  let pages = 0;
  /** 这一趟在远端看到的 item_id —— 收尾对账用 */
  const seen = new Set<string>();
  /** 这一趟有多少行没能解析出来(等于「有哪些条目我们连 id 都不知道」) */
  let skipped = 0;

  // 循环是怎么结束的:排干净了(break)还是撞到 maxPages 上限了。
  // 不能只看 `pages >= maxPages` —— 恰好在上限那一页排干净时会误报 PAGE_LIMIT,
  // 而且会把「看全了、可以对账」误判成「没看全」。
  let hitLimit = true;

  while (pages < maxPages) {
    const data = await client.get<MediaListPayload>(
      '/x/v3/fav/resource/list',
      { media_id: folderId, pn, ps: pageSize, platform: 'web' },
      { signed: false },
    );

    // medias 是外部数据的信任边界:形状变了应该退化成「本页为空」,
    // 而不是让 `for...of` 抛 TypeError 把整次同步带崩。
    // (字符串可迭代,会被逐字符遍历 —— 所以必须 Array.isArray,不能只看 null。)
    const medias = Array.isArray(data?.medias) ? data.medias : [];

    const write = db.transaction((rows: unknown[]) => {
      for (const row of rows) {
        const item = parseItem(row);
        if (!item) {
          skipped += 1;
          continue;
        }
        upsertItem(db, item);
        // fav_time 是关联属性,不在 items 表里,单独写进 folder_items
        const favTime =
          typeof (row as Record<string, unknown>)['fav_time'] === 'number'
            ? ((row as Record<string, unknown>)['fav_time'] as number)
            : null;
        linkFolderItem(db, folderId, item.id, favTime);
        seen.add(item.id);
        fetched += 1;
      }
    });
    write(medias);
    pages += 1;

    // 到底了没有 —— **不能用"这页不满 pageSize"判断**。
    // B站把失效视频从结果里滤掉,但不在 media_count 里扣:所以中间某页
    // 只有 19 条是正常的,用长度判断会当成"排完了"提前收工。
    // (实测代价:默认收藏夹 2921 条只拉到 239 条,还把游标删了 → 永远补不齐)
    //
    // has_more 才是 B站自己给的翻页信号。万一某天它不返回了,才退回长度判断 ——
    // 退回是旧行为,不会比现在更糟。
    const hasMore = typeof data?.has_more === 'boolean' ? data.has_more : null;
    const reachedEnd = hasMore === null ? medias.length < pageSize : !hasMore;

    // 空页永远终止,不管 has_more 说什么 —— 防服务器一直说"还有"却不给数据
    if (medias.length === 0 || reachedEnd) {
      deleteState(db, cursorKey);
      hitLimit = false;
      break;
    }

    pn += 1;
    // 先写游标再进下一页 —— 崩在下一页时能从这页重来
    setState(db, cursorKey, String(pn));
  }

  if (hitLimit) {
    log.event({
      level: 'warn',
      category: 'sync',
      code: 'PAGE_LIMIT',
      message: `收藏夹 ${folderId} 达到分页上限 ${maxPages} 页,已停止`,
      folderId,
    });
  }

  // 记下这里看到的 B站条数,作为下次增量判据的基准。
  //
  // 判据**不看** resumedFrom:游标是单调前进的,能走到末尾就说明 1..N 页都拉过了
  // (跨多趟也算),所以这趟到末尾就够格记基准。
  // 仍然要求 !hitLimit && skipped === 0 —— 没看全的时候记下的数会让下次误判成"没变"。
  if (!hitLimit && skipped === 0) {
    const mediaCount = getFolder(db, folderId)?.media_count;
    if (mediaCount != null) {
      setState(db, stateKey.folderSyncedCount(folderId), String(mediaCount));
    }
  }

  // 对账 —— 只有一趟**真的看全了整个夹子**才有资格判定「远端没有了」:
  //   · resumedFrom === 1:从第 1 页开始。续传的趟只看得到后半段,照着删就是误删。
  //     (这条比上面严:记基准可以跨趟累计,删行必须单趟看全。)
  //   · !hitLimit:排干净了,不是撞上限被截断的。
  //   · skipped === 0:有解析不了的行时不能删 —— 那些条目远端其实还在,
  //     只是形状变了。删掉会让 localCount 永远小于 media_count,needsSync 恒真,
  //     每次启动都全量重拉,正好是这次要修的病。
  if (resumedFrom === 1 && !hitLimit && skipped === 0) {
    reconcileFolderItems(db, folderId, seen);
  }

  return { folderId, fetched, pages, resumedFrom };
}
