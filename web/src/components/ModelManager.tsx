import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Input, Select, Alert } from 'antd';
import { Zap, KeyRound, SlidersHorizontal, Save, RefreshCw } from 'lucide-react';
import { llmApi } from '../api';
import type { EntryView, LlmPurpose, ModelMeta, ProviderView } from '../types';

/**
 * 模型管理:三层(服务商凭证 → 模型条目 → 用途分配)。
 * spec 2026-09-17-model-config-redesign —— 每层一张卡,配置只下沉不回落。
 *
 * 旧的 `purpose='main'|'tag'` 两卡设计(DEFAULT 逐项回落)已废弃:用途之间现在平级,
 * `tag` 没配就是"未配置",不再偷偷沿用主模型 —— 那正是"以为在烧本地 4b,实际每批
 * 都在打贵的主模型"的来源。
 */
const PROVIDERS = [
  { value: 'ollama', label: '本地 Ollama', hint: '隐私 / 离线主力,默认 qwen2.5:14b' },
  { value: 'ark', label: '火山方舟', hint: 'Coding Plan / 豆包 / Kimi / GLM' },
  { value: 'deepseek', label: 'DeepSeek', hint: '普通 API' },
  { value: 'minimax', label: 'MiniMax', hint: '直连' },
  { value: 'custom', label: '自定义', hint: '任何 OpenAI 兼容端点' },
];

export default function ModelManager() {
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [entries, setEntries] = useState<EntryView[]>([]);
  const [assignments, setAssignments] = useState<Record<LlmPurpose, string | null> | null>(null);

  const reload = useCallback(async () => {
    const [p, e, a] = await Promise.all([
      llmApi.providers(),
      llmApi.entries(),
      llmApi.assignments(),
    ]);
    setProviders(p);
    setEntries(e);
    setAssignments(a);
  }, []);

  useEffect(() => {
    reload().catch(() => {});
  }, [reload]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, width: '100%' }}>
      <ProviderCard providers={providers} onDone={reload} />
      <EntryCard providers={providers} entries={entries} onDone={reload} />
      <AssignCard entries={entries} assignments={assignments} onDone={reload} />
    </div>
  );
}

/**
 * 拉某个服务商的模型名。
 *
 * ollama 走本地实时接口 —— 用户装了什么只有 Ollama 自己知道(spec §3)。在这一层就把
 * 形状统一成 ModelMeta,后面的代码不用认识两种模型对象;其余走厂商 `/models`:
 * **名字实时从厂商拉**(它才知道自己现在服务哪些模型),数字由服务端查注册表。
 *
 * 厂商拉不到(还没填 key / 网络不通 / 端点不实现 /models)就退回内置那张表,并把
 * "为什么"用 `note` 带回去 —— 别让下拉直接空掉,那样用户连"该干什么"都看不出来。
 * ollama 拉不到是**硬失败**(throw),调用方自己接。
 *
 * apiKey 只在调用时读,不进任何依赖 —— 旧版实测:放进依赖会让用户每敲一个字符就发
 * 一次拉列表的请求。
 */
async function fetchModels(
  provider: string,
  baseUrl: string,
  apiKey: string,
): Promise<{ models: ModelMeta[]; note: string }> {
  if (provider === 'ollama') {
    const res = await fetch(
      `/api/settings/ollama-models?baseUrl=${encodeURIComponent(baseUrl)}`,
    );
    const body = (await res.json()) as {
      models?: { name: string; contextWindow: number; maxOutput: number; detail?: string }[];
      reason?: string;
    };
    if (!res.ok) throw new Error(body.reason ?? '拉取本地模型失败');
    return {
      models: (body.models ?? []).map((m) => ({
        provider: 'ollama',
        model: m.name,
        contextWindow: m.contextWindow,
        maxOutput: m.maxOutput,
        // 本地模型的值是 Ollama 自己报的,不是我们猜的
        verified: true,
        ...(m.detail ? { note: m.detail } : {}),
      })),
      note: '',
    };
  }

  try {
    return { models: await llmApi.listRemoteModels({ provider, baseUrl, apiKey }), note: '' };
  } catch (e) {
    return {
      models: await llmApi.listModels(provider),
      note:
        `拉不到厂商的模型列表:${(e as Error).message}。先显示内置的那几个 —— ` +
        `填上 API Key 再点「刷新」,或在下面直接打模型名。`,
    };
  }
}

/** 卡片外壳 + 标题行(旧 Zap 标题的样式,图标按卡片换) */
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
 * 模型名下拉 + 刷新。**tags 模式是为了能自由输入模型名。** 厂商拉不到时(还没填 key)
 * 下拉可能只有内置那几个,「自定义」端点更是一个都没有 —— 而"想用的模型不在表里"是
 * 最正常不过的事。maxCount=1 让它在语义上仍然是单选,value/onChange 在这里做
 * 数组↔字符串的转换,别处看到的还是 `model: string`。
 */
function ModelPicker({
  id,
  models,
  value,
  onChange,
  busy,
  onRefresh,
}: {
  id: string;
  models: ModelMeta[];
  value: string;
  onChange: (v: string) => void;
  busy: boolean;
  onRefresh: () => void;
}) {
  return (
    <>
      <Select
        id={id}
        mode="tags"
        maxCount={1}
        value={value ? [value] : []}
        onChange={(v: string[]) => onChange(v[0] ?? '')}
        placeholder={busy ? '拉取中…' : '选一个,或直接打模型名'}
        optionFilterProp="label"
        style={{ width: 320 }}
        options={models.map((m) => ({
          value: m.model,
          label: m.note ? `${m.model} · ${m.note}` : m.model,
        }))}
      />
      <Button
        size="small"
        icon={<RefreshCw size={13} />}
        loading={busy}
        onClick={onRefresh}
        style={{ marginLeft: 8 }}
      >
        刷新
      </Button>
    </>
  );
}

/**
 * 退回内置表的软提示。**不能是灰字。** 退回内置表和"厂商就这几个模型"在界面上长得
 * 太像了 —— 用户会以为列表是拉出来的,于是问"为什么还是那两个老的"(真实反馈)。
 * 用和旁边 ⚠️ 待确认同一套 warn 色,让"这是兜底的,不是厂商说的"一眼可见。
 */
function ModelsNote({ note }: { note: string }) {
  if (!note) return null;
  return (
    <div style={{ fontSize: 'var(--fs-12)', color: 'var(--warn)', lineHeight: 1.6 }}>
      ⚠️ {note}
    </div>
  );
}

// ── 卡 1:服务商凭证 ─────────────────────────────────────

function ProviderCard({
  providers,
  onDone,
}: {
  providers: ProviderView[];
  onDone: () => Promise<void>;
}) {
  const [provider, setProvider] = useState('ollama');
  const [baseUrl, setBaseUrl] = useState('');
  /** 用户动过 baseUrl 没有。没动过又不是新建 → **不带**这个字段,免得把已存端点冲空 */
  const [baseUrlTouched, setBaseUrlTouched] = useState(false);
  const [apiKey, setApiKey] = useState('');
  /** 镜像最新的 apiKey —— loadModels 的 useCallback 依赖里不放 apiKey(否则每敲一个字符就重拉),
   *  但闭包读的是旧值,导致「填上 Key 再点刷新」永远带空 Key。读 ref 即拿最新值。 */
  const apiKeyRef = useRef('');
  apiKeyRef.current = apiKey;
  const [editingId, setEditingId] = useState<string | null>(null);

  const [models, setModels] = useState<ModelMeta[]>([]);
  /** 测试连接要个模型名 —— 不落库,只喂给 test-llm */
  const [model, setModel] = useState('');
  const [modelsNote, setModelsNote] = useState('');
  const [busy, setBusy] = useState<'' | 'models' | 'save' | 'test'>('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const loadModels = useCallback(
    async (p: string) => {
      setError('');
      setModelsNote('');
      setBusy('models');
      try {
        const r = await fetchModels(p, baseUrl, apiKeyRef.current);
        setModels(r.models);
        setModelsNote(r.note);
      } catch (e) {
        setModels([]);
        setError((e as Error).message);
      } finally {
        setBusy('');
      }
    },
    // 同 fetchModels:apiKey 故意不在这里 —— 靠 apiKeyRef.current 取最新值,所以这份缓存不会
    // 因为用户改 Key 而重建(避免每敲一个字符就重拉)
    [baseUrl],
  );

  useEffect(() => {
    void loadModels(provider);
  }, [provider, loadModels]);

  /**
   * 换服务商 = 换端点 + 换模型名空间,所以上一家的这两项**必须清掉**。
   *
   * 不清 baseUrl 的后果是实测出来的:本地 Ollama 的模型发现会把它当根地址用,
   * 于是留着 deepseek 的地址就去问 deepseek 要 /api/tags(401)→ 前端 catch 里
   * `setModels([])` → **下拉直接空掉**,而报错还说"确认 Ollama 正在运行" ——
   * 明明它在跑,极其误导。
   *
   * (旧的另一个坑 —— 换服务商留着上一家 1024000 的上下文数字 —— 随三层重构消失:
   * 数字现在由服务端按条目算,前端不存。)
   */
  const changeProvider = (p: string) => {
    if (p === provider) return;
    setProvider(p);
    setBaseUrl('');
    setBaseUrlTouched(true);
    setModel('');
  };

  const startEdit = (p: ProviderView) => {
    setError('');
    setNotice('');
    setEditingId(p.id);
    setProvider(p.provider);
    setBaseUrl(p.baseUrl);
    setBaseUrlTouched(false);
    setApiKey('');
    setModel('');
  };

  const cancelEdit = () => {
    setEditingId(null);
    setApiKey('');
    setBaseUrl('');
    setBaseUrlTouched(false);
    setModel('');
  };

  const save = async () => {
    setError('');
    setNotice('');
    setBusy('save');
    try {
      await llmApi.saveProvider({
        ...(editingId ? { id: editingId } : {}),
        provider,
        // baseUrl:只有用户改过、或新建才带。不带 = 服务端保留已存的那个
        ...(!editingId || baseUrlTouched ? { baseUrl } : {}),
        // 留空 = 不改动已存的 key(用户不用每次重打)
        ...(apiKey ? { apiKey } : {}),
      });
      setNotice(editingId ? '凭证已更新。' : '凭证已保存。');
      setApiKey('');
      setEditingId(null);
      setBaseUrlTouched(false);
      // 新建后把 provider/baseUrl 一并归零 —— 只留着的后果是连点两次「保存」
      // 会建出两条一模一样的凭证(实测过这类重复行,删起来还得分清哪条是哪条)
      if (!editingId) {
        setProvider('ollama');
        setBaseUrl('');
        setModel('');
      }
      await onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  const remove = async (id: string) => {
    setError('');
    setNotice('');
    try {
      await llmApi.deleteProvider(id);
      if (editingId === id) cancelEdit();
      await onDone();
    } catch (e) {
      // 400 的 reason 原样展示 —— "这条凭证还有模型条目在用"正是要让用户看到的
      setError((e as Error).message);
    }
  };

  const test = async () => {
    setError('');
    setNotice('');
    setBusy('test');
    try {
      const r = await llmApi.test({ provider, model, baseUrl, ...(apiKey ? { apiKey } : {}) });
      setNotice(`连接成功,模型回了一句:${r.reply}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  const providerHint = PROVIDERS.find((p) => p.value === provider)?.hint;
  const editingHasKey = !!(editingId && providers.find((p) => p.id === editingId)?.hasApiKey);

  return (
    <Card
      icon={<KeyRound size={16} style={{ color: 'var(--accent)' }} />}
      title="服务商凭证"
      hint="一个厂商一条。API Key 只发往该厂商、只存本机(DPAPI 加密)"
    >
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {providers.length === 0 && (
          <span style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>
            还没有凭证 —— 在下面建一条。
          </span>
        )}
        {providers.map((p) => (
          <div
            key={p.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '6px 0',
              borderBottom: '1px solid var(--rule)',
            }}
          >
            <span style={{ fontSize: 'var(--fs-13)' }}>{p.provider}</span>
            <span
              style={{
                fontSize: 'var(--fs-12)',
                color: 'var(--text-dim)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              {p.baseUrl || '默认地址'}
            </span>
            <span
              style={{
                fontSize: 'var(--fs-12)',
                color: p.hasApiKey ? 'var(--ok)' : 'var(--text-dim)',
              }}
            >
              {p.hasApiKey ? '已存 key' : '无 key'}
            </span>
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              <Button size="small" onClick={() => startEdit(p)}>
                编辑
              </Button>
              <Button size="small" danger onClick={() => void remove(p.id)}>
                删除
              </Button>
            </span>
          </div>
        ))}
      </div>

      <Field label="服务商">
        <Select
          id="llm-服务商"
          value={provider}
          onChange={changeProvider}
          options={PROVIDERS.map((p) => ({ value: p.value, label: p.label }))}
          // 编辑已存凭证时锁死 —— 换服务商类型会静默把条目改指到新类型上
          disabled={!!editingId}
          style={{ width: 260 }}
        />
        <span style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)', marginLeft: 10 }}>
          {providerHint}
        </span>
      </Field>

      <Field label="接口地址">
        <Input
          id="llm-接口地址"
          name="llm-base-url"
          // 不是凭证,明确告诉浏览器别填
          autoComplete="off"
          value={baseUrl}
          onChange={(e) => {
            setBaseUrl(e.target.value);
            setBaseUrlTouched(true);
          }}
          placeholder="留空用默认地址(custom 端点必填)"
          style={{ width: 420, fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-12)' }}
        />
      </Field>

      <Field label="API Key">
        <Input.Password
          id="llm-API-Key"
          name="llm-api-key"
          // new-password 让密码管理器别把它和上面的文本框配成"用户名+密码"
          autoComplete="new-password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={
            editingHasKey ? '已保存,留空表示不改动'
            : provider === 'ollama' ? '本地模型不需要'
            : '粘贴 API Key'
          }
          style={{ width: 420, fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-12)' }}
        />
      </Field>

      <Field label="测试模型">
        <ModelPicker
          id="llm-测试模型"
          models={models}
          value={model}
          onChange={setModel}
          busy={busy === 'models'}
          onRefresh={() => void loadModels(provider)}
        />
      </Field>

      <ModelsNote note={modelsNote} />

      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <Button
          type="primary"
          icon={<Save size={14} />}
          loading={busy === 'save'}
          disabled={!provider}
          onClick={save}
        >
          {editingId ? '保存修改' : '新建凭证'}
        </Button>
        <Button loading={busy === 'test'} disabled={!model} onClick={test}>
          测试连接
        </Button>
        {editingId && <Button onClick={cancelEdit}>取消编辑</Button>}
      </div>

      {notice && (
        <Alert type="success" showIcon message={notice} closable onClose={() => setNotice('')} />
      )}
      {error && <Alert type="error" showIcon message={error} closable onClose={() => setError('')} />}
    </Card>
  );
}

// ── 卡 2:模型条目 ───────────────────────────────────────

function EntryCard({
  providers,
  entries,
  onDone,
}: {
  providers: ProviderView[];
  entries: EntryView[];
  onDone: () => Promise<void>;
}) {
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [models, setModels] = useState<ModelMeta[]>([]);
  const [modelsNote, setModelsNote] = useState('');
  const [busy, setBusy] = useState<'' | 'models' | 'add'>('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const selected = providers.find((p) => p.id === providerId);

  const loadModels = useCallback(async () => {
    if (!selected) {
      setModels([]);
      setModelsNote('');
      return;
    }
    setError('');
    setModelsNote('');
    setBusy('models');
    try {
      // apiKey 传空 = 用这条凭证已存的 key(表单里从来拿不到明文)
      const r = await fetchModels(selected.provider, selected.baseUrl, '');
      setModels(r.models);
      setModelsNote(r.note);
    } catch (e) {
      setModels([]);
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  }, [selected]);

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  const add = async () => {
    setError('');
    setNotice('');
    setBusy('add');
    try {
      await llmApi.addEntry({ providerId, model });
      setNotice('条目已添加。首条会自动指给五个用途,可在下面那张卡改。');
      setModel('');
      await onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  const remove = async (id: string) => {
    setError('');
    setNotice('');
    try {
      await llmApi.deleteEntry(id);
      await onDone();
    } catch (e) {
      // 400 原样:"这个条目正被用途引用(...)—— 先在「用途分配」里改指别的条目"
      setError((e as Error).message);
    }
  };

  // 表里查得到就看它自己的 verified;查不到(手打的名字,或从厂商拉来但注册表没收录)
  // **就是未确认** —— 服务端给的那两个数字是兜底值,必须让用户核对:
  // 数字填错等于 batchSize 算错,要么批到超上下文,要么跑一整天(§3)。
  const chosen = models.find((m) => m.model === model);
  const unverified = chosen ? chosen.verified === false : !!model;

  return (
    <Card
      icon={<Zap size={16} style={{ color: 'var(--accent)' }} />}
      title="模型条目"
      hint="一个模型一条。上下文 / 最大输出由服务端按注册表算,前端不填"
    >
      <Field label="凭据">
        <Select
          id="llm-凭据"
          value={providerId || undefined}
          onChange={setProviderId}
          options={providers.map((p) => ({ value: p.id, label: p.provider }))}
          placeholder={providers.length ? '选一条凭证' : '先在上面建一条凭证'}
          disabled={providers.length === 0}
          style={{ width: 260 }}
        />
      </Field>

      <Field label="模型">
        <ModelPicker
          id="llm-模型"
          models={models}
          value={model}
          onChange={setModel}
          busy={busy === 'models'}
          onRefresh={() => void loadModels()}
        />
        {unverified && (
          <span style={{ marginLeft: 10, fontSize: 'var(--fs-12)', color: 'var(--warn)' }}>
            ⚠️ 这个模型的上下文是估算值,请核对
          </span>
        )}
      </Field>

      <ModelsNote note={modelsNote} />

      <div>
        <Button
          type="primary"
          disabled={!providerId || !model}
          loading={busy === 'add'}
          onClick={add}
        >
          添加条目
        </Button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {entries.length === 0 && (
          <span style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>
            还没有模型条目。
          </span>
        )}
        {entries.map((e) => (
          <div
            key={e.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '6px 0',
              borderBottom: '1px solid var(--rule)',
            }}
          >
            {!e.verified && <span style={{ color: 'var(--warn)' }}>⚠️</span>}
            <span style={{ fontSize: 'var(--fs-13)' }}>
              {e.provider} · {e.model}
            </span>
            <span className="num" style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>
              {Math.round(e.contextWindow / 1000)}K / {Math.round(e.maxOutput / 1000)}K
            </span>
            {!e.verified && e.note && (
              <span style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>{e.note}</span>
            )}
            <Button
              size="small"
              danger
              style={{ marginLeft: 'auto' }}
              onClick={() => void remove(e.id)}
            >
              删除
            </Button>
          </div>
        ))}
      </div>

      {notice && (
        <Alert type="success" showIcon message={notice} closable onClose={() => setNotice('')} />
      )}
      {error && <Alert type="error" showIcon message={error} closable onClose={() => setError('')} />}
    </Card>
  );
}

// ── 卡 3:用途分配 ───────────────────────────────────────

const PURPOSE_LABELS: Record<LlmPurpose, string> = {
  chat: '聊天',
  classify: '归类',
  rules: '规则建议',
  tag: '打标',
  tagcheck: '标签质检',
};

function AssignCard({
  entries,
  assignments,
  onDone,
}: {
  entries: EntryView[];
  assignments: Record<LlmPurpose, string | null> | null;
  onDone: () => Promise<void>;
}) {
  const [error, setError] = useState('');
  /** 变更进行中锁住全部下拉 —— 快速连改两次时旧响应会晚到,把界面刷回旧值 */
  const [saving, setSaving] = useState(false);

  if (assignments === null) {
    return (
      <Card
        icon={<SlidersHorizontal size={16} style={{ color: 'var(--accent)' }} />}
        title="用途分配"
        hint="五个用途平级,各自指一个条目;没配 = 未配置,不回落"
      >
        <p className="hud-label">加载中…</p>
      </Card>
    );
  }

  const options = [
    { value: '', label: '未配置' },
    ...entries.map((e) => ({ value: e.id, label: `${e.provider} · ${e.model}` })),
  ];

  const change = async (purpose: LlmPurpose, v: string) => {
    setError('');
    setSaving(true);
    try {
      await llmApi.setAssignments({ [purpose]: v || null });
      await onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      icon={<SlidersHorizontal size={16} style={{ color: 'var(--accent)' }} />}
      title="用途分配"
      hint="五个用途平级,各自指一个条目;没配 = 未配置,不回落"
    >
      {(Object.keys(PURPOSE_LABELS) as LlmPurpose[]).map((p) => (
        <Field key={p} label={PURPOSE_LABELS[p]}>
          <Select
            id={`llm-${PURPOSE_LABELS[p]}`}
            value={assignments[p] ?? ''}
            onChange={(v) => void change(p, v)}
            options={options}
            disabled={entries.length === 0 || saving}
            style={{ width: 320 }}
          />
        </Field>
      ))}
      {entries.length === 0 && (
        <span style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>
          先在上面加一个模型条目。
        </span>
      )}
      {error && <Alert type="error" showIcon message={error} closable onClose={() => setError('')} />}
    </Card>
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
