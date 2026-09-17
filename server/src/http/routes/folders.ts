import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { Logger } from '../../logger/index.js';
import {
  listFolders,
  getFolder,
  isLockedFolder,
  isDefaultFolder,
  setFolderLock,
} from '../../db/repo/folders.js';
import { listWorkFolders } from '../../db/repo/workbench.js';

export function registerFolderRoutes(
  app: FastifyInstance,
  deps: { db: Database.Database; log: Logger },
): void {
  const { db, log } = deps;

  app.get('/api/folders', async () => {
    const folders = listFolders(db);
    return {
      folders: folders.map((f) => ({
        id: f.id,
        title: f.title,
        mediaCount: f.media_count,
        type: f.type,
        // 锁定的夹子(B站 账号自带的默认收藏夹)不能改名/删除,只能往里外移条目
        locked: isLockedFolder(db, f),
        lockedBy: isDefaultFolder(f) ? 'default' : null,
      })),
    };
  });

  /** 手动锁 / 解锁。传 null 清掉覆盖,回到自动判定 */
  app.put('/api/folders/:id/lock', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!getFolder(db, id)) return reply.code(404).send({ ok: false, reason: '收藏夹不存在' });

    const { locked } = (req.body ?? {}) as { locked?: boolean | null };
    if (locked !== null && typeof locked !== 'boolean') {
      return reply.code(400).send({ ok: false, reason: 'locked 只接受 true / false / null' });
    }

    // 锁上之后就不能改名了,所以工作副本里这个夹子得先改回原样再锁。
    //
    // 不改的话会留下「已锁定 + 名字与快照不同」—— 约束 4 明令不许的状态:
    // ✎ 标记在、铅笔按钮没了、既改不回去也删不掉,而 M5 写回 B站 时必然被拒。
    // 编辑那一侧由 assertNotLocked 挡着,但上锁走的不是编辑路径,这里不查就漏了。
    //
    // 而**上锁恰恰是用户用来纠正自动判定的动作**(「这其实就是默认收藏夹,
    // 我不该改它名」),所以这个顺序最容易撞上,得说清怎么办。
    if (locked === true) {
      const work = listWorkFolders(db).find((w) => w.originId === id);
      const snapshot = getFolder(db, id);
      if (work && snapshot && work.name !== snapshot.title) {
        return reply.code(400).send({
          ok: false,
          reason: `「${work.name}」在你的方案里已经改过名了 —— 先把它改回「${snapshot.title}」再锁定`,
        });
      }
    }

    setFolderLock(db, id, locked);
    log.event({
      level: 'info',
      category: 'sync',
      message: `收藏夹 ${id} 锁定状态改为 ${locked === null ? '自动判定' : locked ? '锁定' : '解锁'}`,
    });
    return { ok: true, locked: isLockedFolder(db, getFolder(db, id)!) };
  });
}
