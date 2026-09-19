import type {
  AssignmentsView,
  AuditReport,
  AuditSummary,
  DryRun,
  EntryView,
  FolderSpec,
  Item,
  LlmPurpose,
  ModelMeta,
  OperationEntry,
  Pass1Response,
  Pass2Response,
  ProgressPayload,
  ProviderView,
  RuleCondition,
  RuleSuggestion,
  RuleView,
  SessionDetail,
  SessionSummary,
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
 * 无 body 的调用有八个:删夹子 / 一键还原 / 归档会话 / 撤回方案 / 归类 /
 * 规则删除 / 规则试跑 / 规则建议 —— 全被这一处影响,所以修在这里而不是每个调用点。
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

// ── M4:AI 整理 ──────────────────────────────────────────

export const curatorApi = {
  listSessions: () =>
    api<{ sessions: SessionSummary[] }>('/api/curator/sessions').then((r) => r.sessions),

  newSession: (title?: string) =>
    json<{ id: number }>('POST', '/api/curator/sessions', title ? { title } : {}).then((r) => r.id),

  getSession: (id: number) => api<SessionDetail>(`/api/curator/sessions/${id}`),

  archiveSession: (id: number) => json<{ ok: true }>('DELETE', `/api/curator/sessions/${id}`),

  getDraft: (id: number) =>
    api<{ draft: SessionDetail['draft'] }>(`/api/curator/sessions/${id}/draft`).then((r) => r.draft),

  saveDraft: (id: number, folders: FolderSpec[], constraints?: string) =>
    json<{ ok: true }>('PUT', `/api/curator/sessions/${id}/draft`, { folders, constraints }),

  runPass1: (id: number, constraint?: string) =>
    json<Pass1Response>('POST', `/api/curator/sessions/${id}/run-pass-1`, { constraint }),

  runPass2: (id: number) => json<Pass2Response>('POST', `/api/curator/sessions/${id}/run-pass-2`),

  /**
   * 把 AI 归类提案应用到工作副本。folderTempId 就是工作夹子 id,不需要映射。
   *
   * 默认不覆盖:期间有用户手改时后端回 **409**,确认过再带 `force: true` 重来。
   */
  apply: (sessionId: number, force = false) =>
    json<{
      ok: true;
      applied: number;
      skipped: number;
      /** AI 拿不准、保持原样的条数 —— 不单列的话"归类完成"就是句假话 */
      unclassified: number;
      /** **日志条数**,不是条目数(一次操作只留一行) */
      overwritten: number;
    }>('POST', `/api/curator/sessions/${sessionId}/apply`, { force }),

  /** 撤回方案:草稿和归类结果一起丢 */
  clearClassification: (id: number) =>
    json<{ ok: true }>('DELETE', `/api/curator/sessions/${id}/classification`),

  makeAudit: (sessionId: number) =>
    json<{ id: number; report: AuditReport }>('POST', '/api/curator/audit/reorganize', { sessionId }),

  listAudits: (kind?: string) =>
    api<{ audits: AuditSummary[] }>(
      `/api/curator/audit${kind ? `?kind=${kind}` : ''}`,
    ).then((r) => r.audits),
};

/**
 * 发一条消息并接收流式回复。
 *
 * 用 fetch + ReadableStream 而不是 EventSource —— EventSource 只能 GET,
 * 而发消息必须带 body。
 *
 * `opts.signal` 传进去 = 用户点停止能真的断开(服务端据此中止生成,
 * 半截回复带 `(已中断)` 标注落库)。不传 = 老行为(不可中断)。
 */
export async function streamMessage(
  sessionId: number,
  content: string,
  onDelta: (delta: string) => void,
  opts: { signal?: AbortSignal; onReasoning?: (delta: string) => void } = {},
): Promise<string> {
  const res = await fetch(`${API_BASE}/api/curator/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { reason?: string };
    throw new Error(body.reason ?? `请求失败 ${res.status}`);
  }
  if (!res.body) throw new Error('服务端没有返回流');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  let failure: string | null = null;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE 以空行分隔事件;最后一段可能不完整,留在 buffer 里等下一个 chunk
    const events = buffer.split('\n\n');
    buffer = events.pop() ?? '';
    for (const block of events) {
      const event = /^event: (.+)$/m.exec(block)?.[1] ?? 'message';
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (!data) continue;
      const payload = JSON.parse(data) as { delta?: string; content?: string; reason?: string };

      if (event === 'error') failure = payload.reason ?? '模型调用失败';
      else if (event === 'done') full = payload.content ?? full;
      // 思考过程单独的帧(§9D.5)—— 不进正文,由调用方决定怎么展示
      else if (event === 'reasoning') opts.onReasoning?.(payload.delta ?? '');
      else if (payload.delta) {
        full += payload.delta;
        onDelta(payload.delta);
      }
    }
  }

  if (failure) throw new Error(failure);
  return full;
}

/**
 * 归类的流式应答(§9D A1):progress 帧喂给 onProgress,done 帧的载荷原样返回。
 *
 * 中途中止(用户点停止)服务端回 `aborted` 帧 —— 这里抛 AbortError,
 * 和 fetch 自己中止是同一种形状,调用方一个 catch 就能两处都接住。
 */
export async function classifyStream(
  sessionId: number,
  onProgress: (p: ProgressPayload) => void,
  opts: { signal?: AbortSignal } = {},
): Promise<Pass2Response> {
  const res = await fetch(`${API_BASE}/api/curator/sessions/${sessionId}/run-pass-2`, {
    method: 'POST',
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { reason?: string };
    throw new Error(body.reason ?? `请求失败 ${res.status}`);
  }
  if (!res.body) throw new Error('服务端没有返回流');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done: Pass2Response | null = null;
  let failure: string | null = null;

  for (;;) {
    const { done: eof, value } = await reader.read();
    if (eof) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE 以空行分隔事件;最后一段可能不完整,留在 buffer 里等下一个 chunk
    const events = buffer.split('\n\n');
    buffer = events.pop() ?? '';
    for (const block of events) {
      const event = /^event: (.+)$/m.exec(block)?.[1] ?? 'message';
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (!data) continue;
      if (event === 'progress') onProgress(JSON.parse(data) as ProgressPayload);
      else if (event === 'done') done = JSON.parse(data) as Pass2Response;
      else if (event === 'aborted') throw new DOMException('已中止', 'AbortError');
      else if (event === 'error') failure = (JSON.parse(data) as { reason?: string }).reason ?? '归类失败';
    }
  }
  if (failure) throw new Error(failure);
  if (!done) throw new Error('服务端没有返回归类结果');
  return done;
}

// ── 模型管理(spec §3)──────────────────────────────────

export const llmApi = {
  /** 内置注册表(厂商列表拉不到时的兜底,语义同旧) */
  listModels: (provider?: string) =>
    api<{ models: ModelMeta[] }>(
      `/api/settings/models${provider ? `?provider=${provider}` : ''}`,
    ).then((r) => r.models),

  /**
   * 从厂商的 `/models` 拉真实模型名。apiKey 留空 = 用已存的那个(凭证表单里
   * 从来拿不到明文 key,首次配只能靠用户现填的这个)。
   */
  listRemoteModels: (input: { provider: string; baseUrl?: string; apiKey?: string }) =>
    json<{ models: ModelMeta[] }>('POST', '/api/settings/remote-models', input).then(
      (r) => r.models,
    ),

  providers: () =>
    api<{ providers: ProviderView[] }>('/api/settings/providers').then((r) => r.providers),

  saveProvider: (input: { id?: string; provider: string; baseUrl?: string; apiKey?: string }) =>
    json<{ ok: true; id: string }>('PUT', '/api/settings/providers', input),

  deleteProvider: (id: string) =>
    json<{ ok: true }>('DELETE', `/api/settings/providers/${id}`),

  entries: () =>
    api<{ entries: EntryView[] }>('/api/settings/entries').then((r) => r.entries),

  addEntry: (input: { providerId: string; model: string }) =>
    json<{ ok: true; id: string }>('POST', '/api/settings/entries', input),

  deleteEntry: (id: string) =>
    json<{ ok: true }>('DELETE', `/api/settings/entries/${id}`),

  assignments: () =>
    api<AssignmentsView>('/api/settings/assignments').then((r) => r.assignments),

  setAssignments: (input: Partial<Record<LlmPurpose, string | null>>) =>
    json<{ ok: true }>('PUT', '/api/settings/assignments', input),

  test: (input: { provider: string; model: string; baseUrl?: string; apiKey?: string }) =>
    json<{ ok: true; reply: string }>('POST', '/api/settings/test-llm', input),
};

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
};

// ── M4c:规则 ────────────────────────────────────────────

export const rulesApi = {
  list: () => api<{ rules: RuleView[] }>('/api/rules').then((r) => r.rules),

  /** 整组条件覆盖(你手写的路 —— origin 记 'user') */
  save: (folderId: number, conditions: RuleCondition[]) =>
    json<{ ok: true }>('PUT', `/api/rules/${folderId}`, { conditions }),

  remove: (folderId: number) => json<{ ok: true }>('DELETE', `/api/rules/${folderId}`),

  /** 采纳一条建议 = **追加**一个条件(origin 记 'ai'),不是覆盖 */
  adopt: (folderId: number, s: Omit<RuleSuggestion, 'folderId'>) =>
    json<{ ok: true }>('POST', `/api/rules/${folderId}/adopt`, s),

  /** 试跑:规则覆盖多少、剩多少给 AI、几批 */
  dryRun: () => json<DryRun>('POST', '/api/rules/dry-run'),

  /** 让 AI 看看规则 —— 建议**不落库**,刷新就没了 */
  suggest: () => json<{ suggestions: RuleSuggestion[] }>('POST', '/api/rules/suggest'),
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
  items: (id: number, page = 1) =>
    api<{ items: Item[]; total: number; foldersOf: Record<string, { id: number; title: string }[]>; tagsOf: Record<string, string[]> }>(
      `/api/tags/${id}/items?page=${page}&pageSize=60`,
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
