import { describe, it, expect } from 'vitest';
import { openDb } from '../index.js';
import { logOperation, listOperations } from './operations.js';

const fresh = () => openDb(':memory:');

describe('操作日志', () => {
  it('追加一条,能读回来', () => {
    const db = fresh();
    logOperation(db, {
      kind: 'merge_folders', actor: 'user',
      summary: '把「机器学习」并入「AI/编程」',
      detail: { from: 7, into: 8, items: 233 },
    });
    const rows = listOperations(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('merge_folders');
    expect(rows[0]!.actor).toBe('user');
    expect(rows[0]!.summary).toContain('机器学习');
    expect(rows[0]!.detail).toEqual({ from: 7, into: 8, items: 233 });
  });

  it('最新的在最前面(界面要按时间倒序显示)', () => {
    const db = fresh();
    logOperation(db, { kind: 'create_folder', actor: 'user', summary: '第一条' });
    logOperation(db, { kind: 'create_folder', actor: 'user', summary: '第二条' });
    expect(listOperations(db).map((r) => r.summary)).toEqual(['第二条', '第一条']);
  });

  // 一次操作一条 —— 拖 412 条不该产生 412 行
  it('一次操作只产生一行', () => {
    const db = fresh();
    logOperation(db, {
      kind: 'move_items', actor: 'user',
      summary: '移动 412 条到「AI/编程」',
      detail: { itemIds: Array.from({ length: 412 }, (_, i) => `BV${i}`) },
    });
    expect(listOperations(db)).toHaveLength(1);
  });

  it('actor=ai 也能正常落库(不依赖会话)', () => {
    const db = fresh();
    logOperation(db, { kind: 'move_items', actor: 'ai', summary: 'x' });
    expect(listOperations(db)[0]!.actor).toBe('ai');
  });

  it('limit 限制条数', () => {
    const db = fresh();
    for (let i = 0; i < 5; i++) {
      logOperation(db, { kind: 'create_folder', actor: 'user', summary: `第${i}条` });
    }
    expect(listOperations(db, { limit: 2 })).toHaveLength(2);
  });

  it('sinceTs 只取那之后的 —— 批量应用前查冲突用', () => {
    const db = fresh();
    logOperation(db, { kind: 'create_folder', actor: 'user', summary: '旧的' });
    logOperation(db, { kind: 'create_folder', actor: 'user', summary: '新的' });

    // 游标用**上一条自己的 ts**,不用墙钟 —— 墙钟当游标会让这条测试的通过与否
    // 取决于毫秒边界落在哪(实测约 0.1% 的窗口会漏掉"新的")。
    // ts 现在严格递增,所以 ts >= 上一条的 ts 恰好只选出最新那条,完全确定。
    const [newest] = listOperations(db);
    expect(listOperations(db, { sinceTs: newest!.ts }).map((r) => r.summary)).toEqual(['新的']);
  });

  // 毫秒级墙钟给不了唯一坐标:同一毫秒里落的第二条会和上一条撞成同一个 ts。
  // 冲突检测(sinceTs 窗口)就靠"ts 严格递增"这个不变量,所以得有人守。
  it('ts 严格递增 —— 一次操作在日志里有唯一坐标', () => {
    const db = fresh();
    const firstId = logOperation(db, { kind: 'create_folder', actor: 'user', summary: '一' });
    const secondId = logOperation(db, { kind: 'create_folder', actor: 'user', summary: '二' });

    // 倒序:最新的在前
    const [second, first] = listOperations(db);
    expect(second!.summary).toBe('二');
    expect(first!.summary).toBe('一');
    expect(second!.ts).toBeGreaterThan(first!.ts);
    expect(firstId).toBeLessThan(secondId);
  });

  it('没有 detail 也能记(不是所有操作都需要明细)', () => {
    const db = fresh();
    logOperation(db, { kind: 'reset', actor: 'user', summary: '还原' });
    expect(listOperations(db)[0]!.detail).toBeNull();
  });
});
