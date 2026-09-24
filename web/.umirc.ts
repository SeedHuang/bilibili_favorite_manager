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
  /**
   * 打包器换成 utoopack(Rust,基于 Turbopack) —— 目标是解决 webpack dev 太慢。
   *
   * 为什么选它而不是 Vite:换 Vite 会变成 dev/prod 两套 bundler,"file: 依赖的双实例"
   * 要在两边各配一次,还多出"dev 好了 build 坏了"的分歧风险。utoopack 一个 bundler
   * 覆盖 dev + build,只配一次(Umi 4.7 自带 @umijs/bundler-utoopack,无需额外安装)。
   *
   * 开启后 Umi 会自动把 `mfsu` / `hmrGuardian` 关掉(见 preset-umi features/utoopack)。
   * **回退方式:删掉这一行**(或改成 `utoopack: false`)。
   */
  utoopack: {},
  proxy: {
    '/api': { target: 'http://127.0.0.1:3001', changeOrigin: true },
  },
});
