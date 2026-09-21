import TaskLogDrawer from './TaskLogDrawer';
import type { TagLogLine, TreeChange } from '../types';

/**
 * 「AI 标注」的日志抽屉(spec §9D.7)。
 *
 * 这扇抽屉是**纯渲染器**:日志本身在 TagPanel 手里(关了抽屉不能丢,那是 TagPanel 的
 * state),这里只收「要展示的这几行」。开/关也由 TagPanel 传 —— 本组件不自己开抽屉,
 * 那样抽屉内部状态会跟 TagPanel 的「日志」按钮脱节。
 *
 * 抽屉骨架(Drawer/贴底/封顶/空态/下载)已抽进泛型壳 TaskLogDrawer(Plan B Task 3),
 * 这里只剩标签页特化的部分:LogRow 的四类行渲染 + 「上一轮变化」区块(经壳的 top 插槽)。
 */
export default function TagLogDrawer({
  open,
  onClose,
  lines,
  onClear,
  waiting,
  changes,
}: {
  open: boolean;
  onClose: () => void;
  /** 全量缓冲区 —— 封顶在渲染层做,关抽屉/再打开不会丢 */
  lines: TagLogLine[];
  onClear: () => void;
  /** 有任务(标注/质检)在跑但日志还没内容 —— 空态要说"正在等模型",不能说"还没跑过" */
  waiting?: boolean;
  /** 「上一轮变化」清单 —— 收进抽屉(浏览合并进标签页),顶部不再放独立面板 */
  changes?: TreeChange[];
}) {
  const warnCount = lines.filter((l) => l.type === 'note' && l.level === 'warn').length;

  return (
    <TaskLogDrawer
      open={open}
      onClose={onClose}
      onClear={onClear}
      waiting={waiting}
      title="标注日志"
      lines={lines}
      warnCount={warnCount}
      downloadName={`标注日志-${new Date().toISOString().slice(0, 10)}.txt`}
      renderLine={(l) => <LogRow line={l} />}
      serialize={(ls) => ls.map((l) => noteText(l)).join('\n')}
      // 「上一轮变化」是标签页特有区块,壳用 top 插槽放在滚动区之前(位置与样式照原样)
      top={
        changes && changes.length > 0 ? (
          <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--rule)', flex: 'none' }}>
            <div className="hud-label" style={{ marginBottom: 6, color: 'var(--accent)' }}>上一轮变化</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 'var(--fs-12)', maxHeight: 180, overflowY: 'auto' }}>
              {changes.map((c, i) => (
                <div key={i} style={{ display: 'flex', gap: 8 }}>
                  <span style={{ color: c.kind === 'merge' ? 'var(--ok)' : 'var(--accent)', flex: 'none' }}>
                    {c.kind === 'merge' ? '→' : '↑'}
                  </span>
                  <span>{c.from}{c.to ? ` → ${c.to}` : ''}</span>
                  <span style={{ color: 'var(--text-dim)' }}>{c.detail}</span>
                </div>
              ))}
            </div>
          </div>
        ) : undefined
      }
    />
  );
}

/** 把 TagLogLine 压成一行文本 —— 下载 .txt 用(渲染走 LogRow,格式两边一致) */
function noteText(l: TagLogLine): string {
  switch (l.type) {
    case 'phase':
      return `—— ${l.phase === 'tag' ? '打标' : '质检'} ${l.model} ——`;
    case 'item':
      return `[${l.id}] ${l.title}: ${[...l.domains, ...l.tags].join(' / ')}`;
    case 'verdict':
      return `质检「${l.name}」${actionText(l)}${l.reason ? ` ${l.reason}` : ''}`;
    case 'note':
      return `[${l.level === 'warn' ? 'warn' : 'info'}] ${l.text}`;
  }
}

function LogRow({ line }: { line: TagLogLine }) {
  if (line.type === 'phase') {
    return (
      // 阶段头 —— 读者靠它分清这一块是哪一段(§9D.7:按阶段分块)
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, margin: '6px 0 2px', color: 'var(--accent)' }}>
        <span className="hud-label">
          {line.phase === 'tag' ? '打标' : '质检'}
        </span>
        <span style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>
          {line.provider}/{line.model}
        </span>
      </div>
    );
  }
  if (line.type === 'item') {
    return (
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
        <span className="num" style={{ color: 'var(--text-dim)', flex: 'none' }}>{line.id}</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 'none', maxWidth: '45%' }}>
          {line.title}
        </span>
        <span style={{ color: 'var(--ok)', flex: 'none' }}>
          {[...line.domains, ...line.tags].join(' / ')}
        </span>
      </div>
    );
  }
  if (line.type === 'verdict') {
    return (
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
        <span className="num" style={{ color: 'var(--text-dim)', flex: 'none' }}>质检</span>
        <span style={{ flex: 'none' }}>「{line.name}」</span>
        {/* 判词按动作上色 —— 一眼扫过去就知道这轮主要动了什么 */}
        <span style={{ color: actionColor(line.action), flex: 'none' }}>
          {actionText(line)}
        </span>
        {/* 模型给的判定理由 —— "为什么这么判"必须看得见,不然删词就是黑箱 */}
        {line.reason && (
          <span style={{ color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {line.reason}
          </span>
        )}
      </div>
    );
  }
  // note:info 是顺带说明,warn 是用户真正要看的岔子 —— 颜色就是分类本身(§9D.7 ③)
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
      <span style={{ color: line.level === 'warn' ? 'var(--warn)' : 'var(--text-dim)', flex: 'none' }}>
        {line.level === 'warn' ? '⚠' : '·'}
      </span>
      <span style={{ color: line.level === 'warn' ? 'var(--warn)' : 'var(--text-dim)' }}>
        {line.text}
      </span>
    </div>
  );
}

const actionText = (v: Extract<TagLogLine, { type: 'verdict' }>): string => {
  switch (v.action) {
    case 'drop': return '剔除';
    case 'merge': return `并入「${v.target}」`;
    case 'move': return `挪到「${v.target}」下`;
    case 'keep': return '保留';
  }
};

const actionColor = (a: Extract<TagLogLine, { type: 'verdict' }>['action']): string => {
  switch (a) {
    case 'drop': return 'var(--warn)';
    case 'merge': return 'var(--ai)';
    case 'move': return 'var(--accent)';
    case 'keep': return 'var(--text-dim)';
  }
};
