import BrowsePanel from '../components/BrowsePanel';

/**
 * /browse 浏览 —— 按标签看收藏。
 *
 * 和「标签」页分开的理由:那一页是**治理**(改词库),这一页是**使用**(挑视频)。
 * 混在一页会让人以为点标签就改了词。用户明确要了两个页面。
 */
export default function BrowsePage() {
  return (
    <div style={{ height: '100%', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span className="hud-label" style={{ color: 'var(--accent)' }}>浏览</span>
        <span style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>
          按标签看收藏 —— 选一个词,它**连同下面所有的词**一起捞出来
        </span>
      </div>
      <BrowsePanel />
      <div style={{ height: 56, flex: 'none' }} aria-hidden />
    </div>
  );
}
