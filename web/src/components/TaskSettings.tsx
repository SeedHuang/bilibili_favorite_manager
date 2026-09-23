import { useEffect, useState } from 'react';
import { Alert, App as AntApp, Input, Select } from 'antd';
import { SlidersHorizontal } from 'lucide-react';
import { AiSettingsProvider, EntryCard, ProviderCard, PurposeCard } from '@SeedHuang/ai/react';
import { API_BASE, settingsApi } from '../api';
import type { PollsMap } from '../types';

/**
 * 任务设置:三层(服务商凭证 → 模型条目 → 任务行)。
 * 每个任务行 = AI 模型 + 轮询间隔 + 批次大小(模型只是三件套之一,spec 2026-09-20 §4.3)。
 *
 * 前两层 + 用途分配这一层由 `@SeedHuang/ai/react` 的三卡(`ProviderCard` /
 * `EntryCard` / `PurposeCard`)承担 —— 它们自带数据拉取,靠 `AiSettingsProvider`
 * 的 baseURL 直连后端(`API_BASE`,不走 umi 代理)。
 *
 * **轮询/批次留在这里自绘** —— 它是 BFM 自己的设置(`settings.poll.<taskType>.*`),
 * AI 套件不认;"模型怎么配"与"任务怎么跑"是两件事,套件只管前者。
 *
 * 用途之间平级,`tag` 没配就是"未配置",不回落主模型 —— 那正是"以为在烧本地 4b,
 * 实际每批都在打贵的主模型"的来源。
 */
export default function TaskSettings() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span className="hud-label" style={{ color: 'var(--accent)' }}>
          任务设置
        </span>
        <span style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>
          每个任务:AI 模型 / 轮询间隔 / 批次大小
        </span>
      </div>
      <AiSettingsProvider baseURL={API_BASE}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <ProviderCard />
          <EntryCard />
          <PurposeCard />
        </div>
      </AiSettingsProvider>
      <PollCard />
    </div>
  );
}

// ── 轮询/批次卡(BFM 自绘:改的是 settings.poll.<taskType>.*)────

/** 有轮询/批次可配的任务 —— purpose 名即 taskType(spec §4.3) */
const POLL_PURPOSES = ['tag', 'tagcheck', 'proposals'] as const;
type PollPurpose = (typeof POLL_PURPOSES)[number];

/** 用途中文名 —— 与 server / 包内 PurposeCard 的四个 label 语义一致(这里只用后三个) */
const PURPOSE_LABELS: Record<PollPurpose, string> = {
  tag: '打标',
  tagcheck: '标签质检',
  proposals: '夹子方案生成', // 与 server PURPOSE_LABELS 同名(报错文案里出现的是那个)
};

const INTERVAL_OPTIONS = [1000, 2000, 3000, 5000, 10000].map((v) => ({
  value: v,
  label: `${v / 1000}s`,
}));

const CUSTOM_BATCH = 'custom';
const BATCH_OPTIONS: { value: number | typeof CUSTOM_BATCH; label: string }[] = [
  ...[1, 2, 5, 10, 20, 30, 40, 50].map((v) => ({ value: v, label: String(v) })),
  { value: CUSTOM_BATCH, label: '自定义…' },
];

function PollCard() {
  /** 各任务的轮询/批次配置;null = 还没拉到(下拉占位,不阻塞渲染) */
  const [polls, setPolls] = useState<PollsMap | null>(null);
  const [pollsErr, setPollsErr] = useState('');
  /** 保存失败的红条;成功才动本地 polls(spec §5:失败不改 state) */
  const [pollErr, setPollErr] = useState('');
  const [pollSaving, setPollSaving] = useState(false);
  // 静态 Modal.confirm 拿不到 ConfigProvider 的主题,必须走 App.useApp()(照 TagPanel)
  const { modal } = AntApp.useApp();

  useEffect(() => {
    // 自己拉 —— 拉失败红条,但不挡上面的模型配置(两件事互不依赖,spec §5)
    settingsApi
      .getPolls()
      .then(setPolls)
      .catch((e) => setPollsErr((e as Error).message));
  }, []);

  /**
   * 改轮询间隔。**上游裁决:tag/tagcheck 必须带数值 batch** —— HTTP 层没有
   * batch=null 恢复默认的路径,漏发 batch 会被路由 400;proposals 无批次语义,
   * 只发 intervalMs(server 那头也忽略 batch)。
   */
  const changeInterval = async (taskType: PollPurpose, v: number) => {
    const cur = polls?.[taskType];
    if (!polls || !cur) return;
    setPollSaving(true);
    setPollErr('');
    try {
      if (taskType === 'proposals') {
        // proposals 无批次语义,server 侧忽略 batch 字段 —— 传 null 与省略等价,这里显式传
        await settingsApi.setPoll(taskType, { intervalMs: v, batch: null });
      } else {
        // readPoll 对这两个任务恒返回数值 batch,null 只在类型上存在;真遇到就别写,防冲库
        if (typeof cur.batch !== 'number') return;
        await settingsApi.setPoll(taskType, { intervalMs: v, batch: cur.batch });
      }
      setPolls({ ...polls, [taskType]: { ...cur, intervalMs: v } });
    } catch (e) {
      setPollErr((e as Error).message);
    } finally {
      setPollSaving(false);
    }
  };

  /** 改批次(只有 tag/tagcheck 有此列)。间隔带上当前值,同理防把已存档位冲掉 */
  const changeBatch = async (taskType: 'tag' | 'tagcheck', v: number) => {
    const cur = polls?.[taskType];
    if (!polls || !cur) return;
    setPollSaving(true);
    setPollErr('');
    try {
      await settingsApi.setPoll(taskType, { intervalMs: cur.intervalMs, batch: v });
      setPolls({ ...polls, [taskType]: { ...cur, batch: v } });
    } catch (e) {
      setPollErr((e as Error).message);
    } finally {
      setPollSaving(false);
    }
  };

  /**
   * 「自定义…」弹非受控 Input 取 1~500 的整数。
   * 非受控是照 TagPanel confirmClearTags 的坑改的:value 绑闭包变量的话,modal
   * 重渲染会把输入框打回初始值,用户打的字被 React 还原。
   */
  const customBatch = (taskType: 'tag' | 'tagcheck') => {
    let typed = '';
    const inst = modal.confirm({
      title: '自定义批次大小',
      content: (
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 8 }}>
            1~500 的整数。批次大小在下次启动任务时生效。
          </div>
          <Input
            autoFocus
            placeholder="1~500"
            onChange={(e) => {
              typed = e.target.value;
              const n = Number(typed);
              const ok = typed.trim() !== '' && Number.isInteger(n) && n >= 1 && n <= 500;
              // HookModal.update 顶层浅合并,okButtonProps 整体替换 —— 照 TagPanel 的注释
              inst.update({ okButtonProps: { disabled: !ok } });
            }}
            style={{ width: '100%' }}
          />
        </div>
      ),
      okText: '保存',
      okButtonProps: { disabled: true },
      cancelText: '算了',
      onOk: () => changeBatch(taskType, Number(typed)),
    });
  };

  return (
    <Card
      icon={<SlidersHorizontal size={16} style={{ color: 'var(--accent)' }} />}
      title="轮询与批次"
      hint="每个任务各有自己的节奏;改动即保存"
    >
      {POLL_PURPOSES.map((tt) => {
        const cur = polls?.[tt];
        return (
          <Field key={tt} label={PURPOSE_LABELS[tt]}>
            <span style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)', marginLeft: 14 }}>
              轮询
            </span>
            <Select<number>
              id={`llm-${PURPOSE_LABELS[tt]}-轮询`}
              value={cur?.intervalMs}
              onChange={(v) => void changeInterval(tt, v)}
              options={INTERVAL_OPTIONS}
              disabled={!cur || pollSaving}
              placeholder={cur ? undefined : '读取中…'}
              style={{ width: 84, marginLeft: 8 }}
            />
            <span style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)', marginLeft: 14 }}>
              批次
            </span>
            {tt === 'proposals' ? (
              // proposals 一次 LLM 调用,无批次语义(spec §0 修正 1)—— 只占位不给下拉
              <span style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)', marginLeft: 8 }}>
                —
              </span>
            ) : (
              <Select<number | typeof CUSTOM_BATCH>
                id={`llm-${PURPOSE_LABELS[tt]}-批次`}
                value={cur?.batch ?? undefined}
                onChange={(v) => {
                  if (v === CUSTOM_BATCH) customBatch(tt);
                  else void changeBatch(tt, v);
                }}
                options={BATCH_OPTIONS}
                disabled={!cur || pollSaving}
                placeholder={cur ? undefined : '读取中…'}
                style={{ width: 104, marginLeft: 8 }}
              />
            )}
          </Field>
        );
      })}
      <span style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>
        轮询间隔对已打开页面在下次进入该页时生效;批次大小下次启动任务时生效
      </span>
      {pollsErr && (
        <Alert
          type="error"
          showIcon
          message={`拉取轮询配置失败:${pollsErr}`}
          closable
          onClose={() => setPollsErr('')}
        />
      )}
      {pollErr && (
        <Alert type="error" showIcon message={pollErr} closable onClose={() => setPollErr('')} />
      )}
    </Card>
  );
}

/** 卡片外壳 + 标题行(与包内 Card 同形 —— 包没导出它,自绘这张卡照抄最小必要部分) */
function Card({
  icon,
  title,
  hint,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="hud-panel" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {icon}
        <span className="hud-label" style={{ color: 'var(--accent)' }}>
          {title}
          <span style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)', marginLeft: 8 }}>
            {hint}
          </span>
        </span>
      </div>
      {children}
    </div>
  );
}

/**
 * 用真 `<label for>` 而不是旁边放个 span。
 *
 * 两个原因,第二个是踩过的坑:
 * 1. 无障碍 —— 屏幕阅读器要靠 label 才知道这个输入框是干什么的
 * 2. **浏览器自动填充** —— 一个没有标注的文本框紧挨着密码框,Chrome 会按
 *    "用户名 + 密码"的启发式把它填成保存的用户名(实测被填成了 Windows 用户名),
 *    然后这个值就被当成接口地址发出去
 */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  // 中英文都保留,其余字符(空格、斜杠)压成连字符,好当 id 用
  const id = `llm-${label.replace(/[^\w一-龥]+/g, '-')}`;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
      <label htmlFor={id} className="hud-label" style={{ width: 92, flex: 'none' }}>
        {label}
      </label>
      <span style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 0 }}>{children}</span>
    </div>
  );
}
