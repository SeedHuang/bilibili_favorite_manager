import type { FolderProfile } from './folderProfile.js';
import { matchItem, type RuleItem } from './rules.js';

/**
 * 「审查勾选的夹子」的 prompt + 裁判(纯函数,无 IO)。
 *
 * 一次调用服务 N 个勾选的夹子:人类夹子按共现画像推荐规则;AI 夹子可提
 * 规则 / 合并 / 删除。裁判纪律:**编造就整条丢** ——
 * 规则草稿必须自证(它给的证据条目必须真的被这组词命中)。
 */

export interface ReviewPromptInput {
  profiles: readonly FolderProfile[];
  aiIds: ReadonlySet<number>;
}

export function buildReviewPrompt(input: ReviewPromptInput): { system: string; user: string } {
  const system = [
    '你是视频收藏夹整理助手。用户勾选了若干夹子,请你逐个审查并给出草稿建议。',
    '夹子分两种:',
    '- 用户自建的夹子:只能建议**加规则**(按它现有成员的标签构成,给出标题/简介/UP名关键词)',
    '- AI 建的夹子:可以建议加规则、把两个 AI 夹子**合并**、或**删除**已无意义的 AI 夹子',
    '约束:',
    '- 用户自建的和默认收藏夹,永远不能建议合并或删除',
    '- 每条规则建议必须给 evidenceItemIds:它声称这些词管用,就要列出会被命中的条目 id',
    '- 输出纯 JSON 数组,不要 markdown 围栏,形状:',
    '[{"kind":"rule","folderTempId":"7","field":"title","any":["词1","词2"],"because":"理由","evidenceItemIds":["BVxx"]},',
    ' {"kind":"merge","fromTempId":"3","intoTempId":"5","because":"理由"},',
    ' {"kind":"delete","folderTempId":"3","because":"理由"}]',
  ].join('\n');

  const lines = input.profiles.map((p) => {
    const kind = input.aiIds.has(p.folderId) ? 'AI 建' : '用户建';
    const mix = p.topTags.map((t) => `${t.name} ${Math.round((t.count / Math.max(1, p.itemCount)) * 100)}%`).join('、');
    return `- [${kind}] id=${p.folderId} 「${p.name}」(${p.itemCount} 条)—— 构成:${mix || '(没有标签数据)'}`;
  });
  const user = [
    '## 勾选的夹子(带标签构成)',
    ...lines,
    '',
    '请逐个审查并给草稿。没有把握的夹子就跳过,不要硬凑。',
  ].join('\n');
  return { system, user };
}

// ── 裁判 ──────────────────────────────────────────────────

export type ValidReviewDraft =
  | { kind: 'rule'; folderId: number; field: 'title' | 'intro' | 'upper'; any: string[]; because: string; evidenceItemIds: string[] }
  | { kind: 'merge'; fromId: number; intoId: number; because: string }
  | { kind: 'delete'; folderId: number; because: string };

export interface ReviewCtx {
  validFolderIds: ReadonlySet<number>;
  aiIds: ReadonlySet<number>;
  lockedIds: ReadonlySet<number>;
  itemsById: ReadonlyMap<string, RuleItem>;
}

const MAX_KEYWORDS = 20;
const FIELDS = ['title', 'intro', 'upper'] as const;

const asId = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isInteger(n) ? n : null;
};

export function validateReviewDrafts(
  raw: unknown,
  ctx: ReviewCtx,
): { drafts: ValidReviewDraft[]; rejects: { label: string; why: string }[] } {
  const rejects: { label: string; why: string }[] = [];
  if (!Array.isArray(raw)) {
    return { drafts: [], rejects: [{ label: '(整份)', why: '不是数组' }] };
  }
  const drafts: ValidReviewDraft[] = [];

  for (const r of raw) {
    if (!r || typeof r !== 'object') {
      rejects.push({ label: '(非对象)', why: '形状不对' });
      continue;
    }
    const o = r as Record<string, unknown>;
    const kind = o.kind;
    const because = typeof o.because === 'string' ? o.because : '';

    if (kind === 'rule') {
      const folderId = asId(o.folderTempId);
      if (folderId === null || !ctx.validFolderIds.has(folderId) || ctx.lockedIds.has(folderId)) {
        rejects.push({ label: String(o.folderTempId), why: 'rule 目标夹子不存在或锁定' });
        continue;
      }
      if (typeof o.field !== 'string' || !(FIELDS as readonly string[]).includes(o.field)) {
        rejects.push({ label: String(o.folderTempId), why: 'field 非法' });
        continue;
      }
      const rawAny = typeof o.any === 'string' ? [o.any] : o.any;
      const any = Array.isArray(rawAny)
        ? rawAny.filter((k): k is string => typeof k === 'string').map((k) => k.trim()).filter(Boolean).slice(0, MAX_KEYWORDS)
        : [];
      if (any.length === 0) {
        rejects.push({ label: String(o.folderTempId), why: '关键词为空' });
        continue;
      }
      if (!Array.isArray(o.evidenceItemIds) || o.evidenceItemIds.length === 0) {
        rejects.push({ label: String(o.folderTempId), why: '没有证据条目(无法自证)' });
        continue;
      }
      const evidenceItemIds = o.evidenceItemIds.filter((x): x is string => typeof x === 'string');
      // 自证前先复核过滤结果:空数组时上面那道 `length === 0` 的检查看的是**原始**数组
      // (e.g. [1,2] 或 ["", null] 都能过),而 some() 对空数组恒 false —— 不补这一句,
      // 一条"证据全是非字符串"的编造草稿会带着 evidenceItemIds: [] 被放行
      if (evidenceItemIds.length === 0) {
        rejects.push({ label: String(o.folderTempId), why: '证据条目不是字符串(无法自证)' });
        continue;
      }
      // ★ 自证:每个证据条目都必须被这组词命中 —— 打不中就是编的
      const probe = [{ folderId, conditions: [{ field: o.field as 'title' | 'intro' | 'upper', any }], origin: 'ai' as const, updatedAt: 0 }];
      const bad = evidenceItemIds.some((id) => {
        const item = ctx.itemsById.get(id);
        return !item || matchItem(item, probe).length === 0;
      });
      if (bad) {
        rejects.push({ label: String(o.folderTempId), why: '证据打不中(编造)' });
        continue;
      }
      drafts.push({ kind: 'rule', folderId, field: o.field as 'title' | 'intro' | 'upper', any, because, evidenceItemIds });
      continue;
    }

    if (kind === 'merge') {
      const fromId = asId(o.fromTempId);
      const intoId = asId(o.intoTempId);
      const ok =
        fromId !== null && intoId !== null && fromId !== intoId &&
        ctx.validFolderIds.has(fromId) && ctx.validFolderIds.has(intoId) &&
        ctx.aiIds.has(fromId) && ctx.aiIds.has(intoId) &&
        !ctx.lockedIds.has(fromId) && !ctx.lockedIds.has(intoId);
      if (!ok) {
        rejects.push({ label: `${o.fromTempId}→${o.intoTempId}`, why: 'merge 两端必须是存在且非锁定的 AI 夹子' });
        continue;
      }
      drafts.push({ kind: 'merge', fromId, intoId, because });
      continue;
    }

    if (kind === 'delete') {
      const folderId = asId(o.folderTempId);
      const ok =
        folderId !== null && ctx.validFolderIds.has(folderId) &&
        ctx.aiIds.has(folderId) && !ctx.lockedIds.has(folderId);
      if (!ok) {
        rejects.push({ label: String(o.folderTempId), why: 'delete 目标必须是存在且非锁定的 AI 夹子' });
        continue;
      }
      drafts.push({ kind: 'delete', folderId, because });
      continue;
    }

    rejects.push({ label: String(kind), why: 'kind 不认识' });
  }

  return { drafts, rejects };
}
