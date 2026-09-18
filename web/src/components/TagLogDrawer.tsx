import { useEffect, useRef, useState } from 'react';
import { Button, Drawer } from 'antd';
import { ArrowDown, Eraser } from 'lucide-react';
import type { TagLogLine } from '../types';

/**
 * 「AI 标注」的日志抽屉(spec §9D.7)。
 *
 * 这扇抽屉是**纯渲染器**:日志本身在 TagPanel 手里(关了抽屉不能丢,那是 TagPanel 的
 * state),这里只收「要展示的这几行」。开/关也由 TagPanel 传 —— 本组件不自己开抽屉,
 * 那样抽屉内部状态会跟 TagPanel 的「日志」按钮脱节。
 *
 * **渲染封顶(§9D.7 ③)**:全库一轮是几千行,3250 个 DOM 行画出来抽屉必然卡。
 * 缓冲区全留,只画最新 ~500 行,上面压一行「还有 N 条更早的」。
 */
export default function TagLogDrawer({
  open,
  onClose,
  lines,
  onClear,
}: {
  open: boolean;
  onClose: () => void;
  /** 全量缓冲区 —— 封顶在渲染层做,关抽屉/再打开不会丢 */
  lines: TagLogLine[];
  onClear: () => void;
}) {
  const [follow, setFollow] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  const warnCount = lines.filter((l) => l.type === 'note' && l.level === 'warn').length;

  // 贴底跟随:开抽屉时跳到底(正在跑或刚跑完,最新在下面),之后每条新行都贴底。
  // 用户往上滚了就停(手在翻更早的记录,不该被新行拽走)
  useEffect(() => {
    const el = scrollRef.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [open, lines, follow]);

  // 渲染封顶(§9D.7 ③):只画最新的 500 行。**不截断缓冲区** —— 只截渲染,
  // 不然滚过之后旧行就真没了
  const RENDER_CAP = 500;
  const visible = lines.slice(-RENDER_CAP);
  const hidden = lines.length - visible.length;

  return (
    <Drawer
      className="bfm-drawer"
      open={open}
      onClose={onClose}
      placement="right"
      width={460}
      maskClosable
      styles={{ body: { display: 'flex', flexDirection: 'column', height: '100%' } }}
      title={
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="hud-label" style={{ color: 'var(--accent)' }}>标注日志</span>
          <span style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>
            {lines.length.toLocaleString()} 行
            {/* warn 的个数单独报 —— 失败是这扇抽屉存在的理由之一 */}
            {warnCount > 0 && (
              <span style={{ color: 'var(--warn)' }}> · {warnCount} 条提醒</span>
            )}
          </span>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 2 }}>
            <Button
              type="text" size="small" aria-label={follow ? '已自动贴底' : '滚回底部'}
              icon={<ArrowDown size={14} />}
              onClick={() => { setFollow(true); }}
              style={follow ? { color: 'var(--accent)' } : undefined}
            />
            <Button
              type="text" size="small" aria-label="清空日志"
              icon={<Eraser size={14} />}
              onClick={onClear}
            />
          </span>
        </div>
      }
    >
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          // 离底超过 40px 就算"用户在看更早的",停掉贴底
          setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
        }}
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '10px 14px' }}
      >
        {lines.length === 0 ? (
          <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--text-dim)', fontSize: 'var(--fs-13)' }}>
            还没跑过标注 —— 点上面的「AI 标注」,这里会出现每一步
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 'var(--fs-12)', lineHeight: 1.6 }}>
            {hidden > 0 && (
              // 渲染封顶(§9D.7 ③)的那条线 —— 告诉读者上面还有更早的,
              // 不然他会以为日志从"这里"开始
              <div style={{ padding: '4px 0', color: 'var(--text-dim)' }}>
                还有 <span className="num">{hidden.toLocaleString()}</span> 条更早的
              </div>
            )}
            {visible.map((l, i) => <LogRow key={i} line={l} />)}
          </div>
        )}
      </div>
    </Drawer>
  );
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
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span className="num" style={{ color: 'var(--text-dim)', flex: 'none' }}>质检</span>
        <span style={{ flex: 'none' }}>「{line.name}」</span>
        {/* 判词按动作上色 —— 一眼扫过去就知道这轮主要动了什么 */}
        <span style={{ color: actionColor(line.action), flex: 'none' }}>
          {actionText(line)}
        </span>
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
