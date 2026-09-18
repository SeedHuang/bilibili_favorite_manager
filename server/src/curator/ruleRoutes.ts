/**
 * /api/rules/* 的路由(spec §9C)。
 *
 * 规则是**你 / AI 共同维护的本地资产**:bilibili 有夹子但没有逻辑,
 * 谁进谁出全靠手。它只存在本地,不上传 B站。
 *
 * 单独一个文件:curator/routes.ts 已经 786 行,而规则这一页是独立的一件事
 * (整页 CRUD + 命中数 + 试跑),塞进去只会让那个文件过千行。
 */
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import type { Logger } from '../logger/index.js';
import {
  listRules, getRule, saveRule, deleteRule, type RuleCondition, type RuleOrigin,
} from '../db/repo/rules.js';
import { listWorkFolders } from '../db/repo/workbench.js';
import { listFolders, isLockedFolder } from '../db/repo/folders.js';
import type { ItemRow } from '../db/repo/items.js';
import { itemTagIds, subtreeSets } from '../db/repo/tags.js';
import { readLlmSettings } from '../llm/config.js';
import { batchSize } from '../llm/context.js';
import { matchAll, toRuleItem, validateSuggestion } from './rules.js';
import { runSuggestions, suggestionInput } from './suggestions.js';

export interface RuleDeps {
  db: Database.Database;
  log: Logger;
}

export interface RuleView {
  folderId: number;
  folderName: string;
  /** 锁定的夹子不能加规则(spec §9C.6 约束 4) */
  locked: boolean;
  /** 空数组 = 还没有规则 */
  conditions: RuleCondition[];
  /** null = 还没人写过 */
  origin: RuleOrigin | null;
  updatedAt: number | null;
  /** 命中数:这条规则会从**全库**捞走多少条(spec §9C.4 口径) */
  hit: number;
}

export function registerRuleRoutes(app: FastifyInstance, deps: RuleDeps): void {
  const { db } = deps;

  /**
   * 命中数在服务端**一次算完**(打开面板时 + 每次改完规则后)。
   *
   * 口径是**全库 items**(不是某个夹子里的子集)—— 要回答的是
   * "这条规则会从整个库里捞走多少条"(spec §9C.4)。
   */
  const rulesWithHits = () => {
    const rules = listRules(db);
    const ruleOf = new Map(rules.map((r) => [r.folderId, r]));
    const items = db.prepare(`SELECT * FROM items`).all() as ItemRow[];
    const tagsOf = itemTagIds(db);

    // §9F:不传 ctx 的话 tag 条件一律不命中(缺 subtree 时实现刻意返回"没有标签"),
    // 于是界面上"命中 N 条"恒为 0,而规则看起来是配好的
    const matched = matchAll(
      items.map((i) => ({ ...toRuleItem(i), tagIds: tagsOf.get(i.id) ?? [] })),
      rules,
      { subtree: subtreeSets(db) },
    );

    const hits = new Map<number, number>();
    for (const itemHits of matched.values()) {
      for (const h of itemHits) hits.set(h.folderId, (hits.get(h.folderId) ?? 0) + 1);
    }

    const snapshots = new Map(listFolders(db).map((f) => [f.id, f]));
    const views: RuleView[] = listWorkFolders(db).map((w) => {
      const origin = w.originId === null ? undefined : snapshots.get(w.originId);
      return {
        folderId: w.id,
        folderName: w.name,
        locked: origin !== undefined && isLockedFolder(db, origin),
        conditions: ruleOf.get(w.id)?.conditions ?? [],
        origin: ruleOf.get(w.id)?.origin ?? null,
        updatedAt: ruleOf.get(w.id)?.updatedAt ?? null,
        hit: hits.get(w.id) ?? 0,
      };
    });

    return { views, matchedCount: matched.size, total: items.length };
  };

  /** 找出工作副本里的那个夹子 + 它在快照里的原点(锁定判定要用原点) */
  const folderOr = (folderId: number) => {
    const work = listWorkFolders(db).find((w) => w.id === folderId);
    if (!work) return null;
    const origin = work.originId === null
      ? undefined
      : listFolders(db).find((f) => f.id === work.originId);
    return { work, origin };
  };

  /** 一条条件的形状校验 —— 写进来的东西是要拿去执行的,不能是垃圾 */
  const badCondition = (c: unknown): string | null => {
    if (!c || typeof c !== 'object') return '条件必须是对象';
    const o = c as { field?: unknown; any?: unknown };
    if (o.field !== 'title' && o.field !== 'intro' && o.field !== 'upper' && o.field !== 'tag') {
      return 'field 只能是 title / intro / upper / tag';
    }
    if (!Array.isArray(o.any) || o.any.some((k) => typeof k !== 'string')) {
      return 'any 必须是字符串数组';
    }
    return null;
  };

  app.get('/api/rules', async () => {
    const { views } = rulesWithHits();
    return { rules: views };
  });

  app.put('/api/rules/:folderId', async (req, reply) => {
    const folderId = Number((req.params as { folderId: string }).folderId);
    const { conditions } = (req.body ?? {}) as { conditions?: unknown };

    const found = folderOr(folderId);
    if (!found) {
      return reply.code(404).send({ ok: false, reason: `工作副本里没有夹子 ${folderId}` });
    }
    if (!Array.isArray(conditions)) {
      return reply.code(400).send({ ok: false, reason: 'conditions 必须是数组' });
    }
    for (const c of conditions) {
      const bad = badCondition(c);
      if (bad) return reply.code(400).send({ ok: false, reason: bad });
    }
    if (found.origin && isLockedFolder(db, found.origin)) {
      return reply.code(400).send({
        ok: false,
        reason: `「${found.origin.title}」是 B站 自带的默认收藏夹,不能加规则`,
      });
    }

    saveRule(db, folderId, conditions as RuleCondition[], 'user');
    return { ok: true };
  });

  app.delete('/api/rules/:folderId', async (req, reply) => {
    const folderId = Number((req.params as { folderId: string }).folderId);
    if (!folderOr(folderId)) {
      return reply.code(404).send({ ok: false, reason: `工作副本里没有夹子 ${folderId}` });
    }
    // 只删规则 —— 夹子和里面的条目一行不动(界面上的文案也是这么说的)
    deleteRule(db, folderId);
    return { ok: true };
  });

  /**
   * 采纳一条 AI 建议 = **追加**一个条件,不是覆盖。
   *
   * 覆盖会把夹子原有的规则整条抹掉 —— 而"再给这个夹子加一条"正是建议的语义。
   *
   * 这里**再验一次**自证(spec §9C.6 约束 2):过不了验证的建议不入库,
   * 连"待采纳"都不给。客户端传回来的东西不可信,验一遍的成本可以忽略。
   */
  app.post('/api/rules/:folderId/adopt', async (req, reply) => {
    const folderId = Number((req.params as { folderId: string }).folderId);
    const found = folderOr(folderId);
    if (!found) {
      return reply.code(404).send({ ok: false, reason: `工作副本里没有夹子 ${folderId}` });
    }
    if (found.origin && isLockedFolder(db, found.origin)) {
      return reply.code(400).send({
        ok: false,
        reason: `「${found.origin.title}」是 B站 自带的默认收藏夹,不能加规则`,
      });
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    const items = db.prepare(`SELECT * FROM items`).all() as ItemRow[];
    const valid = validateSuggestion(
      { ...body, folderTempId: folderId },
      {
        validFolderIds: new Set([folderId]),
        // 这里**故意**不带 tagIds:自证的探针字段只能是 VALID_FIELDS 里那三个文本字段
        // —— tag 建议根本进不来(见 VALID_FIELDS 那条注释),带了也没人读
        itemsById: new Map(items.map((i) => [i.id, toRuleItem(i)])),
      },
    );
    if (!valid) {
      return reply.code(400).send({ ok: false, reason: '这条建议过不了自证,不采纳' });
    }

    const existing = getRule(db, folderId)?.conditions ?? [];
    saveRule(db, folderId, [...existing, { field: valid.field, any: valid.any }], 'ai');
    return { ok: true };
  });

  /**
   * 面板上「让 AI 看看规则」——建议的**第二个来源**(spec §9C.5 c)。
   *
   * **不落库**:建议是个可重生的中间态,采纳即变成规则、忽略即消失。
   * 为它加一张表不值得。
   */
  app.post('/api/rules/suggest', async (req, reply) => {
    const llm = readLlmSettings(db, 'rules');
    if (!llm) {
      // 和 curator/routes.ts 的 requireLlm 同一句话 —— 用户看到的是同一个原因
      return reply.code(400).send({
        ok: false, reason: '还没配模型 —— 先去「授权」页的模型管理里选一个',
      });
    }

    const { folders, pool, allItems } = suggestionInput(db);
    try {
      const suggestions = await runSuggestions({
        config: llm.config,
        folders,
        pool,
        // 这条路没有"哪些是 AI 说拿不准的"这个信息(没跑归类)—— 不传 homelessIds,
        // 也就没有那道省钱闸。用户是**主动**点的这个按钮,他想看就看。
        cap: batchSize(llm.ctx),
        allItems,
      });
      return { suggestions };
    } catch (e) {
      const message = (e as Error)?.message ?? String(e);
      deps.log.event({ level: 'error', category: 'llm', code: 'SUGGEST_FAILED', message });
      return reply.code(502).send({ ok: false, reason: message });
    }
  });

  /** 试跑:规则能覆盖多少条、剩下多少要给 AI、按当前模型算几批 */
  app.post('/api/rules/dry-run', async () => {
    const { matchedCount, total } = rulesWithHits();
    const llm = readLlmSettings(db, 'rules');
    const remaining = total - matchedCount;

    return {
      covered: matchedCount,
      remaining,
      // 没配模型就不报批数(null)—— 别编一个(spec §9C.4:批数用 §3 的 batchSize 现算)
      batches: llm && remaining > 0 ? Math.ceil(remaining / batchSize(llm.ctx)) : null,
    };
  });
}
