import { App as AntApp, ConfigProvider, theme as antdTheme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { Link, Outlet, useLocation } from '@umijs/max';
import { FolderHeart, KeyRound, Tags, Wand2 } from 'lucide-react';

/**
 * HUD 外壳 —— 设计语言移植自 CP2077 UI Kit(B 档)。
 * 顶栏是唯一带扫描线装饰的地方,内容区保持干净可读。
 */
export default function Layout() {
  const { pathname } = useLocation();

  const nav = [
    { to: '/', label: '总览', en: 'OVERVIEW', icon: FolderHeart },
    { to: '/curator', label: '整理', en: 'CURATOR', icon: Wand2 },
    { to: '/tag', label: '标签', en: 'TAGS', icon: Tags },
    { to: '/auth', label: '授权', en: 'AUTH', icon: KeyRound },
  ];

  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: antdTheme.darkAlgorithm,
        token: {
          colorPrimary: '#5ef6ff',      // CP2077 Primary/Cyan
          colorError: '#f75049',        // 独占:不可撤销
          colorSuccess: '#1ded83',
          colorWarning: '#FB932E',
          colorBgBase: '#0e0e17',
          colorTextBase: '#d6d0d0',
          borderRadius: 2,
          fontFamily:
            '"PingFang SC", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif',
        },
        components: {
          // 弹框要跟 HUD 一致 —— 面板底色 + 发丝线,不要 antd 默认的圆角大卡片
          Modal: {
            contentBg: '#16161f',
            headerBg: '#16161f',
            titleColor: '#d6d0d0',
            borderRadiusLG: 2,
          },
          Alert: { borderRadiusLG: 2 },
        },
      }}
    >
      {/*
        `<App>` 不是装饰 —— antd 的**静态方法**(`Modal.confirm` / `message.*` /
        `notification.*`)渲染在一个**独立的 React root** 里,读不到外层
        `ConfigProvider` 的 darkAlgorithm,于是弹框永远是浅色主题。
        `<App>` 把主题通过 context 交给它内部持有的那套方法,
        之后用 `App.useApp()` 拿到的 `modal` / `message` 才认主题。

        `component={false}` 是不让它在中间插一层 div —— 外壳的高度链
        (`html/body/#root` 100% → 外壳 100%)断一层就会塌。
      */}
      <AntApp component={false}>
      {/* 应用外壳:锁死一屏、自身不滚动,滚动只发生在内容区。
          高度用 100%(链自 html/body/#root 的 100%),**不用 100vh** ——
          100vh 是"视口高度"而 % 是"父元素高度",二者不等时会撑破外壳、
          把底部的 padding 一起裁掉。统一走同一条高度链才不会打架。 */}
      <div
        style={{
          height: '100%',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--bg)',
        }}
      >
        {/* ── 顶栏 ───────────────────────────────── */}
        <header
          className="hud-scanlines"
          style={{
            height: 52,
            flex: 'none',
            display: 'flex',
            alignItems: 'center',
            gap: 28,
            padding: '0 20px',
            background: 'var(--surface)',
            borderBottom: '1px solid var(--rule)',
            zIndex: 10,
          }}
        >
          {/* 标识:青色角括号 + 名字 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <span
              style={{
                width: 12,
                height: 12,
                borderLeft: '2px solid var(--accent)',
                borderBottom: '2px solid var(--accent)',
                display: 'inline-block',
              }}
            />
            <span style={{ fontWeight: 600, letterSpacing: '0.02em' }}>收藏管家</span>
            <span className="hud-label" style={{ color: 'var(--accent)', opacity: 0.7 }}>
              BFM
            </span>
          </div>

          <nav style={{ display: 'flex', gap: 4 }}>
            {nav.map(({ to, label, en, icon: Icon }) => {
              const active = pathname === to;
              return (
                <Link
                  key={to}
                  to={to}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 7,
                    padding: '5px 12px',
                    color: active ? 'var(--accent)' : 'var(--text-dim)',
                    borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
                    textDecoration: 'none',
                    fontSize: 'var(--fs-13)',
                    transition: 'color .15s ease-out',
                  }}
                >
                  <Icon size={14} />
                  {label}
                  <span className="hud-label" style={{ fontSize: 10, opacity: 0.55 }}>
                    {en}
                  </span>
                </Link>
              );
            })}
          </nav>

          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 14 }}>
            <span className="hud-label">LOCAL MIRROR</span>
          </div>
        </header>

        {/* ── 内容区(无扫描线,保持可读) ─────────────
            minHeight:0 是 flex 子元素能正确内部滚动的关键(否则会被内容撑开) */}
        <main
          style={{
            flex: 1,
            minHeight: 0,
            overflow: 'hidden',
            /* 底部比顶部多留 —— 视觉重心偏上,底部空间不足会显得"没坐住" */
            padding: '18px 18px 28px',
          }}
        >
          <Outlet />
        </main>
      </div>
      </AntApp>
    </ConfigProvider>
  );
}
