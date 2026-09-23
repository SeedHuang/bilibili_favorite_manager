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
  /** AI 建的夹子(spec 2026-09-21 三分类) */
  ai: boolean;
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
  /** §9F C14:夹子画像。后端一次算完整个数组 */
  profiles?: FolderProfile[];
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
  summary: string;
  detail: unknown;
}

// ── M4c:规则 ────────────────────────────────────────────

export type RuleField = 'title' | 'intro' | 'upper' | 'tag';

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
  /** AI 建的夹子(spec 2026-09-21 三分类)—— 它的规则只读,走建议通道 */
  ai: boolean;
  /** 命中数:这条规则会从**全库**捞走多少条 */
  hit: number;
}

// ── M4e:条目 AI 标注 ────────────────────────────────────

/** 一批失败的条目(打标/质检进度里的 failedBatches 用) */
export interface FailedBatch {
  firstItemId: string;
  size: number;
  reason: string;
}

/** 打标进度 + 这次会用哪个模型(spec §9E) */
export interface TagRunStatus {
  tagged: number;
  total: number;
  /**
   * 被排除的已失效条目数(invalid = 1,没标题没简介,模型标不了)。
   * 分母(total)不含它们 —— 单列出来是因为「已标 N/M」里的 M 变了用户该知道为什么
   */
  invalid: number;
  /**
   * `source` 是**实际生效**的来源:用途平级后 tag 没配就是 null;'main' 仅为兼容保留。
   * 不告诉用户的话,他以为在烧本地 4b,实际每批都在打贵的那个。
   */
  model: { provider: string; model: string; source: 'tag' | 'main' } | null;
}

/** 标注的 progress 帧载荷 —— 只有这三个数 */
export interface TagProgressPayload {
  done: number;
  total: number;
  tagged: number;
}

/**
 * 轮询版标注的实时状态 —— `GET /api/tags/run-progress` 一次拉全。
 *
 * `running=false` 且 `result` 非空 = 正常跑完;`running=false` 且 `result=null`
 * = 被中止或失败(看 `error`)。`logs` 是这一轮的全部日志行 —— 前端每次轮询全量
 * 替换(TagPanel 按长度短路,没新行不重渲染)。
 */
export interface TagRunProgress {
  running: boolean;
  scope: 'missing' | 'all' | null;
  done: number;
  total: number;
  tagged: number;
  failedBatches: FailedBatch[];
  /** 跑完才有;中止/失败为 null */
  result: Pick<TagRunResult, 'tagged' | 'failedBatches' | 'newWordCount' | 'changes'> | null;
  error: string | null;
  logs: TagLogLine[];
}

// ── M4g 追加:标注日志(§9D.7)─────────────────────────────
// 四种帧只在 SSE 流里活,不落库(和进度一个待遇 —— §9D 定的"进度只活在 SSE 里")。
// 一个受控联合而不是四个接口:抽屉只关心"哪一行是什么形状",按 type 一判就能整行落地。

/** phase 帧:某一阶段开跑 + 用哪个模型 */
export interface TagLogPhase {
  type: 'phase';
  phase: 'tag' | 'check';
  provider: string;
  model: string;
}

/** item 帧:一条视频标完了,标签落库之后报 */
export interface TagLogItem {
  type: 'item';
  id: string;
  title: string;
  kind: string;
  domains: string[];
  tags: string[];
}

/** verdict 帧:质检判了一个词(keep / drop / merge / move) */
export interface TagLogVerdict {
  type: 'verdict';
  name: string;
  action: 'keep' | 'drop' | 'merge' | 'move';
  target?: string;
  /** 模型给的判定理由(一句话)—— "为什么这么判"要看得见 */
  reason?: string;
}

/** note 帧:过程中的一句话 —— info 是顺带说明,warn 是要看的岔子 */
export interface TagLogNote {
  type: 'note';
  level: 'info' | 'warn';
  text: string;
}

export type TagLogLine = TagLogPhase | TagLogItem | TagLogVerdict | TagLogNote;

// ── M4g:标签体系(词库树)──────────────────────────────
// 树这个形状是必须的:规则存的标签是 id(见 RuleCondition.any),而人挑的时候
// 挑的是词名 —— 没有树就既选不了、也显示不出名字。

export interface TagNode {
  id: number;
  name: string;
  parentId: number | null;
  /** 直达这个节点的条目数,不含子孙 */
  count: number;
  children: TagNode[];
}

export interface TagTreeView {
  tree: TagNode[];
  total: number;
}

/** 词库健康度(M4h):活跃词数是整理成本的决定量,持续涨就是在膨胀 */
export interface ReconcileStats {
  totalTags: number;
  activeTags: number;
  /** 质检台账的欠账数(checked_at IS NULL)—— 「待检 N」读它 */
  unchecked: number;
  reconcileMs: number | null;
  lastRunAt: number | null;
}

/** 手动质检的 progress 帧载荷 —— done/total 是**词数** */
export interface TagCheckProgressPayload {
  done: number;
  total: number;
}

/**
 * 手动质检的实时状态 —— `GET /api/tags/check-progress` 一次拉全,轮询模式同 TagRunProgress。
 * `logs` 是这一轮的全部日志行(phase/verdict/note),verdict 带 reason(模型给的判定理由)。
 */
export interface TagCheckProgress {
  running: boolean;
  scope: 'all' | 'continue' | null;
  done: number;
  total: number;
  result: { dropped: number; merged: number; moved: number; checked: number } | null;
  error: string | null;
  logs: TagLogLine[];
}

/** 一轮整理对树做了什么 —— 「标签」页顶部的清单(§9F C10) */
export interface TreeChange {
  kind: 'merge' | 'reparent';
  from: string;
  to: string;
  detail: string;
}

export interface TagRunResult {
  tagged: number;
  failedBatches: FailedBatch[];
  /** 质检做了什么 —— 剔了几个泛词、合了几组、挪了几个 */
  check: { dropped: number; merged: number; moved: number };
  /** 这轮树发生了什么(质检的 + 判据的),「标签」页顶部那张清单 */
  changes: TreeChange[];
  /** 本轮新建了多少个词 */
  newWordCount: number;
}

/** §9F C14:一个夹子的标签画像 + 离群条目 */
export interface FolderProfile {
  folderId: number;
  name: string;
  itemCount: number;
  /** 高频标签,降序 —— 模型提改进时看的就是它 */
  topTags: { name: string; count: number }[];
  /** 和这个夹子不搭的条目 id(零参数判据) */
  outliers: string[];
}

// ── 夹子方案生成 ─────────────────────────────────────────
/** 一条生成日志 —— 和 server 侧 proposalRun.logs 同形;内存态,重启 run 自动清 */
export interface ProposalLogLine { ts: number; level: 'info' | 'warn' | 'error'; text: string }

export interface ProposalInfo {
  level: number | null;
  uncoveredCount: number;
  status: 'idle' | 'generating' | 'ready';
  createdAt: number | null;
}

export interface ProposalDraftView {
  id: number;
  name: string;
  reason: string;
  conditions: RuleCondition[];
  hitCount: number;
  weak: boolean;
  status: 'pending' | 'adopted' | 'discarded';
  adoptedFolderId: number | null;
  sampleTitles: string[];
}

// ── 批次任务三件套设置(spec 2026-09-20 §3)──────────────
export type PollConfig = { intervalMs: number; batch: number | null };
export type PollsMap = Record<string, PollConfig>;

// ── 审查勾选的夹子(spec 2026-09-21 §5/§6)─────────────────
export type ReviewKind = 'rule' | 'merge' | 'delete';

export interface ReviewDraftView {
  id: number;
  kind: ReviewKind;
  folderId: number;
  /** current 端点带上,免前端再查 */
  folderName?: string;
  intoId?: number | null;
  intoName?: string | null;
  conditions: RuleCondition[] | null;
  because: string;
  status: 'pending' | 'adopted' | 'discarded';
}

export interface ReviewCurrent {
  running: boolean;
  logs: ProposalLogLine[];
  drafts: ReviewDraftView[];
}
