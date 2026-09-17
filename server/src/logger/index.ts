import type Database from 'better-sqlite3';
import { redact, redactDeep } from './redact.js';
import type { RequestRecord } from '../bilibili/client.js';

export interface LogEvent {
  level: 'info' | 'warn' | 'error';
  category: 'sync' | 'api' | 'llm' | 'execute' | 'auth';
  /** B站错误码(-412 / -101)或自定义码(LLM_JSON_PARSE / HTTP_5XX) */
  code?: string;
  message: string;
  /** 完整上下文,见 spec §6 的「为什么出错」表 */
  detail?: unknown;
  planId?: number;
  folderId?: number;
}

/**
 * 日志的唯一入口(spec §6、C9)。
 *
 * 三个出口:stdout / events 表 / api_calls 表。
 * 脱敏在这里做,业务代码没有漏的机会。
 */
export class Logger {
  private readonly insertEvent: Database.Statement;
  private readonly insertApiCall: Database.Statement;
  private readonly silent: boolean;

  constructor(db: Database.Database, opts: { silent?: boolean } = {}) {
    this.silent = opts.silent ?? false;
    this.insertEvent = db.prepare(
      `INSERT INTO events (ts, level, category, code, message, detail, plan_id, folder_id)
       VALUES (@ts, @level, @category, @code, @message, @detail, @planId, @folderId)`,
    );
    this.insertApiCall = db.prepare(
      `INSERT INTO api_calls
         (ts, trace_id, method, path, params, http_status, code, duration_ms, attempt, response_excerpt)
       VALUES (@ts, @traceId, @method, @path, @params, @httpStatus, @code, @durationMs, @attempt, @responseExcerpt)`,
    );
  }

  event(e: LogEvent): void {
    const message = redact(e.message);
    const detail = e.detail === undefined ? null : JSON.stringify(redactDeep(e.detail));

    this.insertEvent.run({
      ts: Date.now(),
      level: e.level,
      category: e.category,
      code: e.code ?? null,
      message,
      detail,
      planId: e.planId ?? null,
      folderId: e.folderId ?? null,
    });

    if (!this.silent) {
      const tag = `[${e.level}][${e.category}]`;
      console.log(`${tag} ${message}${e.code ? ` (${e.code})` : ''}`);
    }
  }

  apiCall(traceId: string | undefined, r: RequestRecord): void {
    const params = r.params === undefined ? null : JSON.stringify(redactDeep(r.params));

    this.insertApiCall.run({
      ts: Date.now(),
      traceId: traceId ?? null,
      method: r.method,
      path: r.path,
      params,
      httpStatus: r.httpStatus,
      code: r.code,
      durationMs: r.durationMs,
      attempt: r.attempt,
      responseExcerpt: redact(r.responseExcerpt),
    });
  }
}
