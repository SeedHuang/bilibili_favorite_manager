// server/src/curator/proposal.ts
import type Database from 'better-sqlite3';
import type { Logger } from '../logger/index.js';
import type { RuleCondition } from '../db/repo/rules.js';
import type { ItemRow } from '../db/repo/items.js';
import { complete } from '../llm/provider.js';
import { readLlmSettings } from '../llm/config.js';
import { parseLooseJson } from './parse.js';
import {
  startProposal, saveDrafts, gatherInputs,
} from '../db/repo/proposals.js';
import { tagNamesById, subtreeSets, itemTagIds, normalizeTagName } from '../db/repo/tags.js';
import { matchAll, toRuleItem } from './rules.js';

/**
 * 夹子方案生成 —— prompt 组装 + AI 输出裁判(纯函数,无 IO)。
 *
 * 裁判纪律:**编造就整条丢**,不给部分正确留宽容。
 * 阶梯进 prompt **不带任何具体例子** —— 具体词(Claude Code 之类)会锚定模型
 * 往科技领域聚,例子只留在 spec 的人看表格里。
 */

export interface LevelDef { level: number; name: string; criterion: string }

/** 1 严 → 10 松。靠这条递进链理解松紧,不靠例子 */
export const LEVELS: LevelDef[] = [
  { level: 1, name: '专精', criterion: '围绕同一具体事物的同一具体用法/技巧' },
  { level: 2, name: '工具', criterion: '同一个具体事物/工具,不细分内部功能' },
  { level: 3, name: '方案', criterion: '解决同一问题的同类工具或方案' },
  { level: 4, name: '方向', criterion: '同一技术路线/方法论' },
  { level: 5, name: '领域', criterion: '同一领域,跨过方案之间的分歧' },
  { level: 6, name: '邻域', criterion: '领域 + 紧邻领域可合并' },
  { level: 7, name: '大类', criterion: '同一大类,领域之上' },
  { level: 8, name: '行业', criterion: '同一行业' },
  { level: 9, name: '生活', criterion: '生活大领域(如学习、娱乐、日常)' },
  { level: 10, name: '全收', criterion: '全库归成几大主题' },
];

export const levelText = (level: number) => LEVELS.find((l) => l.level === level) ?? null;

export interface PromptInputs {
  treeText: string; coText: string; expected: string; level: number;
}

export function buildPrompt(inputs: PromptInputs): { system: string; user: string } {
  const lv = levelText(inputs.level);
  if (!lv) throw new Error(`档位必须是 1~10,收到 ${inputs.level}`);

  // 相邻档位的**判据**必须给 —— 只给名字(`L4=方向`)模型没法校准"领域 vs 邻域 vs 大类"
  // 这种相邻档的差别,而那正是本档定义最容易跑偏的地方。本档已在上面单列,这里不重复。
  const others = LEVELS.filter((l) => l.level !== inputs.level)
    .map((l) => `  L${l.level} ${l.name}:${l.criterion}`)
    .join('\n');

  const system = [
    '你是视频收藏夹整理助手。任务是:把词库里的概念按指定的「相关性档位」聚成一套夹子方案。',
    '档位从 1(最严,夹子多而细)到 10(最松,夹子少而大),本次要求:',
    `  L${lv.level} ${lv.name}:${lv.criterion}`,
    '完整阶梯供参照(本档已列在上方,下面是其余各档的判据):',
    others,
    '成员之间"共享什么才算同类"以本档定义为准。',
    '共现数字(两词同现于同一视频的统计)只能当**线索**,不是指令 —— 万金油词(如"教程")共现虚高,别被它牵着走。',
    '输出纯 JSON 数组,不要 markdown 围栏,形状:',
    // tagIds 里填**词名**(照抄词库树里的写法)—— 树里没有 id,让模型编 id 只会全被判假
    '[{"name":"夹子名","reason":"归类理由一句话","tagIds":["词库树里的词名"],"keywords":["标题关键词"]}]',
  ].join('\n');

  const user = [
    `## 词库树(每词带挂条目数)`,
    inputs.treeText,
    ``,
    `## 词间共现(Jaccard ≥ 0.3)`,
    inputs.coText,
    ``,
    `## 数量护栏`,
    `本档预计 ${inputs.expected} 夹子。超出区间说明你在细拆或硬塞。`,
    ``,
    `请给出夹子方案。每个夹子必须挂至少一个词库 id 或至少一个标题关键词。`,
  ].join('\n');

  return { system, user };
}

// ── 裁判 ──────────────────────────────────────────────────

export interface ValidFolder {
  name: string; reason: string; tagIds: number[]; keywords: string[];
}

export interface FolderCtx {
  validTagIds: ReadonlySet<number>;
  /**
   * normalize 后的词名 → id。**prompt 里的词库树只有名字、没有 id**,模型只能回名字 ——
   * 裁判认名字才收得住(不然"编造 id"会把每条草稿都丢掉)。
   */
  tagIdByName: ReadonlyMap<string, number>;
  /** 已有工作夹子的名字 + 本方案先到的名字 —— 防重 */
  knownNames: ReadonlySet<string>;
}

const MAX_KEYWORDS = 20;
/** B 站收藏夹名的硬限制(20 字)—— 超了同步上传时会被 B 站拒,所以在生成侧就压住 */
export const MAX_FOLDER_NAME = 20;

/** 裁判结果 + 丢/跳的原因(只给日志用,不参与判定) */
export interface FolderVerdict {
  folders: ValidFolder[];
  /** 整条被丢的候选与原因 */
  rejects: { name: string; why: string }[];
  /** 命不中词库、被跳过的词名个数(不再因此整条丢,见下) */
  skippedTags: number;
}

/**
 * 全过才留;**坏字段丢字段,不丢整条**。
 *
 * 曾经是"一个编造 = 整条不可信"—— 那是**数字 id** 时代的纪律(模型编 id 说明整条不可信)。
 * 改成词名之后这条规则变成灾难:一次大档位生成里每个夹子几十上百个词名,
 * **只要一个名字查不到(拼写偏差、模型加了个"合集"后缀),整个夹子就没了** ——
 * 实测 L6 一跑 27 条全灭,而它们其实都可用。所以改为:查不到的名字跳过并计数,
 * 夹子只要还剩一个可用词或关键词就留下。质量仍由下游把关(命中 0 丢 / 偏弱对账)。
 */
export function validateFolders(raw: unknown, ctx: FolderCtx): FolderVerdict {
  if (!Array.isArray(raw)) return { folders: [], rejects: [{ name: '(整份)', why: '不是数组' }], skippedTags: 0 };
  const seen = new Set<string>();
  const out: ValidFolder[] = [];
  const rejects: { name: string; why: string }[] = [];
  let skippedTags = 0;
  for (const r of raw) {
    if (!r || typeof r !== 'object') { rejects.push({ name: '(非对象)', why: '形状不对' }); continue; }
    const o = r as Record<string, unknown>;
    if (typeof o.name !== 'string' || !o.name.trim()) { rejects.push({ name: '(无名)', why: 'name 缺失' }); continue; }
    const name = o.name.trim().slice(0, MAX_FOLDER_NAME); // 超 20 字截断(B 站限制),不因此丢夹子
    if (ctx.knownNames.has(name) || seen.has(name)) { rejects.push({ name, why: '重名' }); continue; }
    seen.add(name);

    const reason = typeof o.reason === 'string' ? o.reason : '';

    if (!Array.isArray(o.tagIds)) { rejects.push({ name, why: 'tagIds 不是数组' }); continue; }
    const tagIds: number[] = [];
    for (const t of o.tagIds) {
      const n = typeof t === 'number' ? t : Number(t);
      // 两种写法都收:数字 id(旧输出/测试)与**词名**(prompt 只给名字,模型只能回名字)
      const resolved = Number.isInteger(n) && ctx.validTagIds.has(n)
        ? n
        : ctx.tagIdByName.get(normalizeTagName(String(t)));
      if (resolved === undefined) { skippedTags++; continue; } // 查不到就跳过,不牵连整条
      if (!tagIds.includes(resolved)) tagIds.push(resolved);
    }

    if (!Array.isArray(o.keywords)) { rejects.push({ name, why: 'keywords 不是数组' }); continue; }
    const keywords = [...new Set(
      o.keywords.filter((k): k is string => typeof k === 'string').map((k) => k.trim()).filter(Boolean),
    )].slice(0, MAX_KEYWORDS);

    if (tagIds.length === 0 && keywords.length === 0) { rejects.push({ name, why: '词与关键词全查不到' }); continue; }
    out.push({ name, reason, tagIds, keywords });
  }
  return { folders: out, rejects, skippedTags };
}

// ── 生成主流程 ────────────────────────────────────────────

export const GENERATE_TIMEOUT_MS = 300_000;

/**
 * 模块级运行态(照 tagRoutes currentRun 模式):logs 绑当前 run,重启清空。
 * status 落库,logs 不落库(刷新丢,spec 规则 7)—— 进度轮询从 current 接口一拉就有。
 */
export const proposalRun = {
  running: false,
  logs: [] as { ts: number; level: 'info' | 'warn' | 'error'; text: string }[],
};
const pushLog = (level: 'info' | 'warn' | 'error', text: string) => {
  proposalRun.logs.push({ ts: Date.now(), level, text });
};

/**
 * 一轮生成。**先落 generating 再干活**(刷新/断线状态不丢),错误回 idle。
 * 裁判顺序:validateFolders(结构)→ matchAll 实跑(命中 0 丢)→ 偏弱对账。
 * 关键节点同时写 pushLog(内存,给进度抽屉)和 log.event(落库,给 TagLogDrawer)——
 * 两者并行不替代:内存的会丢,落库的看不见进行中。
 */
export async function runGeneration(
  db: Database.Database, log: Logger, level: number,
  opts: { signal?: AbortSignal } = {},
): Promise<void> {
  const t0 = Date.now();
  proposalRun.running = true;
  proposalRun.logs = [];
  pushLog('info', `开始生成方案(档位 L${level})`);
  console.log(`[proposals] run 开始 档位 L${level}`);
  // try 从 readLlmSettings 就包住:running 置位后任何一步抛错都得走 finally 复位,
  // 不然卡"生成中"是死状态(下面 catch 的注释同因)
  try {
    const llm = readLlmSettings(db, 'proposals');
    if (!llm) { // 路由已拦,这里兜底(异步路径里没人接 400)
      log.event({ level: 'error', category: 'llm', code: 'PROPOSAL_NO_LLM', message: '生成方案时模型配置消失' });
      pushLog('error', '生成方案时模型配置消失');
      console.log('[proposals] 模型配置消失,回 idle');
      return;
    }
    startProposal(db, level);
    const inputs = gatherInputs(db, level);
    pushLog('info', `备料完成:${inputs.tagCount} 词,${inputs.pairCount} 共现对`);
    console.log(`[proposals] 备料完成 词=${inputs.tagCount} 共现对=${inputs.pairCount}`
      + ` 未挂词=${inputs.uncoveredCount} —— 开始调模型(${llm.config.model})`);
    const prompt = buildPrompt({ ...inputs, level });
    const raw = await complete({
      config: llm.config,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
      ],
      thinking: false,
      timeoutMs: GENERATE_TIMEOUT_MS,
      // 一次要吐整套方案(几十个夹子 × 每个一堆词名),不给上限就会被厂商默认的
      // 8192 截断成断尾 JSON —— 实测复现过(finish=length,16892 字符断在中间)
      maxOutputTokens: llm.ctx.maxOutput,
      // 中止透传:provider 的 complete 已支持(tagRoutes 同款条件展开),
      // 没有信号时整个键不出现,请求形状与加开关前逐字一致
      ...(opts.signal ? { abortSignal: opts.signal } : {}),
    });
    console.log(`[proposals] 模型返回 耗时=${Date.now() - t0}ms 原始长度=${raw.length}`);

    // 结构裁判:knownNames = 现有工作夹子名 + 词表里同名也当重名(防 AI 起名和词重)
    const nameOf = tagNamesById(db);
    const workNames = new Set(
      (db.prepare(`SELECT name FROM work_folders`).all() as { name: string }[]).map((r) => r.name),
    );
    for (const n of nameOf.values()) workNames.add(n);
    const validTagIds = new Set([...nameOf.keys()]);
    // **名字 → id**:prompt 里的词库树只有名字(没给 id),所以模型只能回名字 ——
    // 裁判必须认名字,不然每条草稿都因"编造 id"被丢(实测:方案生成从来没成功过)。
    // 键用 normalize 后的名字,容忍全半角/标点/空格差异。
    const tagIdByName = new Map<string, number>();
    for (const [id, name] of nameOf) {
      const key = normalizeTagName(name);
      if (key && !tagIdByName.has(key)) tagIdByName.set(key, id);
    }
    const verdict = validateFolders(parseLooseJson(raw), { validTagIds, tagIdByName, knownNames: workNames });

    // 实跑命中 + 偏弱对账
    const items = db.prepare(`SELECT * FROM items`).all() as ItemRow[];
    const tagsOf = itemTagIds(db);
    const subtree = subtreeSets(db);
    const uncoveredCount = inputs.uncoveredCount;

    const drafts: DraftShape[] = [];
    for (const f of verdict.folders) {
      const conditions: RuleCondition[] = [];
      if (f.tagIds.length) conditions.push({ field: 'tag', any: f.tagIds.map(String) });
      if (f.keywords.length) conditions.push({ field: 'title', any: f.keywords });
      const probe = [{ folderId: 0, conditions, origin: 'ai' as const, updatedAt: 0 }];
      const matched = matchAll(
        items.map((i) => ({ ...toRuleItem(i), tagIds: tagsOf.get(i.id) ?? [] })),
        probe, { subtree },
      );
      if (matched.size === 0) {
        const message = `「${f.name}」命中 0 条,丢弃`;
        log.event({ level: 'info', category: 'llm', code: 'PROPOSAL_DRAFT_DROPPED', message });
        pushLog('info', message);
        continue;
      }
      // 数据裁判:声称收编的词压着 N 条,关键词规则却捞不到 → 偏弱
      // 口径:tagIds 的直接挂载数(不含子树)与命中数差 5 倍以上 → weak
      const claimed = f.tagIds.reduce((s, id) => s + (tagCount(db, id) ?? 0), 0);
      const weak = claimed >= 10 && matched.size < claimed / 5;
      drafts.push({ name: f.name, reason: f.reason, conditions, hitCount: matched.size, weak });
    }

    if (drafts.length === 0) {
      // 一条草稿都没活下来 = 解析/结构/命中三关全灭,这时**原始返回是唯一证据** ——
      // 只打长度的话,你看到的就是"失败了"三个字,而不知道为什么(用户报过:
      // deepseek 的返回值一直看不见)。1500 字符够看清是空、是断尾 JSON、还是散文。
      console.log(`[proposals] 草稿全灭 —— 结构关留 ${verdict.folders.length} / 丢 ${verdict.rejects.length}`
        + (verdict.rejects.length ? `(${verdict.rejects.slice(0, 5).map((r) => `${r.name}:${r.why}`).join(' / ')})` : '')
        + ` 跳过的词名=${verdict.skippedTags};原始返回前 1500 字符:\n` + raw.slice(0, 1500));
      throw new Error('AI 的方案没一个草稿活下来 —— 换个档位或模型再试');
    }
    console.log(`[proposals] 裁判后存活草稿=${drafts.length}`
      + `(结构关丢 ${verdict.rejects.length}、跳过词名 ${verdict.skippedTags}、命中关丢 ${verdict.folders.length - drafts.length})`);
    saveDrafts(db, level, uncoveredCount, drafts);
    const readyMessage = `方案就绪:${drafts.length} 个草稿夹子`;
    log.event({ level: 'info', category: 'llm', code: 'PROPOSAL_READY', message: readyMessage });
    pushLog('info', readyMessage);
    console.log(`[proposals] run 结束 ready 总耗时=${Date.now() - t0}ms`);
  } catch (e) {
    // 中止不是故障:记 warn 并明说草稿不保留(草稿在 startProposal 已清,重申一遍防误解)
    if (opts.signal?.aborted) {
      const abortedMessage = '已中止 —— 已生成的草稿不保留';
      pushLog('warn', abortedMessage);
      log.event({ level: 'warn', category: 'llm', code: 'PROPOSAL_ABORTED', message: abortedMessage });
      console.log(`[proposals] run 被中止 耗时=${Date.now() - t0}ms`);
    } else {
      const message = (e as Error)?.message ?? String(e);
      log.event({ level: 'error', category: 'llm', code: 'PROPOSAL_FAILED', message });
      pushLog('error', message);
      console.log(`[proposals] run 失败 耗时=${Date.now() - t0}ms 错误=${message}`);
    }
    // 回 idle 而不是留 generating —— 卡在"生成中"是死状态
    db.prepare(`UPDATE folder_proposals SET status = 'idle' WHERE id = 1`).run();
  } finally {
    proposalRun.running = false;
  }
}

/** saveDrafts 吃的形状 —— 就地别名一下,不为此 import DraftInput */
interface DraftShape {
  name: string; reason: string; conditions: RuleCondition[]; hitCount: number; weak: boolean;
}

/** 单个 tag 的挂载数(不加子树) */
const tagCount = (db: Database.Database, id: number): number | null => {
  const r = db.prepare(`SELECT COUNT(*) AS n FROM item_tags WHERE tag_id = ?`).get(id) as { n: number };
  return r.n;
};
