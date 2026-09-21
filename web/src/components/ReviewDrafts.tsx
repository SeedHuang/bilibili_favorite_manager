import { App as AntApp, Button, Tooltip } from 'antd';
import { Check, Pencil, Sparkles, X } from 'lucide-react';
import { proposalsApi, reviewsApi } from '../api';
import type { ProposalDraftView, ReviewDraftView, RuleCondition, RuleField } from '../types';

/** 条件字段名 —— 审查草稿的 rule 条件也用它显示(与 FolderRuleSection 同口径) */
const FIELD_LABEL: Record<RuleField, string> = {
  title: '标题', intro: '简介', upper: 'UP 名', tag: '标签',
};

const renderCond = (conditions: RuleCondition[] | null): string =>
  (conditions ?? [])
    .filter((c) => c.any.some((k) => k))
    .map((c) => `${FIELD_LABEL[c.field] ?? c.field}含 ${c.any.join('·')}`)
    .join('  ·  ') || '(没给条件)';

const KIND_LABEL: Record<ReviewDraftView['kind'], string> = {
  rule: '规则', merge: '合并', delete: '删除',
};

/**
 * 草稿区 —— 两类草稿混合显示(spec §6):生成草稿(「生成方案」给的**新夹子**)
 * + 审查草稿(「审查勾选的夹子」给的**规则/合并/删除**)。来源不同,用标签区分。
 *
 * 按钮**自己调 API**、成功后回调 `onChanged` 让父层刷数据(proposal + review 一起重拉)。
 * 「改一下」(rule 草稿)= 先采纳、再展开该夹子的规则行(`onEditRule`)。
 */
export default function DraftsArea({
  drafts,
  reviewDrafts,
  busy,
  onChanged,
  onEditRule,
  onProposalAdopt,
  onReviewAdoptAll,
  onProposalAdoptAll,
}: {
  drafts: ProposalDraftView[];
  reviewDrafts: ReviewDraftView[];
  busy: boolean;
  /** 任一草稿动作成功后调用 —— 父层据此重拉方案/审查数据 */
  onChanged: () => void;
  /** 「改一下」(rule 草稿)= 先采纳再展开该夹子规则行;审查 rule 草稿「采纳」同样用它展开 */
  onEditRule: (folderId: number) => void;
  /** 生成草稿逐个「采纳」成功后 —— 带新夹子 id(默认勾上 + 展开规则行,Task 10 bug 修复) */
  onProposalAdopt?: (folderId: number) => void;
  /** 全部采纳(仅规则)成功后回调 —— 自动对同一勾选范围跑一次整理(spec §5 闭环) */
  onReviewAdoptAll?: () => void;
  /** 全部采纳(生成)成功后回调 —— 带新采纳夹子 id(默认勾上 + 自动整理,spec 拍板 8) */
  onProposalAdoptAll?: (folderIds: number[]) => void;
}) {
  const { modal } = AntApp.useApp();
  const pendingDrafts = drafts.filter((d) => d.status === 'pending');
  const pendingReviews = reviewDrafts.filter((d) => d.status === 'pending');
  if (pendingDrafts.length === 0 && pendingReviews.length === 0) return null;

  /** 草稿动作统一收口:成功后 onChanged(父层刷数据);失败也刷一次,让屏上回到服务端真实状态 */
  const doAction = (fn: () => Promise<unknown>) =>
    fn()
      .then(onChanged)
      .catch((e) => {
        console.error('[草稿区] 操作失败', e);
        onChanged();
      });

  return (
    <div className="hud-panel" style={{ padding: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span className="hud-label">草稿区</span>
        <span style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>
          生成方案给<span style={{ color: 'var(--ai)' }}>新夹子</span>草稿;审查勾选的夹子给
          <span style={{ color: 'var(--ai)' }}>规则/合并/删除</span>草稿 —— 两类来源不同
        </span>
      </div>

      {pendingDrafts.length > 0 && (
        <>
          <div
            className="hud-label"
            style={{ fontSize: 11, color: 'var(--ai)', padding: '4px 4px 2px' }}
          >
            生成草稿
          </div>
          {pendingDrafts.map((d) => (
            <div
              key={`draft-${d.id}`}
              style={{ borderBottom: '1px solid var(--rule)', background: 'rgba(120,119,255,0.06)' }}
            >
              <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '7px 4px' }}>
                <span style={{ width: 150, flex: 'none', display: 'flex', alignItems: 'center', gap: 5, fontSize: 'var(--fs-13)' }}>
                  {/* 草稿标 —— 一眼区分草稿与真夹子 */}
                  <Tooltip title="AI 方案草稿 —— 采纳后变成真夹子">
                    <Sparkles size={12} style={{ color: 'var(--ai)', flex: 'none' }} />
                  </Tooltip>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</span>
                </span>
                <span style={{ flex: 1, minWidth: 0, fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>
                  {d.reason || '(AI 没给理由)'}
                  {d.weak && <span style={{ color: 'var(--warning, #d4a017)' }}> · ⚠ 规则偏弱:概念压了很多条目,关键词捞不满</span>}
                </span>
                <span className="num" style={{ width: 64, flex: 'none', textAlign: 'right', fontSize: 'var(--fs-12)', color: 'var(--accent)' }}>
                  {d.hitCount}
                </span>
                <span style={{ width: 44, flex: 'none', textAlign: 'center', fontSize: 12 }}>
                  <span style={{ color: 'var(--ai)' }}>🤖</span>
                </span>
                <span style={{ width: 68, flex: 'none' }} />
              </div>
              {/* 证据行:样本标题 */}
              <div style={{ padding: '0 4px 8px 26px', fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>
                {d.sampleTitles.length > 0 && <div style={{ marginBottom: 4 }}>命中样本:{d.sampleTitles.slice(0, 5).join(' / ')}</div>}
                <Button size="small" type="primary" icon={<Check size={12} />} disabled={busy}
                  onClick={() => doAction(async () => {
                    const r = await proposalsApi.adopt(d.id);
                    // 采纳后:新夹子默认勾上 + 展开它的规则行(Task 10 bug 修复)
                    onProposalAdopt?.(r.folderId);
                  })}>
                  采纳
                </Button>
                <Button size="small" icon={<Pencil size={12} />} disabled={busy}
                  onClick={() => {
                    modal.confirm({
                      title: '改名后采纳',
                      content: (
                        <input id="draft-rename" defaultValue={d.name}
                          style={{ width: '100%', padding: 6, border: '1px solid var(--rule)', borderRadius: 4 }} />
                      ),
                      okText: '采纳', cancelText: '算了',
                      onOk: async () => {
                        const el = document.getElementById('draft-rename') as HTMLInputElement | null;
                        await doAction(async () => {
                          const r = await proposalsApi.adopt(d.id, el?.value ?? undefined);
                          onProposalAdopt?.(r.folderId);
                        });
                      },
                    });
                  }}>
                  改名采纳
                </Button>
                <Button size="small" type="text" danger icon={<X size={12} />} disabled={busy}
                  onClick={() => doAction(() => proposalsApi.discard(d.id))}>
                  丢弃
                </Button>
              </div>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '6px 4px 2px' }}>
            <Button size="small" icon={<Check size={12} />} disabled={busy}
              onClick={() => doAction(async () => {
                const r = await proposalsApi.adoptAll();
                // 新采纳的夹子默认勾上 + 自动整理(spec 拍板 8)
                onProposalAdoptAll?.(r.results.map((x) => x.folderId));
              })}>
              全部采纳
            </Button>
            <Button size="small" type="text" danger icon={<X size={12} />} disabled={busy}
              onClick={() => doAction(() => proposalsApi.discardAll())}>
              全部丢弃
            </Button>
          </div>
        </>
      )}

      {pendingReviews.length > 0 && (
        <>
          <div
            className="hud-label"
            style={{ fontSize: 11, color: 'var(--ai)', padding: pendingDrafts.length > 0 ? '10px 4px 2px' : '4px 4px 2px' }}
          >
            审查草稿
          </div>
          {pendingReviews.map((d) => (
            <div
              key={`review-${d.id}`}
              style={{ borderBottom: '1px solid var(--rule)', background: 'rgba(120,119,255,0.04)' }}
            >
              <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', padding: '7px 4px' }}>
                <span style={{ width: 170, flex: 'none', display: 'flex', alignItems: 'center', gap: 5, fontSize: 'var(--fs-13)' }}>
                  <span
                    className="hud-label"
                    style={{
                      fontSize: 10, color: 'var(--ai)', border: '1px solid var(--ai)', padding: '0 3px', borderRadius: 2, flex: 'none',
                    }}
                  >
                    {KIND_LABEL[d.kind]}
                  </span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {d.kind === 'rule' && (d.folderName ?? `夹子 ${d.folderId}`)}
                    {d.kind === 'merge' && `${d.folderName ?? `夹子 ${d.folderId}`} → ${d.intoName ?? `夹子 ${d.intoId}`}`}
                    {d.kind === 'delete' && `删除 ${d.folderName ?? `夹子 ${d.folderId}`}`}
                  </span>
                </span>
                <span style={{ flex: 1, minWidth: 0, fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>
                  {d.kind === 'rule' && <div>{renderCond(d.conditions)}</div>}
                  {d.because && <div style={{ lineHeight: 1.6 }}>{d.because}</div>}
                </span>
                <span style={{ width: 68, flex: 'none' }} />
              </div>
              <div style={{ padding: '0 4px 8px 26px', fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>
                <Button size="small" type="primary" icon={<Check size={12} />} disabled={busy}
                  onClick={() => doAction(async () => {
                    await reviewsApi.adopt(d.id);
                    // 审查 rule 草稿采纳后:展开该夹子规则行(Task 10 bug 修复)
                    if (d.kind === 'rule') onEditRule(d.folderId);
                  })}>
                  采纳
                </Button>
                {d.kind === 'rule' && (
                  <Button size="small" icon={<Pencil size={12} />} disabled={busy}
                    onClick={() => doAction(async () => {
                      await reviewsApi.adopt(d.id);
                      onEditRule(d.folderId); // 先采纳、再就地展开该夹子规则行
                    })}>
                    改一下
                  </Button>
                )}
                <Button size="small" type="text" danger icon={<X size={12} />} disabled={busy}
                  onClick={() => doAction(() => reviewsApi.discard(d.id))}>
                  丢弃
                </Button>
              </div>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', padding: '6px 4px 2px' }}>
            <Button size="small" icon={<Check size={12} />} disabled={busy}
              onClick={() => doAction(async () => {
                await reviewsApi.adoptAll();
                // merge/delete 破坏性,必须逐条确认 —— 批量只采纳 rule,采纳后自动整理(spec §5 闭环)
                onReviewAdoptAll?.();
              })}>
              全部采纳(仅规则)
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
