export interface Folder {
  id: number;
  title: string;
  mediaCount: number;
  type: number | null;
  /**
   * B站 账号自带的「默认收藏夹」:不能改名、不能删除,只能往里外移条目。
   * 新收藏没指定夹子时会落在这里,所以它通常占大头。
   */
  locked?: boolean;
  /** 'default' = 自动判定出来的;手动锁的不带这个 */
  lockedBy?: 'default' | null;
}
export interface Item {
  id: string; title: string; cover: string | null; duration: number | null;
  pubtime: number | null; favTime: number | null; upperName: string | null; invalid: number;
}

// ── M4:AI 整理 ──────────────────────────────────────────

/** 体系里的一个夹子(草稿 / Pass 1 提案共用) */
export interface FolderSpec {
  /** Pass 2 引用用的临时 id */
  tempId: string;
  name: string;
  description: string;
  rule: string;
  estCount: number;
  /** 复用现有夹子而不是新建 —— B站不能改归属,复用比新建重要得多 */
  reuseFolderId?: number;
}

export interface ChatMessage {
  id: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  ts: number | null;
}

export interface SessionSummary {
  id: number;
  title: string | null;
  preview: string | null;
  status: 'active' | 'archived' | null;
  updatedAt: number | null;
}

export interface Assignment {
  itemId: string;
  /** null = 未归类(AI 语境里也只有这一个说法,不另起一个词) */
  folderTempId: string | null;
  confidence: number;
  reason: string;
}

export interface FailedBatch {
  firstItemId: string;
  size: number;
  reason: string;
}

export interface TaxonomyProposal {
  folders: FolderSpec[];
  notes: string;
}

/** Pass 1 输出校验报告(spec §9.1.1)。前两条阻断,后两条只是警告 */
export interface ValidationReport {
  invalidReuseIds: number[];
  duplicateReuseIds: { folderId: number; tempIds: string[] }[];
  unmatchedExistingFolders: number[];
  nameConflicts: string[];
}

export interface SessionDetail {
  session: SessionSummary;
  messages: ChatMessage[];
  draft: { sessionId: number; folders: FolderSpec[]; constraints?: string; updatedAt: number } | null;
  classification: { assignments: Assignment[]; failed: FailedBatch[] } | null;
}

export interface FolderSnapshot {
  id?: number;
  tempId?: string;
  name: string;
  count: number;
}

export interface AuditReport {
  kind: 'reorganize';
  title: string;
  summary: string;
  before: FolderSnapshot[];
  after: FolderSnapshot[];
  detail: {
    merged: { fromFolderId: number; intoTempId: string }[];
    unassigned: string[];
    byFolder: Record<string, string[]>;
  };
}

export interface AuditSummary {
  id: number;
  kind: string;
  title: string | null;
  summary: string | null;
  createdAt: number | null;
}

export interface ModelMeta {
  provider: string;
  model: string;
  contextWindow: number;
  maxOutput: number;
  /** false = 估算值,UI 标 ⚠️ 待确认 */
  verified: boolean;
  note?: string;
}

export interface ProviderView {
  id: string;
  provider: string;
  baseUrl: string;
  /** 后端**只**回这个,永远不回传 apiKey 本身 */
  hasApiKey: boolean;
}

export interface EntryView {
  id: string;
  providerId: string;
  provider: string;
  model: string;
  /** 服务端查注册表/ollama meta 拼好的数字 —— 前端不存不算 */
  contextWindow: number;
  maxOutput: number;
  verified: boolean;
  note?: string;
}

export type LlmPurpose = 'chat' | 'classify' | 'rules' | 'tag' | 'tagcheck';

export interface AssignmentsView {
  assignments: Record<LlmPurpose, string | null>;
}

export interface Pass1Response {
  taxonomy: TaxonomyProposal;
  warnings: string[];
  validation: ValidationReport;
  sampleSize: number;
  keywordStats: { matched: number; unmatched: number };
  batchSize: number;
}

export interface Pass2Response {
  assignments: Assignment[];
  failedBatches: FailedBatch[];
  total: number;
  batchSize: number;
  /** 规则归了几条条目(spec §9C.3 ③ 要如实分栏) */
  ruleCount: number;
  /** AI 归了几条 */
  aiCount: number;
  /** 没归上的那些条目攒出来的建议 —— 不落库,刷新就没了 */
  suggestions: RuleSuggestion[];
}

/**
 * run-pass-2 的 progress 帧载荷(§9D A2)—— **恰好这五个字段**,多一个都算破坏契约。
 * 服务端每跑完一批发一帧,用来画进度条。
 */
export interface ProgressPayload {
  /** 刚到第几批 */
  batch: number;
  /** 一共几批 */
  batches: number;
  /** 已完成条数 */
  done: number;
  /** 交给 AI 的总条数 */
  total: number;
  /** 规则已接走的条目数(与 done 帧的 ruleCount 同口径) */
  ruleCount: number;
}

// ── M4b:整理工作台 ──────────────────────────────────────

export type ChangeMark = 'unchanged' | 'renamed' | 'created' | 'merged' | 'removed';

export interface WorkFolderView {
  id: number;
  name: string;
  originId: number | null;
  /** 改了名前叫什么;没改是 null。点开 ✎ 标记显示它 */
  originName: string | null;
  mark: ChangeMark;
  itemCount: number;
  locked: boolean;
}

export interface RemovedFolder {
  id: number;
  name: string;
  itemCount: number;
  /** 条目并进了哪个夹子;null = 被移出或本来就是空夹 */
  intoName: string | null;
  mark: 'merged' | 'removed';
}

export interface WorkbenchView {
  exists: boolean;
  basedOn: number | null;
  /** 整理期间又同步过 —— 顶部提示用 */
  stale: boolean;
  folders: WorkFolderView[];
  removed: RemovedFolder[];
  unassignedCount: number;
}

export type OpKind =
  | 'rename_folder' | 'merge_folders' | 'create_folder' | 'delete_folder'
  | 'move_items' | 'add_items' | 'remove_items' | 'delete_invalid_items' | 'reset'
  /**
   * 任何编辑动作的失败尝试 —— 后端 `actionError` 在写 4xx 响应前会留一条。
   * 让用户在「操作记录」面板里看到具体哪里错了。
   */
  | 'failed';

export interface OperationEntry {
  id: number;
  ts: number;
  kind: OpKind;
  actor: 'user' | 'ai';
  sessionId: number | null;
  summary: string;
  detail: unknown;
}

// ── M4c:规则 ────────────────────────────────────────────

export type RuleField = 'title' | 'intro' | 'upper';

/** 一条条件 = "某字段里命中任一关键词"。条件之间 OR */
export interface RuleCondition {
  field: RuleField;
  any: string[];
}

/** 谁写的 —— 界面上一眼看出这是谁的主意(🤖 / ✎) */
export type RuleOrigin = 'ai' | 'user';

/** /api/rules 的一行:每个工作夹子一行,没规则的也在 */
export interface RuleView {
  folderId: number;
  folderName: string;
  /** 锁定的夹子不能加规则 */
  locked: boolean;
  /** 空数组 = 还没有规则 */
  conditions: RuleCondition[];
  /** null = 还没人写过 */
  origin: RuleOrigin | null;
  updatedAt: number | null;
  /** 命中数:这条规则会从**全库**捞走多少条 */
  hit: number;
}

/** 试跑:规则能覆盖多少条、剩下多少要给 AI */
export interface DryRun {
  covered: number;
  remaining: number;
  /** 没配模型时是 null */
  batches: number | null;
}

/**
 * 一条 AI 规则建议。**过了自证才有**(服务端会拿这组词去跑匹配验证)。
 * 建议不落库 —— 采纳才变成规则。
 */
export interface RuleSuggestion {
  folderId: number;
  field: RuleField;
  any: string[];
  because: string;
  /** 它声称会命中的条目 —— 建议可信度的来源 */
  evidenceItemIds: string[];
}

// ── M4e:条目 AI 标注 ────────────────────────────────────

/** 打标进度 + 这次会用哪个模型(spec §9E) */
export interface TagRunStatus {
  tagged: number;
  total: number;
  /**
   * `source` 是**实际生效**的来源:用途平级后 tag 没配就是 null;'main' 仅为兼容保留。
   * 不告诉用户的话,他以为在烧本地 4b,实际每批都在打贵的那个。
   */
  model: { provider: string; model: string; source: 'tag' | 'main' } | null;
}

/** 标注的 progress 帧载荷 —— 只有这三个数,没有归类那边的 ruleCount */
export interface TagProgressPayload {
  done: number;
  total: number;
  tagged: number;
}
