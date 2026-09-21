import { Fragment } from 'react';
import { Button, Drawer } from 'antd';
import { ArrowDown, Download, Eraser } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * 任务日志抽屉的**泛型壳**(spec 2026-09-20 §4.1)。
 *
 * 以 TagLogDrawer 为底本抽出来的纯渲染器:日志缓冲区在调用方手里(关了抽屉不能丢),
 * 开/关也由调用方传 —— 本组件不自己开抽屉。行内容长什么样由 renderLine 决定,
 * 泛型壳不认识任何业务行类型(那是 TagLogDrawer 自己的特化)。
 *
 * **渲染封顶(沿 §9D.7 ③)**:几千行全画出来抽屉必然卡。缓冲区全留,只画最新
 * ~500 行,上面压一行「还有 N 条更早的」。
 */
export default function TaskLogDrawer<T>({
  open,
  onClose,
  onClear,
  waiting,
  title,
  lines,
  renderLine,
  serialize,
  downloadName,
  warnCount,
  top,
}: {
  open: boolean;
  onClose: () => void;
  onClear: () => void;
  /** 任务在跑但日志还没内容 → 空态说"正在等模型" */
  waiting?: boolean;
  title: string;
  /** 全量缓冲区 —— 封顶在渲染层做,关抽屉/再打开不会丢 */
  lines: T[];
  renderLine: (line: T, index: number) => ReactNode;
  /** 下载内容;缺省 JSON.stringify(lines, null, 2) */
  serialize?: (lines: T[]) => string;
  /** 缺省 `${title}-${日期}.txt` */
  downloadName?: string;
  /** warn 行数;泛型壳不知道哪行是 warn,由调用方数好传入 */
  warnCount?: number;
  /** 滚动区之前的固定区块(如 TagLogDrawer 的「上一轮变化」)—— 调用方特有,壳不管内容 */
  top?: ReactNode;
}) {
  const [follow, setFollow] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 贴底跟随:开抽屉时跳到底(正在跑或刚跑完,最新在下面),之后每条新行都贴底。
  // 用户往上滚了就停(手在翻更早的记录,不该被新行拽走)
  useEffect(() => {
    const el = scrollRef.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [open, lines, follow]);

  // 渲染封顶:只画最新的 500 行。**不截断缓冲区** —— 只截渲染,不然滚过之后旧行就真没了
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
          <span className="hud-label" style={{ color: 'var(--accent)' }}>{title}</span>
          <span style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>
            {lines.length.toLocaleString()} 行
            {/* warn 的个数由调用方数好传入 —— 泛型壳不认识行类型 */}
            {warnCount != null && warnCount > 0 && (
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
            <Button
              type="text" size="small" aria-label="下载日志"
              icon={<Download size={14} />}
              onClick={() => {
                const text = serialize ? serialize(lines) : JSON.stringify(lines, null, 2);
                const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
                const a = document.createElement('a');
                a.href = url;
                a.download = downloadName ?? `${title}-${new Date().toISOString().slice(0, 10)}.txt`;
                a.click();
                // revoke 延一拍:同步 revoke 在 Firefox/Safari 会在浏览器吃到 blob 前把下载掐掉
                setTimeout(() => URL.revokeObjectURL(url), 0);
              }}
            />
          </span>
        </div>
      }
    >
      {top}
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
            {waiting
              ? '任务在跑 —— 正在等模型返回第一批结果……(批量越大等得越久,不是卡死)'
              : '还没跑过 —— 点上面的启动按钮,这里会出现每一步'}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 'var(--fs-12)', lineHeight: 1.6 }}>
            {hidden > 0 && (
              // 渲染封顶的那条线 —— 告诉读者上面还有更早的,
              // 不然他会以为日志从"这里"开始
              <div style={{ padding: '4px 0', color: 'var(--text-dim)' }}>
                还有 <span className="num">{hidden.toLocaleString()}</span> 条更早的
              </div>
            )}
            {/* key 与 renderLine 的 index 都用缓冲区绝对下标:封顶窗口里的相对 i
                会随每条新日志整体平移(key 失稳触发整窗重挂),且调用方按 index
                编号时会对不上行号 */}
            {visible.map((l, i) => <Fragment key={hidden + i}>{renderLine(l, hidden + i)}</Fragment>)}
          </div>
        )}
      </div>
    </Drawer>
  );
}
