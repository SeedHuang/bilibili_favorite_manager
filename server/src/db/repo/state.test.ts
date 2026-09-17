import { describe, it, expect } from 'vitest';
import { openDb } from '../index.js';
import {
  getState, setState, deleteState,
  getSetting, setSetting, listSettingKeys,
} from './state.js';

describe('sync_state', () => {
  it('写读游标', () => {
    const db = openDb(':memory:');
    setState(db, 'sync:cursor:84975136', '{"pn":3}');
    expect(getState(db, 'sync:cursor:84975136')).toBe('{"pn":3}');
  });

  it('同一个 key 覆盖', () => {
    const db = openDb(':memory:');
    setState(db, 'k', 'a');
    setState(db, 'k', 'b');
    expect(getState(db, 'k')).toBe('b');
  });

  it('不存在的 key 返回 undefined', () => {
    const db = openDb(':memory:');
    expect(getState(db, 'nope')).toBeUndefined();
  });

  it('deleteState 删掉游标', () => {
    const db = openDb(':memory:');
    setState(db, 'k', 'a');
    deleteState(db, 'k');
    expect(getState(db, 'k')).toBeUndefined();
  });
});

describe('settings', () => {
  it('存读凭证(C10)', () => {
    const db = openDb(':memory:');
    setSetting(db, 'bili.sessdata', 'SECRET');
    expect(getSetting(db, 'bili.sessdata')).toBe('SECRET');
  });

  it('listSettingKeys 只给键名,不给值', () => {
    const db = openDb(':memory:');
    setSetting(db, 'bili.sessdata', 'SECRET');
    setSetting(db, 'llm.model', 'qwen3:8b');
    expect(listSettingKeys(db).sort()).toEqual(['bili.sessdata', 'llm.model']);
  });
});
