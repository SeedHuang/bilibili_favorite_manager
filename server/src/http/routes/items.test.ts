import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { openDb } from '../../db/index.js';
import { Logger } from '../../logger/index.js';
import { upsertFolder } from '../../db/repo/folders.js';
import { upsertItem, linkFolderItem } from '../../db/repo/items.js';
import { registerFolderRoutes } from './folders.js';
import { registerItemRoutes } from './items.js';

function makeApp() {
  const db = openDb(':memory:');
  const log = new Logger(db, { silent: true });
  // 种子数据
  upsertFolder(db, { id: 1, title: '深度学习', mediaCount: 2 });
  upsertFolder(db, { id: 2, title: '前端', mediaCount: 1 });
  upsertItem(db, { id: 'BV1', type: 2, title: 'Rust 所有权入门', intro: '讲清楚借用和生命周期', upperName: '张三', duration: 600, pubtime: 1700000000 });
  upsertItem(db, { id: 'BV2', type: 2, title: '神经网络反向传播', intro: '从数学推导到代码', upperName: '李四', duration: 1200, pubtime: 1700001000 });
  upsertItem(db, { id: 'BV3', type: 2, title: 'React 服务端渲染', intro: 'SSR 的原理与实践', upperName: '王五', duration: 800, pubtime: 1700002000 });
  linkFolderItem(db, 1, 'BV1', 100);
  linkFolderItem(db, 1, 'BV2', 200);
  linkFolderItem(db, 2, 'BV3', 300);
  const app = Fastify();
  registerFolderRoutes(app, { db, log });
  registerItemRoutes(app, { db, log });
  return { app, db };
}

describe('folders routes', () => {
  it('返回按 title 排序的收藏夹', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/folders' });
    expect(res.statusCode).toBe(200);
    expect(res.json().folders.map((f: { title: string }) => f.title)).toEqual(['前端', '深度学习']);
  });
});

describe('items routes', () => {
  it('按收藏夹分页返回条目', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/folders/1/items?page=1&pageSize=1' });
    expect(res.json().total).toBe(2);
    expect(res.json().items).toHaveLength(1);
  });

  it('返回收藏夹内条目的收藏时间(按 fav_time 倒序)', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/folders/1/items' });
    // fav_time 存在 folder_items,不在 items —— 详情形状里的 favTime 只能从这里取
    expect(res.json().items.map((i: { id: string }) => i.id)).toEqual(['BV2', 'BV1']);
    expect(res.json().items.map((i: { favTime: number }) => i.favTime)).toEqual([200, 100]);
  });

  it('FTS 搜索标题/简介/UP名', async () => {
    const { app } = makeApp();
    // FTS5 用前缀匹配(需要先建 FTS 虚拟表,见实现)
    const res = await app.inject({ method: 'GET', url: '/api/items/search?q=Rust' });
    expect(res.json().items.map((i: { title: string }) => i.title)).toContain('Rust 所有权入门');
  });

  it('单条目详情含所属夹', async () => {
    const { app } = makeApp();
    const res = await app.inject({ method: 'GET', url: '/api/items/BV1' });
    const body = res.json();
    expect(body.item.title).toBe('Rust 所有权入门');
    expect(body.folders.map((f: { id: number }) => f.id)).toContain(1);
  });
});
