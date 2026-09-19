/**
 * 标注按钮三态 —— 跟随「标了多少」走(清空后回 0、全标完只剩重标)。
 * 纯函数,独立测;TagPanel 消费它渲染按钮。
 */
export type RunButton = 'primary' | 'continue' | 'retag';

export function runButtons(tagged: number, total: number): RunButton[] {
  if (total === 0) return [];
  if (tagged === 0) return ['primary'];
  if (tagged >= total) return ['retag'];
  return ['continue', 'retag'];
}
