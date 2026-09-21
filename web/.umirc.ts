import { defineConfig } from '@umijs/max';

export default defineConfig({
  // 关掉内置 antd4,自装 antd5(已实测 antd:false 可行)
  antd: false,
  // useRequest(含 refreshDeps)来自 request 插件,占位页与 Task 8 都依赖它
  request: {},
  routes: [
    { path: '/', component: 'index' },
    { path: '/curator', component: 'curator' },
    { path: '/tag', component: 'tag' },
    { path: '/auth', component: 'auth' },
  ],
  npmClient: 'npm',
  proxy: {
    '/api': { target: 'http://127.0.0.1:3001', changeOrigin: true },
  },
});
