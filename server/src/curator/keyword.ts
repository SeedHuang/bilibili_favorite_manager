/**
 * §9.0 Step 1:keyword 初分。**纯本地规则,0 token**。
 *
 * 这一步已经能给出"大致分法" —— 把整个收藏库先按明显的关键词归一堆,
 * 剩下的"待 AI 校准"组才需要喂给模型(spec §9.1)。
 * 3000 条直接在 32K 上下文里是塞不下的,所以这一步不是优化,是前提。
 */

export interface KeywordItem {
  title: string;
  intro?: string | null;
  upperName?: string | null;
}

export interface KeywordHit {
  /** 候选夹子名 */
  candidate: string;
  /** 0-1 */
  confidence: number;
  matchedField: 'title' | 'intro' | 'upper';
  matchedToken: string;
}

/**
 * 各字段的基准权重。
 *
 * 标题 > 简介 > UP 名:标题是作者自己写的分类意图;简介信息量大但可能是
 * 转发/搬运时带上的;UP 名只说明"同一个人的东西常属同类",最弱。
 */
const FIELD_WEIGHT: Record<KeywordHit['matchedField'], number> = {
  title: 0.9,
  intro: 0.8,
  upper: 0.6,
};

/** 同一个字段里每多命中一个词,加一点把握 —— 但很快封顶 */
const PER_EXTRA_TOKEN = 0.05;

/**
 * 用关键词规则给一条收藏打候选夹子。
 *
 * 命中的字段 → 该夹子的置信度(**取最高的那个字段**,一个夹子只出一个结果)。
 * 没命中就返回空数组,调用方据此归入"待 AI 校准"组。
 *
 * @param rules 夹子名 → 关键词列表。种子用 DEFAULT_RULES,也可以由用户
 *              现有收藏夹的名字现推。
 */
export function keywordClassify(
  item: KeywordItem,
  rules: ReadonlyMap<string, readonly string[]>,
): KeywordHit[] {
  const title = (item.title ?? '').toLowerCase();
  const intro = (item.intro ?? '').toLowerCase();
  const upper = (item.upperName ?? '').toLowerCase();
  const fields: [KeywordHit['matchedField'], string][] = [
    ['title', title],
    ['intro', intro],
    ['upper', upper],
  ];

  const hits: KeywordHit[] = [];

  for (const [candidate, tokens] of rules) {
    let best: KeywordHit | null = null;

    for (const [field, text] of fields) {
      if (!text) continue;
      const matched = tokens.filter((t) => t && text.includes(t.toLowerCase()));
      if (matched.length === 0) continue;

      const confidence = Math.min(
        1,
        FIELD_WEIGHT[field] + PER_EXTRA_TOKEN * (matched.length - 1),
      );
      if (!best || confidence > best.confidence) {
        best = { candidate, confidence, matchedField: field, matchedToken: matched[0]! };
      }
    }

    if (best) hits.push(best);
  }

  return hits.sort((a, b) => b.confidence - a.confidence || a.candidate.localeCompare(b.candidate));
}

/**
 * 种子规则表。
 *
 * 这不是"完整的分类体系" —— 它是**免费的初筛**,只为把明显属于某类的条目
 * 先摘出去,减少要喂给模型的条数。真体系由 Pass 1 的 AI 输出 + 用户编辑决定。
 * 用户可以在这张表上加自己的词。
 */
export const DEFAULT_RULES: ReadonlyMap<string, readonly string[]> = new Map([
  [
    'AI/编程',
    [
      'Python', '编程', '代码', '算法', '数据结构', '前端', '后端', '全栈',
      'JavaScript', 'TypeScript', 'Java', 'Rust', 'Golang', 'C++', 'SQL',
      '数据库', 'Linux', 'Docker', 'Kubernetes', 'Git', '源码', '架构',
      '框架', '重构', '面试题', 'LeetCode',
    ],
  ],
  [
    'AI/大模型',
    [
      '大模型', 'LLM', 'GPT', 'Transformer', '机器学习', '深度学习',
      '神经网络', 'PyTorch', 'TensorFlow', '微调', 'RAG', 'Agent',
      '提示词', 'Prompt', '扩散模型', '强化学习', '多模态',
    ],
  ],
  ['数学/基础', ['数学', '线性代数', '概率论', '微积分', '统计学', '高数', '离散数学']],
  ['学习/考试', ['考研', '高考', '四六级', '英语', '公开课', '课程', '讲解', '网课', '期末']],
  ['科技数码', ['数码', '评测', '开箱', '装机', '显卡', 'CPU', '笔记本', '手机', '外设']],
  ['游戏', ['游戏', '攻略', '实况', '通关', '联机', '原神', 'Minecraft', 'Steam', '速通']],
  ['影视/番剧', ['番剧', '动画', '电影', '影视', '解说', '混剪', '预告', '纪录片', '剧场版']],
  ['音乐', ['音乐', '歌曲', '翻唱', '演奏', '钢琴', '吉他', 'BGM', 'MV', '合唱']],
  // 不给"开箱/评测"这类词 —— 它们横跨数码和生活,放哪边都会误伤
  ['生活/美食', ['美食', '做饭', '菜谱', '探店', '旅行', 'vlog', '日常', '好物']],
  ['健身/运动', ['健身', '运动', '跑步', '减脂', '瑜伽', '篮球', '足球', '拉伸']],
]);
