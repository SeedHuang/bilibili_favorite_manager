import { MorphIcon, type IconNode } from 'morphicons/react';
import { useAssistant } from './assistant';

/**
 * AI 管家入口(spec §11.9)—— 常驻**顶栏右侧**,不在任何 tab 内。
 *
 * 形象是**自绘的机器人脸**:morphicons 只是形变引擎(把拓扑一致的 path 互相
 * morph),不提供图标,所以脸的路径是这里手写的。眨眼是眼睛路径自己的 CSS
 * 动画,和 MorphIcon 的形变互不干扰 —— 一个动子路径,一个动整张图。
 */

/**
 * 机器人脸:闭合曲线,方形头 + 一对矩形眼。两个状态拓扑完全一致
 * (1 条闭合子路径、同为 8 段贝塞尔、同向)才能干净地形变。
 *
 * - FACE(默认):头上有个天线小球,眼睛是两条横杠 —— 是"它在看"
 * - ORB(打开时):整张脸收成一个圆环 —— 表示"就位/等待输入"
 */
const FACE: IconNode = [
  [
    'path',
    {
      d: [
        // 头部:圆角方脸,天线从头顶竖起(顶部小段)
        'M12 3.2',
        'C12.9 3.2 13.6 3.7 13.9 4.5',
        'C17.9 4.9 21 8.1 21 12',
        'C21 16.4 17 20 12 20',
        'C7 20 3 16.4 3 12',
        'C3 8.1 6.1 4.9 10.1 4.5',
        'C10.4 3.7 11.1 3.2 12 3.2',
        'Z',
      ].join(' '),
    },
  ],
];
const ORB: IconNode = [
  [
    'path',
    { d: 'M12 4C16.418 4 20 7.582 20 12C20 16.418 16.418 20 12 20C7.582 20 4 16.418 4 12C4 7.582 7.582 4 12 4Z' },
  ],
];

/**
 * 两只眼睛,单独一层(不参与 morph)—— 眨眼动画动它们。
 * rect + CSS scaleY(把 transform-origin 定在眼睛中线,闭合就是压扁)。
 */
const EYES: { x: number; y: number; w: number; h: number }[] = [
  { x: 8, y: 10.4, w: 2.4, h: 3.2 },
  { x: 13.6, y: 10.4, w: 2.4, h: 3.2 },
];

export default function AIAssistantIcon() {
  const { open, status, openWith, close } = useAssistant();
  const working = status === 'working';

  return (
    <button
      type="button"
      aria-label={open ? '收起 AI 管家' : '打开 AI 管家'}
      aria-expanded={open}
      onClick={() => (open ? close() : openWith())}
      style={{
        position: 'relative',
        width: 34,
        height: 34,
        flex: 'none',
        display: 'grid',
        placeItems: 'center',
        cursor: 'pointer',
        background: 'var(--surface-2)',
        border: `1px solid ${working ? 'var(--ai)' : 'var(--accent)'}`,
        // 切角:CP2077 的招牌形状,和面板一致(缩到 7px 适配小尺寸)
        clipPath:
          'polygon(7px 0, 100% 0, 100% calc(100% - 7px), calc(100% - 7px) 100%, 0 100%, 0 7px)',
        color: working ? 'var(--ai)' : 'var(--accent)',
        boxShadow: working ? '0 0 12px rgba(240, 181, 55, 0.4)' : 'var(--glow-accent)',
        transition: 'color .2s ease-out, border-color .2s ease-out, box-shadow .2s ease-out',
      }}
    >
      {/* morph 层:脸 ⇄ 圆环(idle → 打开)。眼睛不在这一层 */}
      <MorphIcon
        icon={open ? ORB : FACE}
        size={22}
        color="currentColor"
        strokeWidth={1.5}
        spring="snappy"
        // 尊重系统的"减少动效" —— 形变降级为瞬时切换
        reducedMotion="user"
        label="AI 管家"
      />

      {/* 眼睛层:眨眼按自己的节拍来,和 morph 无关。打开时(ORB)不画眼睛 */}
      {!open && (
        <svg
          viewBox="0 0 24 24"
          width={22}
          height={22}
          aria-hidden
          style={{
            position: 'absolute',
            color: 'currentColor',
            // 覆盖 MorphIcon 绘制的 eye 形状 —— morph 层的 FACE 路径不含眼睛
          }}
        >
          {EYES.map((e, i) => (
            <rect
              key={i}
              x={e.x}
              y={e.y}
              width={e.w}
              height={e.h}
              rx={1.2}
              fill="currentColor"
              className="bfm-blink"
              // 两只眼睛同时眨;每只都是同一个 class,节拍由 keyframes 控制
              style={{
                transformOrigin: `${e.x + e.w / 2}px ${e.y + e.h / 2}px`,
                animationDelay: '0s',
              }}
            />
          ))}
        </svg>
      )}

      {/* 工作中:一圈转动的虚线环。这是"它正在干活"的唯一可信信号 */}
      {working && (
        <span
          aria-hidden
          style={{
            position: 'absolute',
            inset: -5,
            border: '1px dashed currentColor',
            borderRadius: '50%',
            opacity: 0.75,
            animation: 'bfm-spin 2.4s linear infinite',
          }}
        />
      )}
    </button>
  );
}
