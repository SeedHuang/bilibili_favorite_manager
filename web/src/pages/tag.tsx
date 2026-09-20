import TagPanel from '../components/TagPanel';

/**
 * /tag 标签 —— 词库的治理页。
 *
 * 为什么单开一页而不是挂在「规则」底下:标签是规则的**地基**(规则第四字段直接
 * 按标签子树匹配),但它比规则更基础 —— 规则是"谁进哪个夹子",标签是"这是什么"。
 */
export default function TagPage() {
  return (
    <div style={{ height: '100%', overflow: 'hidden', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span className="hud-label" style={{ color: 'var(--accent)' }}>标签</span>
        <span style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>
          由 AI 标注长出来的词库。结构每轮自动整理,你也能手动改
        </span>
      </div>
      <TagPanel />
    </div>
  );
}
