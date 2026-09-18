/**
 * 夹子画像 + 离群标记(spec §9F C14/C15)。
 *
 * 两件事刻意分开:
 *
 * - **画像**是**喂给模型的输入**(C15:让"提体系"那一环看得见夹子里实际有什么,
 *   而不是只会看夹子名瞎猜 —— §9C.0 的事故就是这个猜造成的),顺便给人看。
 * - **离群标记**是**零参数判据**:一条视频若它**每一个**标签在该夹子的其他视频
 *   身上都不出现,就是可疑。没有"多少算不搭"这种要拍的数。
 *
 * **它照的是镜子,不是裁判**:夹子本来就一半放错了,画像就是错的,离群也跟着不准。
 */
import type Database from 'better-sqlite3';
import { listWorkFolders, workItemIds } from '../db/repo/workbench.js';
import { itemTagIds, tagNamesById } from '../db/repo/tags.js';

/** 离群判定外的统计下限 —— 与 C9 同一个数,理由也一样:少于它没有统计意义 */
export const MIN_SAMPLE = 5;

export interface FolderProfile {
  folderId: number;
  name: string;
  itemCount: number;
  /** 高频标签,降序。模型据此知道"这个夹子实际是什么" */
  topTags: { name: string; count: number }[];
  /** 可疑的条目 id:它每个标签在这个夹子里都没有同伴 */
  outliers: string[];
}

export function buildFolderProfiles(db: Database.Database): FolderProfile[] {
  const nameOf = tagNamesById(db);
  const tagsOf = itemTagIds(db);

  return listWorkFolders(db).map((f) => {
    const ids = workItemIds(db, f.id);
    const freq = new Map<number, number>();
    const own = new Map<string, Set<number>>();

    for (const itemId of ids) {
      const tags = tagsOf.get(itemId) ?? [];
      if (tags.length === 0) continue;
      own.set(itemId, new Set(tags));
      for (const t of tags) freq.set(t, (freq.get(t) ?? 0) + 1);
    }

    // 离群:样本够 + 这条有标签 + 它的每个标签在这个夹子里**只**出现在它身上
    const outliers: string[] = [];
    if (ids.length >= MIN_SAMPLE) {
      for (const [itemId, mine] of own) {
        const lonely = [...mine].every((t) => (freq.get(t) ?? 0) <= 1);
        if (lonely) outliers.push(itemId);
      }
    }

    return {
      folderId: f.id,
      name: f.name,
      itemCount: ids.length,
      topTags: [...freq.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([t, count]) => ({ name: nameOf.get(t) ?? String(t), count })),
      outliers: outliers.sort(),
    };
  });
}

/**
 * 渲染成给模型看的一段。**空画像不占行** —— 和 renderItem 的标签行同一个规矩。
 */
export function renderProfiles(profiles: readonly FolderProfile[]): string {
  return profiles
    .filter((p) => p.topTags.length > 0)
    .map((p) => {
      const mix = p.topTags.map((t) => `${t.name} ${Math.round((t.count / Math.max(1, p.itemCount)) * 100)}%`).join('、');
      return `- ${p.name}(${p.itemCount} 条)—— 实际构成:${mix}`;
    })
    .join('\n');
}
