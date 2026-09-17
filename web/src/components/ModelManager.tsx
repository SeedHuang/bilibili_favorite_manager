import { useCallback, useEffect, useState } from 'react';
import { Button, Input, Select, InputNumber, Alert } from 'antd';
import { Zap, Save, RefreshCw } from 'lucide-react';
import { llmApi } from '../api';
import type { ModelMeta } from '../types';

/**
 * 模型管理(spec §3 / §11.4「授权」页)。
 *
 * 流程就是 §3 画的那条:选服务商 → 列该服务商的模型(本地 Ollama 实时拉)→
 * 选模型 → 自动填 contextWindow / maxOutput(可编辑)→ 标 ⚠️ 若未确认 →
 * 测试连接 → 保存。
 *
 * 前端标签页叫「授权」(`/auth`)而不是 spec 写的 `/settings` —— M3 已经建好了
 * 这个页面,模型管理挂在它下面,不新开一个 tab。
 */
const PROVIDERS = [
  { value: 'ollama', label: '本地 Ollama', hint: '隐私 / 离线主力,默认 qwen2.5:14b' },
  { value: 'ark', label: '火山方舟', hint: 'Coding Plan / 豆包 / Kimi / GLM' },
  { value: 'deepseek', label: 'DeepSeek', hint: '普通 API' },
  { value: 'minimax', label: 'MiniMax', hint: '直连' },
  { value: 'custom', label: '自定义', hint: '任何 OpenAI 兼容端点' },
];

/**
 * 模型配置卡片(§3)。`purpose='tag'` 渲染成「打标模型」——**底层与主模型共享**:
 * key / 接口地址留空就是"沿用主模型",后端读的时候逐项回落(见 llm/config.ts)。
 * 同一个组件跑两遍,别复制成第二个文件 —— 那才是两套迟早分叉的表单。
 */
export default function ModelManager({ purpose = 'main' }: { purpose?: 'main' | 'tag' }) {
  const isTag = purpose === 'tag';
  const [provider, setProvider] = useState('ollama');
  const [model, setModel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [contextWindow, setContextWindow] = useState<number | null>(null);
  const [maxOutput, setMaxOutput] = useState<number | null>(null);

  const [models, setModels] = useState<ModelMeta[]>([]);
  const [hasSavedKey, setHasSavedKey] = useState(false);
  const [busy, setBusy] = useState<'' | 'models' | 'test' | 'save'>('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  /** 拉不到厂商模型列表时的软提示 —— 不是失败(已经退回内置表了),所以不走红条 */
  const [modelsNote, setModelsNote] = useState('');

  // 载入已存配置
  useEffect(() => {
    llmApi
      .get(purpose)
      .then((s) => {
        // **只看 ownConfigured**:`configured` 是回落主模型之后的结果,
        // tag 卡没配过时它也是 true —— 拿它回填会把主模型的值冒充成"打标模型已配好"
        // (实测:baseUrl 被填成主模型的地址 → 改选 ollama 后本地模型列表直接空掉)。
        // 没配过就留空,让下面那几个「留空 = 沿用主模型」的占位符真正生效。
        //
        // `?? configured`:这个字段是跟前端一起加的,而服务端没有 watch —— 浏览器先刷新、
        // 服务端还没重启时会读到 undefined。退回旧行为,免得把"没配过"和"服务端没重启"
        // 混成同一个结果(那会让这张卡配好了也永远填不上)。
        const own = s.ownConfigured ?? s.configured;
        if (!s.configured || !own) return;
        setProvider(s.provider ?? 'ollama');
        setModel(s.model ?? '');
        setBaseUrl(s.baseUrl ?? '');
        setContextWindow(s.contextWindow ?? null);
        setMaxOutput(s.maxOutput ?? null);
        setHasSavedKey(!!s.hasApiKey);
      })
      .catch(() => {});
  }, []);

  const loadModels = useCallback(async (p: string) => {
    setError('');
    setModelsNote('');
    setBusy('models');
    try {
      if (p === 'ollama') {
        // 本地实时拉 —— 用户装了什么只有 Ollama 自己知道(spec §3)。
        // 在这一层就把形状统一成 ModelMeta,后面的代码不用认识两种模型对象
        const res = await fetch(
          `/api/settings/ollama-models?baseUrl=${encodeURIComponent(baseUrl)}`,
        );
        const body = (await res.json()) as {
          models?: { name: string; contextWindow: number; maxOutput: number; detail?: string }[];
          reason?: string;
        };
        if (!res.ok) throw new Error(body.reason ?? '拉取本地模型失败');
        setModels(
          (body.models ?? []).map((m) => ({
            provider: 'ollama',
            model: m.name,
            contextWindow: m.contextWindow,
            maxOutput: m.maxOutput,
            // 本地模型的值是 Ollama 自己报的,不是我们猜的
            verified: true,
            ...(m.detail ? { note: m.detail } : {}),
          })),
        );
      } else {
        // **名字实时从厂商拉**(它才知道自己现在服务哪些模型),数字由服务端查注册表。
        // 拉不到(还没填 key / 网络不通 / 端点不实现 /models)就退回内置那张表,
        // 并说一句为什么 —— 别让下拉直接空掉,那样用户连"该干什么"都看不出来。
        try {
          setModels(await llmApi.listRemoteModels({ provider: p, baseUrl, apiKey }));
        } catch (e) {
          setModels(await llmApi.listModels(p));
          setModelsNote(
            `拉不到厂商的模型列表:${(e as Error).message}。先显示内置的那几个 —— ` +
              `填上 API Key 再点「刷新」,或在下面直接打模型名。`,
          );
        }
      }
    } catch (e) {
      setModels([]);
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
    // 故意**不**把 apiKey 放进依赖:它在下面那个 useEffect 的依赖链上,放进去会让
    // 用户每敲一个字符就发一次拉列表的请求。点「刷新」时用的是当次渲染的闭包,不漏。
  }, [baseUrl]);

  useEffect(() => {
    void loadModels(provider);
  }, [provider, loadModels]);

  /**
   * 换服务商 = 换端点 + 换模型名空间,所以上一家的这几项**必须清掉**。
   *
   * 不清 baseUrl 的后果是实测出来的:本地 Ollama 的模型发现会把它当根地址用,
   * 于是留着 deepseek 的地址就去问 deepseek 要 /api/tags(401)→ 前端 catch 里
   * `setModels([])` → **下拉直接空掉**,而报错还说"确认 Ollama 正在运行" ——
   * 明明它在跑,极其误导。
   *
   * 那两个数字同理且更危险:一个是 1M 窗口的模型留下的 1024000,拿去跑本地 4b
   * 会让 batchSize 算出远超上下文的批次(§3:批到超上下文)。
   */
  const changeProvider = (p: string) => {
    if (p === provider) return;
    setProvider(p);
    setBaseUrl('');
    setModel('');
    setContextWindow(null);
    setMaxOutput(null);
  };

  /** 选模型 → 自动填上下文数字(用户仍可改) */
  const pickModel = (name: string) => {
    setModel(name);
    const meta = models.find((m) => m.model === name);
    if (meta) {
      setContextWindow(meta.contextWindow);
      setMaxOutput(meta.maxOutput);
    }
  };

  // 表里查得到就看它自己的 verified;查不到(手打的名字,或从厂商拉来但注册表没收录)
  // **就是未确认** —— 那两个数字是兜底的 32768/4096,必须让用户核对:
  // 数字填错等于 batchSize 算错,要么批到超上下文,要么跑一整天(§3)。
  const chosen = models.find((m) => m.model === model);
  const unverified = chosen ? chosen.verified === false : !!model;

  const save = async () => {
    setError('');
    setNotice('');
    setBusy('save');
    try {
      await llmApi.save(
        {
          provider,
          model,
          baseUrl,
          // 留空 = 不改动已存的 key(用户不用每次重打)
          ...(apiKey ? { apiKey } : {}),
          ...(contextWindow !== null ? { contextWindow } : {}),
          ...(maxOutput !== null ? { maxOutput } : {}),
        },
        purpose,
      );
      setNotice('已保存。之后所有 AI 调用都用这个模型。');
      setApiKey('');
      setHasSavedKey(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
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

  return (
    <div className="hud-panel" style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Zap size={16} style={{ color: 'var(--accent)' }} />
        <span className="hud-label" style={{ color: 'var(--accent)' }}>
          {isTag ? '打标模型' : '模型管理'}
          <span style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)', marginLeft: 8 }}>
            {isTag
              ? '专门给「给条目打标签」用 —— 本地小模型就够。key / 接口地址留空 = 沿用主模型'
              : '聊天 / 归类 / 规则建议共用这一个。单独功能想用别的模型,配下面那张卡'}
          </span>
        </span>
      </div>

      <Field label="服务商">
        <Select
          id={`llm-${purpose}-服务商`}
          value={provider}
          onChange={changeProvider}
          options={PROVIDERS.map((p) => ({ value: p.value, label: p.label }))}
          style={{ width: 260 }}
        />
        <span style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)', marginLeft: 10 }}>
          {providerHint}
        </span>
      </Field>

      <Field label="模型">
        <Select
          id={`llm-${purpose}-模型`}
          // **tags 模式是为了能自由输入模型名。** 厂商拉不到时(还没填 key)下拉可能只有
          // 内置那几个,「自定义」端点更是一个都没有 —— 而"想用的模型不在表里"是最正常
          // 不过的事。maxCount=1 让它在语义上仍然是单选,value/onChange 在这里做
          // 数组↔字符串的转换,别处看到的还是 `model: string`。
          mode="tags"
          maxCount={1}
          value={model ? [model] : []}
          onChange={(v: string[]) => pickModel(v[0] ?? '')}
          placeholder={busy === 'models' ? '拉取中…' : '选一个,或直接打模型名'}
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
          loading={busy === 'models'}
          onClick={() => void loadModels(provider)}
          style={{ marginLeft: 8 }}
        >
          刷新
        </Button>
        {unverified && (
          <span style={{ marginLeft: 10, fontSize: 'var(--fs-12)', color: 'var(--warn)' }}>
            ⚠️ 这个模型的上下文是估算值,请核对
          </span>
        )}
      </Field>

      {modelsNote && (
        // **不能是灰字。** 退回内置表和"厂商就这几个模型"在界面上长得太像了 ——
        // 用户会以为列表是拉出来的,于是问"为什么还是那两个老的"(真实反馈)。
        // 用和旁边 ⚠️ 待确认同一套 warn 色,让"这是兜底的,不是厂商说的"一眼可见。
        <div style={{ fontSize: 'var(--fs-12)', color: 'var(--warn)', marginBottom: 12, lineHeight: 1.6 }}>
          ⚠️ {modelsNote}
        </div>
      )}

      <Field label="接口地址">
        <Input
          id={`llm-${purpose}-接口地址`}
          name="llm-base-url"
          // 不是凭证,明确告诉浏览器别填
          autoComplete="off"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder={
            isTag ? '留空 = 沿用主模型的接口地址'
            : provider === 'ollama' ? 'http://127.0.0.1:11434/v1(留空用默认)'
            : '留空用默认地址'
          }
          style={{ width: 420, fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-12)' }}
        />
      </Field>

      <Field label="API Key">
        <Input.Password
          id={`llm-${purpose}-API-Key`}
          name={`llm-${purpose}-api-key`}
          // new-password 让密码管理器别把它和上面的文本框配成"用户名+密码"
          autoComplete="new-password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={
            hasSavedKey ? '已保存,留空表示不改动'
            : isTag ? '留空 = 沿用主模型的 Key'
            : provider === 'ollama' ? '本地模型不需要'
            : '粘贴 API Key'
          }
          style={{ width: 420, fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-12)' }}
        />
      </Field>

      <Field label="上下文 / 输出">
        <InputNumber
          id={`llm-${purpose}-上下文-输出`}
          value={contextWindow}
          onChange={setContextWindow}
          min={1}
          placeholder="contextWindow"
          style={{ width: 150 }}
        />
        <span style={{ margin: '0 8px', color: 'var(--text-dim)' }}>/</span>
        <InputNumber
          aria-label="最大输出"
          value={maxOutput}
          onChange={setMaxOutput}
          min={1}
          placeholder="maxOutput"
          style={{ width: 150 }}
        />
        <span style={{ marginLeft: 10, fontSize: 'var(--fs-12)', color: 'var(--text-dim)' }}>
          选完模型会自动填,可以改。这两个数决定每批塞多少条
        </span>
      </Field>

      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <Button type="primary" icon={<Save size={14} />} loading={busy === 'save'} disabled={!model} onClick={save}>
          保存
        </Button>
        <Button loading={busy === 'test'} disabled={!model} onClick={test}>
          测试连接
        </Button>
      </div>

      {notice && <Alert type="success" showIcon message={notice} closable onClose={() => setNotice('')} />}
      {error && <Alert type="error" showIcon message={error} closable onClose={() => setError('')} />}
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
