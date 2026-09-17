import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import type { RuleSuggestion } from '../types';

/**
 * AI 助手的状态(spec §11.9)。
 *
 * 悬浮图标在 layouts 里、抽屉也在 layouts 里,但 /curator 页面上的按钮也要能
 * 把抽屉叫出来 —— 所以状态放 context,三边共享,不做 prop 层层传递。
 */
export type AssistantStatus = 'idle' | 'working';

interface AssistantCtx {
  open: boolean;
  /** working = 正在跑 Pass / 正在流式回复,图标据此变形 */
  status: AssistantStatus;
  sessionId: number | null;
  setStatus: (s: AssistantStatus) => void;
  setSessionId: (id: number | null) => void;
  /** 打开抽屉。给了 id 就切到那个会话,没给就沿用当前会话(没有则新建) */
  openWith: (id?: number) => void;
  close: () => void;
  /**
   * AI 的规则建议 —— **不落库,只活在内存里**(spec §9C.5)。
   *
   * 放 context 而不是面板自己的 state:建议有两个来源(归类跑完顺手给的,
   * 和面板上主动要的),而归类那一次跑在全局的对话框里、面板在 /rules 页 ——
   * 两边要看到同一份东西,只能有个共享的地方。
   */
  suggestions: RuleSuggestion[];
  /**
   * 用 `Dispatch<SetStateAction<…>>` 而不是 `(s: RuleSuggestion[]) => void`:
   * 面板的「忽略」和「全部采纳」走的是**函数式更新**(`set(list => …)`)——
   * 收窄成只收数组的话,「全部采纳」那个 `for` 循环每轮都会拿渲染时那一份**旧数组**
   * 去过滤(循环里 await 期间不会重新绑定闭包),最后只剩最后一条被丢掉。
   */
  setSuggestions: Dispatch<SetStateAction<RuleSuggestion[]>>;
}

const Ctx = createContext<AssistantCtx | null>(null);

export function AssistantProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<AssistantStatus>('idle');
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [suggestions, setSuggestions] = useState<RuleSuggestion[]>([]);

  const openWith = useCallback(
    (id?: number) => {
      setOpen(true);
      if (id !== undefined) {
        setSessionId(id);
        return;
      }
      // 没指定会话且当前也没有 → 开一个。**不在这里跑 AI** ——
      // 「开始整理」是进工作台,不是弹 AI(spec §9.0 的核心交互原则)
      setSessionId((cur) => cur ?? null);
    },
    [],
  );

  const value = useMemo<AssistantCtx>(
    () => ({
      open,
      status,
      sessionId,
      setStatus,
      setSessionId,
      openWith,
      close: () => setOpen(false),
      suggestions,
      setSuggestions,
    }),
    [open, status, sessionId, openWith, suggestions],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAssistant(): AssistantCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAssistant 必须放在 AssistantProvider 里');
  return ctx;
}
