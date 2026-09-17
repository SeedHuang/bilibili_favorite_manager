import { useState, type CSSProperties } from 'react';
import { useRequest } from '@umijs/max';
import { Button, Input, Alert } from 'antd';
import { ShieldCheck, KeyRound } from 'lucide-react';
import { api, rawResult } from '../api';
import ModelManager from '../components/ModelManager';

export default function AuthPage() {
  const [cookie, setCookie] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [account, setAccount] = useState<{ mid: number; uname: string } | null>(null);
  const [reauthor, setReauthor] = useState(false);
  const [error, setError] = useState('');

  const { data: statusRes, loading: statusLoading } = useRequest(
    () => api<{ ok: boolean; mid?: number; uname?: string }>('/api/auth/status'),
    { formatResult: rawResult },
  );
  const stored =
    statusRes?.ok && statusRes.mid != null
      ? { mid: statusRes.mid, uname: statusRes.uname ?? '' }
      : null;
  const shown = account ?? (reauthor ? null : stored);

  async function handleValidate() {
    setStatus('loading');
    try {
      const r = await api<{ ok: true; mid: number; uname: string }>('/api/auth/validate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cookie }),
      });
      setAccount({ mid: r.mid, uname: r.uname });
      setStatus('idle');
    } catch (e) {
      setError((e as Error).message);
      setStatus('error');
    }
  }

  if (!reauthor && statusLoading && !account) {
    return <p style={{ color: 'var(--text-dim)', fontSize: 'var(--fs-13)' }}>检查授权状态…</p>;
  }

  // 内容区已锁死一屏,页面各自负责滚动
  const pageStyle: CSSProperties = { height: '100%', overflowY: 'auto' };

  // ── 已连接 ─────────────────────────────────────
  if (shown) {
    return (
      <div style={{ ...pageStyle, display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'flex-start' }}>
      <div className="hud-panel" style={{ maxWidth: 520, width: '100%', padding: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <ShieldCheck size={26} style={{ color: 'var(--ok)' }} />
          <span
            className="hud-label"
            style={{ color: 'var(--ok)', fontSize: 'var(--fs-12)' }}
          >
            LINK ESTABLISHED
          </span>
        </div>

        <h2 style={{ margin: '14px 0 4px', fontSize: 'var(--fs-24)' }}>已连接</h2>
        <p style={{ color: 'var(--text-dim)', fontSize: 'var(--fs-13)', marginTop: 0 }}>
          凭证已用 Windows DPAPI 加密,只存在本机。
        </p>

        <div
          style={{
            display: 'flex',
            gap: 18,
            padding: '12px 0',
            borderTop: '1px solid var(--rule)',
            borderBottom: '1px solid var(--rule)',
            margin: '16px 0',
          }}
        >
          <div>
            <div className="hud-label">账号</div>
            <div style={{ fontSize: 'var(--fs-15)', marginTop: 3 }}>{shown.uname || '—'}</div>
          </div>
          <div>
            <div className="hud-label">UID</div>
            <div className="num" style={{ fontSize: 'var(--fs-15)', marginTop: 3, color: 'var(--accent)' }}>
              {shown.mid}
            </div>
          </div>
        </div>

        <Button
          onClick={() => {
            setStatus('idle');
            setAccount(null);
            setReauthor(true);
          }}
        >
          重新授权
        </Button>
      </div>

      {/* 模型管理跟授权同一页 —— 都是"这台机器怎么跟外面说话"的配置。
          模型管理:凭证 / 条目 / 用途分配三层(2026-09-17 重构) */}
      <ModelManager />
      </div>
    );
  }

  // ── 未授权 ─────────────────────────────────────
  return (
    <div style={{ ...pageStyle, display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'flex-start' }}>
    <div className="hud-panel" style={{ maxWidth: 620, width: '100%', padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <KeyRound size={18} style={{ color: 'var(--accent)' }} />
        <span className="hud-label" style={{ color: 'var(--accent)', fontSize: 'var(--fs-12)' }}>
          AUTHORIZATION
        </span>
      </div>

      <h1 style={{ margin: '6px 0 8px', fontSize: 'var(--fs-24)' }}>授权 bilibili</h1>
      <p style={{ color: 'var(--text-dim)', fontSize: 'var(--fs-13)', lineHeight: 1.7 }}>
        收藏管家需要你的登录态才能读取收藏夹。<strong style={{ color: 'var(--text)' }}>凭证只发往
        bilibili、只存本机、并用 Windows DPAPI 加密</strong> —— 不会上传到任何第三方。
      </p>

      <div className="hud-label" style={{ margin: '18px 0 6px' }}>
        在浏览器里 F12 → Network → 右键任意请求 → Copy as cURL,整段粘进来
      </div>

      <Input.TextArea
        rows={7}
        // 别让浏览器往里填东西 —— 这一页现在还有 API Key 密码框,
        // 自动填充会把"看起来像用户名的框"填成保存的用户名
        autoComplete="off"
        value={cookie}
        onChange={(e) => setCookie(e.target.value)}
        placeholder="SESSDATA=...; bili_jct=...   或整段 cURL"
        style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-12)' }}
      />

      <div
        style={{
          marginTop: 14,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <Button
          type="primary"
          onClick={handleValidate}
          disabled={!cookie.trim()}
          loading={status === 'loading'}
        >
          验证并保存
        </Button>
        <span className="hud-label">保存前会真实调用一次 bilibili 校验登录态</span>
      </div>

      {status === 'error' && (
        <Alert type="error" message={error} style={{ marginTop: 14 }} showIcon />
      )}
    </div>

    {/* 没授权也能配模型 —— 两件事互不依赖 */}
    <ModelManager />
    </div>
  );
}
