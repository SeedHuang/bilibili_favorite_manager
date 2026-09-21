import { useEffect, useRef, useState } from 'react';
import { settingsApi } from '../api';

/**
 * 任务轮询 hook(spec 2026-09-20 §4.1)。**刻意薄**:只把「间隔可配」抽出来,
 * 业务状态(running/done/total)由调用方从 fetcher 结果里自己读 ——
 * 和标注/质检现有轮询一样是哑轮询,不做任务状态机。
 */
export function useTaskProgress<T>(opts: {
  taskType: string;
  fetcher: () => Promise<T>;
  enabled: boolean;
}): T | null {
  const { taskType, fetcher, enabled } = opts;
  const [latest, setLatest] = useState<T | null>(null);
  const [intervalMs, setIntervalMs] = useState(3000); // 配置拉不到的兜底(spec §5)
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher; // 每渲染更新,避免 effect 依赖 fetcher 而反复重建 interval

  useEffect(() => {
    let alive = true;
    settingsApi.getPolls()
      .then((polls) => {
        if (alive && polls[taskType]) setIntervalMs(polls[taskType].intervalMs);
      })
      .catch(() => {}); // 配置失败用默认,轮询照常
    return () => { alive = false; };
  }, [taskType]);

  useEffect(() => {
    if (!enabled) return;
    // 递归 setTimeout 而不是 setInterval:上一拍没回来不发下一拍(最小间隔 1s,
    // fetcher 慢于间隔时 setInterval 会堆叠请求、旧响应还可能覆盖新响应)。
    // enabled 变 true 立即拉一次 —— 不然启动后要干等一个完整间隔才见第一帧
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const tick = async () => {
      try {
        setLatest(await fetcherRef.current());
      } catch (e) {
        // 单拍失败不炸不set —— 下一拍再试;但出声,别让持续失败无声无息
        console.warn('[useTaskProgress] 轮询单拍失败(下一拍重试)', e);
      }
      if (!stopped) timer = setTimeout(tick, intervalMs);
    };
    void tick();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [enabled, intervalMs]);

  return latest;
}
