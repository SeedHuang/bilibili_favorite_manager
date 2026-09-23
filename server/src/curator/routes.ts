/**
 * /api/curator/* 的路由(spec §9.0 流程)。
 *
 * 模型管理(/api/settings/*)已整体迁进 `@seedhuang/ai_suit_tool` —— 由 http/index.ts 里
 * 的 `registerAiSettings` 挂载,这里不再有那一段。
 *
 * 沿用 M3 的 registerXxxRoutes(app, deps) 模式:路由只做 HTTP 层,
 * 编排在 curator/ 里,存储走 db/repo/。
 */
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { Logger } from '../logger/index.js';
import { getItem, type ItemRow } from '../db/repo/items.js';
// 条目出口形状与 /api/folders/:id/items 共用同一份 —— 前端用同一套渲染,
// 分两份写迟早会分叉
import { shapeItem } from '../http/routes/items.js';
import { logOperation, listOperations } from '../db/repo/operations.js';
import { buildFolderProfiles } from './folderProfile.js';
import { buildWorkbenchView } from '../db/repo/workbenchView.js';
import {
  getWorkState, listWorkFolders, workItemIds, workItemIdsPaged,
} from '../db/repo/workbench.js';
import { getState, stateKey } from '../db/repo/state.js';
import {
  renameFolder, createFolder, deleteFolder, mergeFolders,
  moveItems, addItems, removeItems, resetWorkbench,
  reconcileAiFolder, applyRuleHitsToFolder,
} from './workbench.js';
import { isAiFolder as isAiFolderWork } from '../db/repo/aiFolders.js';

export interface CuratorDeps {
  db: Database.Database;
  log: Logger;
}

export function registerCuratorRoutes(app: FastifyInstance, deps: CuratorDeps): void {
  const { db, log } = deps;

  // ── 整理工作台(spec m4b)────────────────────────────
  //
  // 编辑只写 work_* 表;动作全部经 curator/workbench.ts,那里保证每次都记日志。
  // 路由里**不许**直接写 work_* 表 —— 绕过那层就漏记了(§9B.7 约束 1、2)。

  /**
   * 把动作抛出来的异常翻成 400/404。
   *
   * **注意它是 return 出去的** —— 调用方必须 `return actionError(reply, e)`。
   * 早先写成"helper 自己 send、调用方继续往下走"会双响应:
   * Fastify 会先被 helper 发一次 400,再被调用方发一次 200。
   */
  const actionError = (
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
    e: unknown,
  ) => {
    const reason = (e as Error)?.message ?? String(e);
    // 只认这一条消息的**前缀** —— 别扫整条文案:锁定夹子那条会把用户可控的
    // 夹子名拼进去,名字里带「不存在」就会被误判成 404。
    //
    // **失败的尝试也留痕**。actionError 之前是「错就错,什么都不记」,
    // 用户在 UI 上除了短暂的红条什么都看不到 —— 现在留一条 kind='failed' 的
    // 操作记录,「操作记录」面板里就能看到具体哪里错了。logging 自身抛错要 catch,
    // 不能让留痕反过来把失败路径给炸了。
    // logging 自身抛错要 catch,不能让留痕反过来把失败路径给炸了
    try {
      logOperation(db, {
        kind: 'failed',
        actor: 'user',
        summary: '失败:' + reason,
        detail: { reason },
      });
    } catch {
      /* logging 自身不能左右返回路径 */
    }
    return reply.code(/^工作副本里没有夹子/.test(reason) ? 404 : 400).send({ ok: false, reason });
  };

  app.get('/api/workbench', async () => {
    const view = buildWorkbenchView(db);
    const state = getWorkState(db);
    const currentFull = Number(getState(db, stateKey.lastFull) ?? 0) || 0;
    return {
      exists: state !== null,
      basedOn: state?.basedOn ?? null,
      // 整理期间又同步过 → 界面顶部要提示(不阻断,但不能不吭声)
      stale: state !== null && state.basedOn !== currentFull,
      ...view,
      /**
       * §9F C14:每个夹子的标签画像 + 离群条目。
       *
       * **一次算完整个数组**(几十个夹子,内存统计),不要在字段里按需算 ——
       * 那会让这个本来一次查询的接口变成 N 次。
       */
      profiles: buildFolderProfiles(db),
    };
  });

  app.post('/api/workbench/reset', async () => {
    resetWorkbench(db);
    log.event({ level: 'info', category: 'sync', message: '整理方案已还原' });
    return { ok: true };
  });

  /**
   * 「整理」—— 对勾选的夹子兑现成员关系。**纯本地计算**:不调 LLM、不花钱,
   * 它执行的是已经存在的规则与成员(spec §5)。
   * - AI 夹子 → reconcileAiFolder(精确对账,清出走安全网)
   * - 人类夹子 → applyRuleHitsToFolder(只加不清;没规则 = 跳过)
   */
  app.post('/api/workbench/tidy', async (req, reply) => {
    const { folderIds } = (req.body ?? {}) as { folderIds?: unknown };
    if (
      !Array.isArray(folderIds) ||
      folderIds.length === 0 ||
      folderIds.some((x) => !Number.isInteger(x))
    ) {
      return reply.code(400).send({ ok: false, reason: 'folderIds 必须是非空数字数组' });
    }
    const reconciled: { folderId: number; added: number; removed: number }[] = [];
    const ruleAdded: { folderId: number; added: number }[] = [];
    const skipped: string[] = [];
    for (const folderId of folderIds) {
      try {
        if (isAiFolderWork(db, folderId)) {
          reconciled.push({ folderId, ...reconcileAiFolder(db, folderId) });
        } else {
          const r = applyRuleHitsToFolder(db, folderId);
          if (r.added > 0) ruleAdded.push({ folderId, added: r.added });
          else skipped.push(String(folderId));
        }
      } catch (e) {
        skipped.push(`${folderId}: ${(e as Error).message}`);
      }
    }
    log.event({
      level: 'info',
      category: 'sync',
      message: `整理 ${folderIds.length} 个夹子:对账 ${reconciled.length} 个,规则补进 ${
        ruleAdded.reduce((s, r) => s + r.added, 0)
      } 条,跳过 ${skipped.length} 个`,
    });
    return { ok: true, reconciled, ruleAdded, skipped };
  });

  app.post('/api/workbench/folders', async (req, reply) => {
    const { name } = (req.body ?? {}) as { name?: string };
    if (typeof name !== 'string' || !name.trim()) {
      return reply.code(400).send({ ok: false, reason: 'name 不能为空' });
    }
    try {
      return { ok: true, id: createFolder(db, name) };
    } catch (e) {
      return actionError(reply, e);
    }
  });

  app.patch('/api/workbench/folders/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    const { name } = (req.body ?? {}) as { name?: string };
    if (typeof name !== 'string') {
      return reply.code(400).send({ ok: false, reason: 'name 必须是字符串' });
    }
    try {
      renameFolder(db, id, name);
      return { ok: true };
    } catch (e) {
      // 夹子不存在、名字为空、锁定的夹子改不了 —— 都由动作自己抛,这里只翻译
      return actionError(reply, e);
    }
  });

  app.delete('/api/workbench/folders/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    try {
      deleteFolder(db, id);
      return { ok: true };
    } catch (e) {
      return actionError(reply, e);
    }
  });

  /**
   * 把 fromIds 里的条目全搬进 :id,再把搬空了的源夹子删掉。
   *
   * 支持 N 个源:界面上的两个入口(夹子行的「合并」/ 顶栏的「移动并删除 N 个夹子」)
   * 都走这里 —— 一个动作两种入口,不发明新概念。
   */
  app.post('/api/workbench/folders/:id/merge', async (req, reply) => {
    const intoId = Number((req.params as { id: string }).id);
    const { fromIds } = (req.body ?? {}) as { fromIds?: unknown };
    if (!Array.isArray(fromIds) || fromIds.some((x) => typeof x !== 'number')) {
      return reply.code(400).send({ ok: false, reason: 'fromIds 必须是数字数组' });
    }
    try {
      const result = mergeFolders(db, fromIds as number[], intoId);
      return { ok: true, ...result };
    } catch (e) {
      return actionError(reply, e);
    }
  });

  /**
   * move 和 add 共用一段参数校验:两者都是"把 itemIds 放进 toFolderId"的形状。
   * remove 的目标是 fromFolderId —— 语义不同,单独写(见下)。
   */
  /**
   * move / add 的公共外壳。源有两种给法,二选一:
   *
   * - `itemIds`    —— 展开夹子后勾的具体条目(细粒度)
   * - `fromFolderIds` —— **整个夹子**:把那几个夹子里的条目全算上(粗粒度)
   *
   * 后者在服务端一次展开成 itemIds,所以是**一次请求、一条日志** ——
   * 让前端逐个夹子去拉条目再拼,既多几十个来回,日志也会被拆成几十条。
   */
  const toFolderAction = (
    handler: (itemIds: string[], toFolderId: number) => void,
  ) => async (
    req: { body?: unknown },
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  ) => {
    const body = (req.body ?? {}) as {
      itemIds?: unknown;
      fromFolderIds?: unknown;
      toFolderId?: number;
    };
    if (typeof body.toFolderId !== 'number') {
      return reply.code(400).send({ ok: false, reason: '缺少 toFolderId' });
    }

    if (Array.isArray(body.fromFolderIds)) {
      if (body.fromFolderIds.some((x) => typeof x !== 'number')) {
        return reply.code(400).send({ ok: false, reason: 'fromFolderIds 必须是数字数组' });
      }
      // 目标本身也在源里 = 自己移到自己,没有意义,直接拒掉比默默做一遍好
      if ((body.fromFolderIds as number[]).includes(body.toFolderId)) {
        return reply.code(400).send({ ok: false, reason: '目标夹子也在选中的夹子里' });
      }
    } else if (
      !Array.isArray(body.itemIds) ||
      !body.itemIds.every((x) => typeof x === 'string')
    ) {
      return reply
        .code(400)
        .send({ ok: false, reason: '要给出 itemIds(字符串数组)或 fromFolderIds(数字数组)' });
    }

    // 展开夹子要在 try 里面 —— "夹子不存在" 也得走 actionError 翻成 404,
    // 漏出去就是 500(actionError 的正则认那条例外消息)
    try {
      const itemIds = Array.isArray(body.fromFolderIds)
        ? (body.fromFolderIds as number[]).flatMap((fid) => {
            if (!listWorkFolders(db).some((f) => f.id === fid)) {
              throw new Error(`工作副本里没有夹子 ${fid}`);
            }
            return workItemIds(db, fid);
          })
        : (body.itemIds as string[]);

      handler(itemIds, body.toFolderId);
      return { ok: true, moved: itemIds.length };
    } catch (e) {
      return actionError(reply, e);
    }
  };

  app.post('/api/workbench/items/move', toFolderAction((ids, to) => moveItems(db, ids, to)));
  app.post('/api/workbench/items/add', toFolderAction((ids, to) => addItems(db, ids, to)));

  /** 移出:目标是从哪个夹子拿走,不是放进哪里 */
  app.post('/api/workbench/items/remove', async (req, reply) => {
    const body = (req.body ?? {}) as { itemIds?: unknown; fromFolderId?: number };
    if (!Array.isArray(body.itemIds) || body.itemIds.some((x) => typeof x !== 'string')) {
      return reply.code(400).send({ ok: false, reason: 'itemIds 必须是字符串数组' });
    }
    if (typeof body.fromFolderId !== 'number') {
      return reply.code(400).send({ ok: false, reason: '缺少 fromFolderId' });
    }
    try {
      removeItems(db, body.itemIds as string[], body.fromFolderId as number);
      return { ok: true };
    } catch (e) {
      return actionError(reply, e);
    }
  });

  app.get('/api/workbench/log', async (req) => {
    const limit = Number((req.query as { limit?: string }).limit ?? 200) || 200;
    return { operations: listOperations(db, { limit }) };
  });

  /**
   * 工作副本口径的条目列表 —— 展开夹子用。
   *
   * 出口形状与 `/api/folders/:id/items` **逐字段相同**,前端复用同一套渲染与
   * 截断提示。取数口径不同:那边是快照(B站 现在的样子),这边是工作副本
   * ("你桌上这份")—— 行头显示的 itemCount 也是这个口径,展开和它必须对得上。
   *
   * 新建的夹子没有快照原点,但完全可能有条目(移动 / 也放进都会往里写),
   * 所以**不能**按"没有 originId 就当它空"处理。
   */
  app.get('/api/workbench/folders/:id/items', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!listWorkFolders(db).some((f) => f.id === id)) {
      return reply.code(404).send({ ok: false, reason: `工作副本里没有夹子 ${id}` });
    }
    const q = req.query as { page?: string; pageSize?: string };
    const page = Math.max(1, Number(q.page ?? 1) || 1);
    const pageSize = Math.max(1, Number(q.pageSize ?? 500) || 500);

    const ids = workItemIdsPaged(db, id, { limit: pageSize, offset: (page - 1) * pageSize });
    // favTime 恒为 null:work_folder_items 不存收藏时间(那是快照的属性,
    // 由同步维护),这里只回答"这条在不在这个夹子里"
    const items = ids
      .map((iid) => getItem(db, iid))
      .filter((x): x is ItemRow => x !== undefined)
      .map((x) => shapeItem(x, null));
    return { items, total: workItemIds(db, id).length };
  });

}
