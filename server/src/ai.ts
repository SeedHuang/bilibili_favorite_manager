// server/src/ai.ts —— BFM 的 AI 套件实例
//
// 三层模型配置(凭证 / 条目 / 用途分配)与对模型的**唯一出口**都来自
// `@seedhuang/ai_suit_tool`;这里只做两件 BFM 特有的事:注入 BFM 的存储与 DPAPI,
// 声明本项目用的用途清单。日志不在这条路上 —— 它归 fastify 适配器的 logger
// (见 http/index.ts 的 registerAiSettings)。
import { createAiCore, type AiLogger } from '@seedhuang/ai_suit_tool/core';
import type Database from 'better-sqlite3';
import { getSetting, setSetting, deleteSetting } from './db/repo/state.js';
import { encryptSecret, decryptSecret } from './security/dpapi.js';
import type { Logger } from './logger/index.js';

export const AI_PURPOSES = [
  { key: 'proposals', label: '夹子方案生成' },
  { key: 'tag', label: '打标' },
  // 质检只对新词开口,判的是"这个词在树里该站哪" —— 量小但要准,和打标的要求相反
  { key: 'tagcheck', label: '标签质检' },
];

const storageOf = (db: Database.Database) => ({
  get: (k: string) => getSetting(db, k),
  set: (k: string, v: string) => setSetting(db, k, v),
  delete: (k: string) => deleteSetting(db, k),
});

/**
 * BFM 的 Logger → 包内的 AiLogger。
 *
 * `category` 在这里收窄成 `'llm'`:包收自由 string(它不认识 BFM 的分类),
 * 而 BFM 的 LogEvent.category 是固定几类的联合 —— 不转这一层两边对不上。
 */
export const aiLoggerOf = (log: Logger): AiLogger => ({
  event: (e) => log.event({ level: e.level, category: 'llm', code: e.code, message: e.message }),
});

export function makeAi(db: Database.Database) {
  return createAiCore({
    purposes: AI_PURPOSES,
    storage: storageOf(db),
    secrets: { encrypt: encryptSecret, decrypt: decryptSecret },
  });
}

export type AiCore = ReturnType<typeof makeAi>;

// ── 测试铺底(生产代码不 import)─────────────────────

/** 一条命令铺好 1 凭证 + 1 条目 + 全部用途指它(原 BFM 自有 LLM 配置模块的 seedLlm,已迁入包) */
export function seedAi(
  db: Database.Database,
  opts: { provider?: string; model?: string; baseUrl?: string; apiKey?: string } = {},
): void {
  const ai = makeAi(db);
  const p = ai.saveProvider({
    provider: opts.provider ?? 'ollama',
    baseUrl: opts.baseUrl ?? '',
    apiKey: opts.apiKey ?? '',
  });
  const e = ai.addEntry({ providerId: p.id, model: opts.model ?? 'qwen2.5:14b' });
  for (const purpose of AI_PURPOSES) ai.setAssignment(purpose.key, e.id);
}
