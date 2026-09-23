import type {
  Item,
  OperationEntry,
  ProposalDraftView,
  ProposalInfo,
  ProposalLogLine,
  ReviewCurrent,
  PollConfig,
  PollsMap,
  RuleCondition,
  RuleView,
  TagRunProgress,
  TagRunStatus,
  TagTreeView,
  ReconcileStats,
  TagCheckProgress,
  TreeChange,
  WorkbenchView,
} from './types';

/**
 * useRequest 的 formatResult 恒等函数。
 *
 * @umijs/max 的 useRequest 默认 `formatResult: result => result?.data`,而后端把载荷
 * 放在响应顶层(`{folders}` / `{items,total}` / `{ok,mid,uname}`),默认实现下 data 永远是
 * undefined、列表全空 —— 用这个覆盖掉默认值。
 */
export function rawResult<T>(r: T): T {
  return r;
}

/**
 * 薄封装:所有 /api 请求。CSRF 对本机工具无意义,不处理。
 *
 * **直连后端 3001,不走 umi 代理** —— umi dev server 的 proxy 会缓冲 SSE、
 * 会整体挂掉(用户反复撞的"接口 pending"根因)。本机工具没有异地部署,
 * 硬编码本机地址即可。后端在 http/index.ts 加了 CORS 放行。
 */
export const API_BASE = 'http://127.0.0.1:3001';

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    // 带上 status —— 调用方要分辨「409 需要确认」和别的失败,光有文案不够
    const err = new Error((body as { reason?: string }).reason ?? `请求失败 ${res.status}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  return res.json() as Promise<T>;
}

/**
 * 带 JSON body 的 POST/PUT/PATCH/DELETE —— 手写 headers 容易漏 content-type。
 *
 * **没有 body 时不能带 `content-type: application/json`** —— 那样 Fastify 会抛
 * `FST_ERR_CTP_EMPTY_JSON_BODY`,在进 handler 之前就 400,响应体里**没有 `reason`**,
 * 界面上只显示一句"请求失败 400",后端连日志都来不及记(实测踩过)。
 *
 * 无 body 的调用有 14 个:删夹子 / 一键还原 / 规则删除 / 删厂商 / 删模型项 /
 * 中止方案生成 / 方案全部采纳 / 方案全部丢弃 / 中止审查 / 审查全部采纳 /
 * 删标签 / 中止标注 / 清空标注 / 启动标注 —— 全被这一处影响,所以修在这里而不是每个调用点。
 */
export function json<T>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  return api<T>(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
}

/**
 * 手动锁 / 解锁收藏夹。传 null 清掉覆盖、回到自动判定。
 * 自动判定靠「标题是默认收藏夹」或 `attr === 0`,只有一个账号的样本,所以要能手动改。
 */
export const setFolderLock = (id: number, locked: boolean | null) =>
  json<{ ok: true; locked: boolean }>('PUT', `/api/folders/${id}/lock`, { locked });

// ── M4b:整理工作台 ──────────────────────────────────────

export const workbenchApi = {
  get: () => api<WorkbenchView>('/api/workbench'),

  reset: () => json<{ ok: true }>('POST', '/api/workbench/reset'),

  createFolder: (name: string) =>
    json<{ ok: true; id: number }>('POST', '/api/workbench/folders', { name }).then((r) => r.id),

  renameFolder: (id: number, name: string) =>
    json<{ ok: true }>('PATCH', `/api/workbench/folders/${id}`, { name }),

  deleteFolder: (id: number) => json<{ ok: true }>('DELETE', `/api/workbench/folders/${id}`),

  /**
   * 把 fromIds 的条目全搬进 intoId,再把搬空了的源夹子删掉。
   * 源里有锁定的(默认收藏夹)会被后端拒 —— 界面上那种夹子根本勾不上。
   */
  mergeInto: (intoId: number, fromIds: number[]) =>
    json<{ ok: true; moved: number }>('POST', `/api/workbench/folders/${intoId}/merge`, {
      fromIds,
    }),

  /**
   * 移动:离开原处。源可以是**勾的具体条目**,也可以是**整个夹子**
   * (`fromFolderIds` —— 服务端一次展开成条目,一次请求一条日志)。
   */
  move: (src: { itemIds: string[] } | { fromFolderIds: number[] }, toFolderId: number) =>
    json<{ ok: true; moved: number }>('POST', '/api/workbench/items/move', {
      ...src,
      toFolderId,
    }),

  /** 也放进:保留原处。源的两种给法同 move */
  add: (src: { itemIds: string[] } | { fromFolderIds: number[] }, toFolderId: number) =>
    json<{ ok: true; moved: number }>('POST', '/api/workbench/items/add', {
      ...src,
      toFolderId,
    }),

  remove: (itemIds: string[], fromFolderId: number) =>
    json<{ ok: true }>('POST', '/api/workbench/items/remove', { itemIds, fromFolderId }),

  /**
   * 展开某个夹子时的条目 —— **工作副本口径**。
   *
   * 不能拿 `/api/folders/:id/items`(快照口径)顶替:新建的夹子没有快照原点,
   * 而它里面完全可能有条目;行头显示的 itemCount 也是这个口径,两者必须一致。
   */
  items: (folderId: number, pageSize = 500) =>
    api<{ items: Item[]; total: number }>(
      `/api/workbench/folders/${folderId}/items?pageSize=${pageSize}`,
    ),

  log: (limit = 200) =>
    api<{ operations: OperationEntry[] }>(`/api/workbench/log?limit=${limit}`).then(
      (r) => r.operations,
    ),

  /** 对勾选的夹子兑现成员关系。纯本地计算,不调 LLM(不花钱) */
  tidy: (folderIds: number[]) =>
    json<{
      ok: true;
      reconciled: { folderId: number; added: number; removed: number }[];
      ruleAdded: { folderId: number; added: number }[];
      skipped: string[];
    }>('POST', '/api/workbench/tidy', { folderIds }),
};

// ── M4c:规则 ────────────────────────────────────────────

export const rulesApi = {
  list: () => api<{ rules: RuleView[] }>('/api/rules').then((r) => r.rules),

  /** 整组条件覆盖(你手写的路 —— origin 记 'user') */
  save: (folderId: number, conditions: RuleCondition[]) =>
    json<{ ok: true }>('PUT', `/api/rules/${folderId}`, { conditions }),

  remove: (folderId: number) => json<{ ok: true }>('DELETE', `/api/rules/${folderId}`),
};

// ── 批次任务三件套设置 ──────────────────────────────────

export const settingsApi = {
  getPolls: () => api<{ polls: PollsMap }>('/api/settings/polls').then((r) => r.polls),
  setPoll: (taskType: string, cfg: PollConfig) =>
    json<{ ok: true }>('PUT', `/api/settings/polls/${taskType}`, cfg),
};

// ── 夹子方案生成 ─────────────────────────────────────────

export const proposalsApi = {
  generate: (level: number) => json<{ ok: true }>('POST', '/api/proposals/generate', { level }),
  /** 未在跑时后端回 409(reason「没有正在进行的生成」)—— 调用方按 actProposal 既有错误处理显示 */
  abort: () => json<{ ok: true }>('POST', '/api/proposals/abort'),
  // logs 在外层、与 proposal/drafts 同级(Task 1 后端形状);内存态,status 变了 logs 也没了
  current: () =>
    api<{ proposal: ProposalInfo | null; drafts: ProposalDraftView[]; logs: ProposalLogLine[] }>(
      '/api/proposals/current',
    ),
  adopt: (draftId: number, name?: string) =>
    json<{ ok: true; folderId: number }>('POST', '/api/proposals/adopt', { draftId, name }),
  adoptAll: () => json<{ ok: true; results: { draftId: number; folderId: number }[] }>('POST', '/api/proposals/adopt-all'),
  discard: (draftId: number) => json<{ ok: true }>('POST', '/api/proposals/discard', { draftId }),
  /** 全部丢弃:所有 pending 草稿置 discarded(与「全部采纳」并列) */
  discardAll: () => json<{ ok: true }>('POST', '/api/proposals/discard-all'),
};

// ── 审查草稿(spec 2026-09-21 §5/§6)─────────────────────

export const reviewsApi = {
  generate: (folderIds: number[]) =>
    json<{ ok: true }>('POST', '/api/reviews/generate', { folderIds }),
  abort: () => json<{ ok: true }>('POST', '/api/reviews/abort'),
  current: () => api<ReviewCurrent>('/api/reviews/current'),
  adopt: (draftId: number, name?: string) =>
    json<{ ok: true }>('POST', '/api/reviews/adopt', { draftId, name }),
  discard: (draftId: number) => json<{ ok: true }>('POST', '/api/reviews/discard', { draftId }),
  adoptAll: () => json<{ ok: true }>('POST', '/api/reviews/adopt-all'),
};

// ── M4e:条目 AI 标注 ────────────────────────────────────

export const tagApi = {
  status: () => api<TagRunStatus>('/api/tags/status'),

  /** 词库树 —— 规则里选标签(§9F C11)和「标签」页都用它 */
  tree: () => api<TagTreeView>('/api/tags/tree'),

  /** 词库健康度 —— 活跃词数是整理成本的决定量(M4h) */
  reconcileStats: () => api<ReconcileStats>('/api/tags/reconcile-stats'),

  changes: () => api<{ changes: TreeChange[] }>('/api/tags/changes'),

  /**
   * 按标签捞条目(§9F C12「浏览」页)。**子树口径** —— 选「体育」连 篮球 一起出。
   *
   * `foldersOf` / `tagsOf` 是**同级字段**:夹子归属和标签都不在 item 里,
   * 因为 shapeItem 只走一个出口(见服务端那条注释)。
   */
  items: (id: number, page = 1, pageSize = 60) =>
    api<{ items: Item[]; total: number; foldersOf: Record<string, { id: number; title: string }[]>; tagsOf: Record<string, string[]> }>(
      `/api/tags/${id}/items?page=${page}&pageSize=${pageSize}`,
    ),

  merge: (fromId: number, toId: number) => json<{ ok: true }>('POST', '/api/tags/merge', { fromId, toId }),

  update: (id: number, patch: { name?: string; parentId?: number | null }) =>
    json<{ ok: true }>('PATCH', `/api/tags/${id}`, patch),

  remove: (id: number) => json<{ ok: true }>('DELETE', `/api/tags/${id}`),

  /**
   * 启动一轮标注。**启动即返回** —— 后端后台跑,前端靠 `getRunProgress` 轮询。
   *
   * `scope` 传给后端当增量口径:`missing` = 只标还没标注的,`all` = 全部重标。
   * 走 `json()` 而不是裸 fetch:后端的 409(已有一轮在跑)会带 `status`,调用方才能分辨
   */
  startRun: (scope: 'missing' | 'all') =>
    json<{ ok: true; poolSize: number }>('POST', `/api/tags/run?scope=${scope}`),

  /** 拉当前这一轮标注的实时状态 —— 前端轮询就靠它 */
  getRunProgress: () => api<TagRunProgress>('/api/tags/run-progress'),

  /** 中止正在跑的那一轮。幂等 —— 没在跑也返回 ok */
  abortRun: () => json<{ ok: true }>('POST', '/api/tags/run-abort'),

  /** 清空标注(M4h 后测试辅助)—— 连词库树一起清,高危,前端要二次确认 */
  clearTags: () => json<{ ok: true }>('POST', '/api/tags/clear-tags'),

  /** 手动质检 —— scope: continue 只检未质检的(默认)/ all 强制全库重检。启动即返回,靠 getCheckProgress 轮询 */
  tagcheck: (scope: 'continue' | 'all') =>
    json<{ ok: true }>('POST', '/api/tags/tagcheck', { scope }),

  /** 拉手动质检的实时状态 —— 前端轮询就靠它(和 getRunProgress 同一套) */
  getCheckProgress: () => api<TagCheckProgress>('/api/tags/check-progress'),
};
