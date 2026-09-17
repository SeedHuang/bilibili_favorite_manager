import { useSearchParams } from '@umijs/max';
import RulesPanel from '../components/RulesPanel';

/**
 * /rules 规则 —— **和「整理」同级的顶级 tab**。
 *
 * 为什么不挂在 /curator 底下当子 tab:规则是这产品唯一比 B站 多的东西
 * (bilibili 有夹子但没有逻辑,谁进谁出全靠手),子 tab 是把它当附属品。
 */
export default function RulesPage() {
  // ?folder=<workFolderId> —— 从「整理」的夹子行跳过来时直接展开那一行(Task 13)
  const [params] = useSearchParams();
  const folder = Number(params.get('folder'));
  const focus = Number.isInteger(folder) && folder > 0 ? folder : null;

  return (
    <div style={{ height: '100%', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span className="hud-label" style={{ color: 'var(--accent)' }}>规则</span>
        <span style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>
          夹子只是个筐;规则决定谁该进去。它只存在本地,不上传 B站
        </span>
      </div>
      <RulesPanel focusFolderId={focus} />
      <div style={{ height: 56, flex: 'none' }} aria-hidden />
    </div>
  );
}
