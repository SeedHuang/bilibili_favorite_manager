import { describe, it, expect } from 'vitest';
import { openDb } from '../db/index.js';
import { Logger } from './index.js';
import type { RequestRecord } from '../bilibili/client.js';

const makeLogger = () => {
  const db = openDb(':memory:');
  return { db, log: new Logger(db, { silent: true }) };
};

const sampleCall: RequestRecord = {
  method: 'GET',
  path: '/x/v3/fav/resource/list',
  params: { media_id: 84975136, pn: 1 },
  httpStatus: 200,
  code: 0,
  durationMs: 210,
  attempt: 1,
  responseExcerpt: '{"code":0,...}',
};

describe('Logger.event', () => {
  it('写进 events 表', () => {
    const { db, log } = makeLogger();
    log.event({ level: 'info', category: 'sync', message: '同步完成:64 个夹子' });
    const row = db.prepare(`SELECT * FROM events`).get() as Record<string, unknown>;
    expect(row['level']).toBe('info');
    expect(row['category']).toBe('sync');
    expect(row['message']).toBe('同步完成:64 个夹子');
    expect(row['resolved']).toBe(0);
  });

  it('detail 存成 JSON,并且被脱敏', () => {
    const { db, log } = makeLogger();
    log.event({
      level: 'error', category: 'api', code: '-412',
      message: '触发风控', detail: { cookie: 'SESSDATA=SECRET', tried: 12 },
    });
    const row = db.prepare(`SELECT detail FROM events`).get() as { detail: string };
    expect(row.detail).not.toContain('SECRET');
    expect(row.detail).toContain('"tried":12');
  });

  it('带 planId / folderId', () => {
    const { db, log } = makeLogger();
    log.event({ level: 'warn', category: 'sync', message: 'x', planId: 7, folderId: 42 });
    const row = db.prepare(`SELECT plan_id, folder_id FROM events`).get() as Record<string, unknown>;
    expect(row['plan_id']).toBe(7);
    expect(row['folder_id']).toBe(42);
  });

  it('message 里的敏感值也被脱敏', () => {
    const { db, log } = makeLogger();
    log.event({ level: 'error', category: 'auth', message: 'cookie 失效:SESSDATA=SECRETVALUE' });
    const row = db.prepare(`SELECT message FROM events`).get() as { message: string };
    expect(row.message).not.toContain('SECRETVALUE');
  });
});

describe('Logger.apiCall', () => {
  it('写进 api_calls 表,带 trace_id', () => {
    const { db, log } = makeLogger();
    log.apiCall('trace-abc', sampleCall);
    const row = db.prepare(`SELECT * FROM api_calls`).get() as Record<string, unknown>;
    expect(row['trace_id']).toBe('trace-abc');
    expect(row['path']).toBe('/x/v3/fav/resource/list');
    expect(row['http_status']).toBe(200);
    expect(row['code']).toBe(0);
    expect(row['attempt']).toBe(1);
  });

  it('params 存成 JSON 且被脱敏', () => {
    const { db, log } = makeLogger();
    log.apiCall(undefined, { ...sampleCall, params: { media_id: 1, api_key: 'sk-SECRET' } });
    const row = db.prepare(`SELECT params FROM api_calls`).get() as { params: string };
    expect(row.params).not.toContain('sk-SECRET');
    expect(row.params).toContain('media_id');
  });

  it('traceId 为 undefined 时不炸', () => {
    const { db, log } = makeLogger();
    expect(() => log.apiCall(undefined, sampleCall)).not.toThrow();
    const row = db.prepare(`SELECT trace_id FROM api_calls`).get() as { trace_id: string | null };
    expect(row.trace_id).toBeNull();
  });
});
