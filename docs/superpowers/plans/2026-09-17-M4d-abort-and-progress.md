# §9D 可中止的 AI 调用 + 归类进度 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AI 调用一旦发出用户就不再失去控制权 —— 归类**分批出进度**(第 5/11 批 · 已归 N 条),聊天和归类的发送按钮**同一枚两态**(空闲 = 发送,进行中 = ■ 停止),中止后服务端真的停、已完成的批次不白跑。

**Architecture:** 归类的传输从一次性 JSON 改成 SSE(复用聊天那条已验证的路:`hijack` + `data:`/`event:` 帧 + 前端 ReadableStream 解析),每批完成发 `event: progress`、结果**分批 upsert** 进 `classifications`。中止 = 前端 `AbortController` 断开 fetch;服务端用 `req.raw.on('close')` 感知,把 `AbortSignal` 传进 provider(AI SDK 的 `generateText`/`streamText` 原生接受 `abortSignal`),断开即停、不再继续调 provider。批语义(每批独立、可续跑、失败只损一批,§9.4)原样。

**Tech Stack:** TypeScript ^5.9.3(ESM)、Fastify 5(`reply.hijack` + 裸 res 写 SSE)、Vercel AI SDK v7(`abortSignal`)、React 18 + antd 5

**Spec:** `docs/superpowers/specs/m4d-abort-and-progress.md`(§9D,冲突时以它为准)。它不改任何 §9C 决定(规则先跑、自证、建议不落库全部原样);批处理语义是 §9.3 的,**本计划只动传输**。

## Global Constraints

- Node 22.12、TypeScript ^5.9.3、ESM(**类型一律 `import type`**);`strict` + `noUncheckedIndexedAccess`
- 依赖方向:`http → curator → db / logger`;`db/` 不许 import `curator/`
- 注释写中文,解释"为什么";commit trailer **严格** `Co-Authored-By: Claude Code <noreply@anthropic.com>`
- **批语义不变**:每批独立、可续跑、失败只损该批(§9.4 四层兜底原样,不动缩批逻辑)
- **AbortError 在日志里是 `warn` 不是 `error`**(§9D B5:主动中断不是故障);其它错误照旧 error
- **用户消息先落库、半截 AI 回复也要落库**(§9D B3),标注 `(已中断)`
- 测试**不调真实 API**,LLM 一律 mock
- 每个任务收尾跑:`npm test -w server` 全绿;涉及前端时再加 `cd web && npm run typecheck && npx max build`
- **全局测试与 typecheck 必须串行跑**(rateLimiter.test.ts 时序敏感)
- 前端**没有任何测试框架**,验证 = typecheck + build;不添加测试框架

---

## 先读这段:现状的四个事实

1. **聊天 SSE 的完整样板已存在**:`routes.ts` 的 `POST /api/curator/sessions/:id/messages`(`hijack` → 裸 res 写 `data:`/`event:` 帧 → finally `end()`),前端 `streamMessage`(fetch + ReadableStream + 按 `\n\n` 切事件)。本计划照抄它的形状,不发明新帧格式。
2. **`runPass2` 引擎有钩子没接线**:每批成功后调 `opts.onProgress?.(done, total)`(`classifier.ts:581`),路由从来没传。本计划把它接上并加宽(带上批次号)。
3. **`complete`/`stream` 不接受 signal**:`provider.ts:118` 的 `complete` 调 `generateText` 时没传 `abortSignal`;AI SDK v7 的 `generateText`/`streamText` 都接受 `abortSignal?: AbortSignal`(`node_modules/ai/dist/index.d.ts:654` 已确认)。
4. **`saveClassification` 是 upsert**:`ON CONFLICT(session_id) DO UPDATE`(`classifications.ts:37-44`)—— "分批落库"就是对同一会话重复调它,不需要新表、新列。

**注意 §9D B5 的一句关键语义**:服务端"检测到连接关闭**就停**"。SSE 里客户端断开的唯一信号是写响应失败或 `req.raw` 的 `close` 事件 —— 所以服务端必须**在发起每个 provider 调用前**检查"连接还活着吗",并把 signal 传进去;死循环里跑完一整批才发现连接死了是不够的,但**批与批之间**检查 + signal 双保险已足够(批内中断本来就要等 provider 响应)。

```
server/src/
├─ llm/provider.ts          complete/stream 加 abortSignal 透传      ← T1
├─ curator/
│  ├─ classifier.ts         runPass2 加 signal + 加宽的 onProgress   ← T2
│  └─ routes.ts             run-pass-2 改 SSE;messages 路由接 close ← T3
├─ db/repo/classifications.ts  (不改 —— upsert 已经支持分批落库)
web/src/
├─ api.ts                   streamMessage 加 signal 参数;classifyStream 新增 ← T4
├─ types.ts                 ProgressPayload 类型                      ← T4
└─ components/
   ├─ ChatDrawer.tsx        两枚按钮两态 + 进度行 + 中断提示          ← T5
   └─ (assistant.tsx 不改 —— 抽屉的 busy 状态已是本地 state)
```

---

### Task 1: provider 透传 abortSignal

**Files:**
- Modify: `server/src/llm/provider.ts`(`complete` 与 `stream` 各加一个可选参数)
- Test: `server/src/llm/provider.test.ts`(追加)

**Interfaces:**
- Consumes: AI SDK v7 的 `generateText` / `streamText`(已确认接受 `abortSignal?: AbortSignal`)
- Produces:
  ```ts
  export async function complete(opts: {
    config: ModelConfig;
    messages: ChatMessage[];
    /** 调用方断开(用户点了停止)时,SDK 会中断这次生成 —— §9D B2 */
    abortSignal?: AbortSignal;
  }): Promise<string>
  export async function stream(opts: {
    config: ModelConfig;
    messages: ChatMessage[];
    onChunk: (delta: string) => void;
    abortSignal?: AbortSignal;
  }): Promise<string>
  ```

- [ ] **Step 1: 写失败的测试**

追加到 `server/src/llm/provider.test.ts`(先看它现在怎么 mock `ai` 包 —— 照既有写法,下面给出的是断言形状;若该文件的 mock 结构不同,以它的结构为准写等价断言):

```ts
  it('complete 把 abortSignal 透传给 generateText(用户点停止时 SDK 能中断)', async () => {
    const controller = new AbortController();
    await complete({
      config, // 该文件里已有的最小 config 常量
      messages: [{ role: 'user', content: 'hi' }],
      abortSignal: controller.signal,
    });
    // mock 出来的 generateText 被调时,abortSignal 必须原样在参数里
    expect(vi.mocked(generateTextMock).mock.calls[0]![0]).toMatchObject({ abortSignal: controller.signal });
  });

  it('不传 abortSignal 时也不炸(可选参数)', async () => {
    await expect(complete({ config, messages: [{ role: 'user', content: 'hi' }] })).resolves.toBeDefined();
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -w server -- src/llm/provider.test.ts`
Expected: FAIL —— `complete` 的参数类型不认识 `abortSignal`(TS 报错)或断言失败

- [ ] **Step 3: 实现**

`provider.ts` 的 `complete`:

```ts
export async function complete(opts: {
  config: ModelConfig;
  messages: ChatMessage[];
  /** 调用方断开(用户点了停止)时中断生成 —— §9D B2。不传 = 不可中断(和旧行为一致) */
  abortSignal?: AbortSignal;
}): Promise<string> {
  const { instructions, rest } = splitPrompt(opts.messages);
  const { text } = await generateText({
    model: languageModel(opts.config),
    ...(instructions ? { instructions } : {}),
    messages: rest,
    // **省了这行,用户点停止就只是浏览器断开,provider 照样把 token 生成完** ——
    // "钱花了、结果没人接"。AI SDK 原生接受 signal,透传即可
    ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
  });
  return text;
}
```

`stream` 同样处理:opts 加 `abortSignal?: AbortSignal`,`streamText({...})` 里同样透传。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -w server -- src/llm/provider.test.ts`
Expected: PASS(原有用例全绿 + 新增 2 条)

- [ ] **Step 5: 全量 + 提交**

```bash
npm test -w server
npm run typecheck -w server
git add server/src/llm/provider.ts server/src/llm/provider.test.ts
git commit -m "feat(llm): complete/stream 透传 abortSignal —— 中止要真的停,不是没人听

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: runPass2 接 signal + 加宽的进度回调

**Files:**
- Modify: `server/src/curator/classifier.ts:522-535`(`runPass2` 的 opts 与循环)
- Test: `server/src/curator/classifier.test.ts`(追加)

**Interfaces:**
- Consumes: Task 1 的 `complete(..., { abortSignal })`
- Produces:
  ```ts
  export async function runPass2(opts: {
    config: ModelConfig;
    ctx: ModelMeta;
    folders: readonly FolderSpec[];
    items: readonly ItemRow[];
    samples?: ReadonlyMap<number, readonly string[]>;
    /** 加宽:批次从 1 计,done/total 是条目数。中止时不再回调 */
    onProgress?: (p: { batch: number; batches: number; done: number; total: number }) => void;
    /** 用户点了停止:批与批之间检查,批内由 complete 的 signal 中断 */
    signal?: AbortSignal;
  }): Promise<Pass2Result>
  ```

- [ ] **Step 1: 写失败的测试**

追加到 `server/src/curator/classifier.test.ts` 的 Pass 2 describe 里(mock 方式照该文件既有写法 —— `mocks.complete.mockResolvedValue(...)` 返回合法 JSON 数组):

```ts
  // §9D A2:进度要带批次号和批总数,界面才显示得出"第 5/11 批"
  it('onProgress 回调带 batch / batches / done / total', async () => {
    // tinyCtx 的 batchSize=16,种 3 条 → 1 批
    mocks.complete.mockResolvedValue(
      '[{"itemId":"BV1","folderTempId":"42","confidence":0.9,"reason":"r"},' +
      '{"itemId":"BV2","folderTempId":"42","confidence":0.8,"reason":"r"},' +
      '{"itemId":"BV3","folderTempId":"42","confidence":0.7,"reason":"r"}]',
    );
    const seen: { batch: number; batches: number; done: number; total: number }[] = [];
    await runPass2({
      config,
      ctx: tinyCtx,
      folders: [folder('42', 'AI/编程')],
      items: [item('BV1', 'a'), item('BV2', 'b'), item('BV3', 'c')],
      onProgress: (p) => seen.push(p),
    });
    expect(seen).toEqual([{ batch: 1, batches: 1, done: 3, total: 3 }]);
  });

  // §9D B2:中止 = 不再发起下一批,已完成的部分照常返回
  it('signal 中止后立刻返回 —— 已完成的批次保留,剩余的丢弃', async () => {
    // 两批:第一批成功,第二批发起前 signal 已经 abort
    const controller = new AbortController();
    let calls = 0;
    mocks.complete.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) {
        // 第一批完成后再中止
        controller.abort();
        return '[{"itemId":"BV1","folderTempId":"42","confidence":0.9,"reason":"r"}]';
      }
      return '[]';
    });
    const got = await runPass2({
      config,
      ctx: tinyCtx,
      folders: [folder('42', 'AI/编程')],
      items: [item('BV1', 'a'), item('BV2', 'b'), item('BV3', 'c'), item('BV4', 'd')],
      signal: controller.signal,
    });
    expect(calls).toBe(1);           // 第二批没发起
    expect(got.assignments.map((a) => a.itemId)).toEqual(['BV1']);
  });

  it('批内被中止 → complete 抛 AbortError,该批按失败记,reason 说清是中止', async () => {
    const controller = new AbortController();
    controller.abort(); // 发起前就已中止
    mocks.complete.mockRejectedValue(new Error('This operation was aborted'));
    const got = await runPass2({
      config, ctx: tinyCtx,
      folders: [folder('42', 'AI/编程')],
      items: [item('BV1', 'a')],
      signal: controller.signal,
    });
    expect(got.failedBatches[0]!.reason).toContain('已中止');
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -w server -- src/curator/classifier.test.ts`
Expected: FAIL —— `runPass2` 不认识 `signal`,`onProgress` 的回调形状对不上

- [ ] **Step 3: 实现**

`runPass2` 的 opts 与循环改成(只列**变化**的部分;缩批重试、覆盖保证、去重收尾全部不动):

```ts
export async function runPass2(opts: {
  config: ModelConfig;
  ctx: ModelMeta;
  folders: readonly FolderSpec[];
  items: readonly ItemRow[];
  samples?: ReadonlyMap<number, readonly string[]>;
  /** §9D A2:批次从 1 计,done/total 是**条目**数。中止后不再回调 */
  onProgress?: (p: { batch: number; batches: number; done: number; total: number }) => void;
  /** §9D B2:用户点了停止。批与批之间检查;批内由 complete 的 signal 中断 */
  signal?: AbortSignal;
}): Promise<Pass2Result> {
  ...
  const totalBatches = queue.length;
  let batchNo = 0;

  while (queue.length > 0) {
    // **先看信号再花钱** —— 发起 provider 调用前检查,中止就不开下一批
    if (opts.signal?.aborted) break;
    const batch = queue.shift()!;
    batchNo += 1;

    let raw: string;
    try {
      raw = await complete({
        config: opts.config,
        messages: [ ...原样... ],
        ...(opts.signal ? { abortSignal: opts.signal } : {}),
      });
    } catch (e) {
      const message = (e as Error)?.message ?? String(e);
      if (opts.signal?.aborted) {
        // **主动中断不是故障(§9D B5)**:不记 failedBatches(那是"这批没成,数据坏了"
        // 的账),直接跳出 —— 已完成的批次留在 assignments 里
        break;
      }
      failedBatches.push({ firstItemId: batch[0]!.id, size: batch.length, reason: `请求失败:${message}` });
      continue;
    }

    const got = coerceAssignments(raw, validTempIds);
    if (got) {
      assignments.push(...got);
      done += batch.length;
      opts.onProgress?.({ batch: batchNo, batches: totalBatches, done, total: opts.items.length });
      continue;
    }
    ...缩批逻辑原样...
  }
  ...收尾原样...
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -w server -- src/curator/classifier.test.ts`
Expected: PASS(既有用例全绿 —— 注意既有 onProgress 用例若断言旧签名 `(done, total)` 需同步改形状;这是**签名变更**,本任务的测试就是契约)

- [ ] **Step 5: 全量 + 提交**

```bash
npm test -w server
npm run typecheck -w server
git add server/src/curator/classifier.ts server/src/curator/classifier.test.ts
git commit -m "feat(curator): runPass2 可中止 + 进度带批次号

批与批之间看 signal,批内由 provider 的 abortSignal 中断。主动中断不记
failedBatches(那笔账是'数据坏了'),已完成的批次照常返回。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: `run-pass-2` 改成 SSE(进度帧 + 分批落库)

**Files:**
- Modify: `server/src/curator/routes.ts:285-352`(`run-pass-2` 路由整体重写应答方式)
- Test: `server/src/curator/routes.test.ts`(追加 + 改既有)

**Interfaces:**
- Consumes: Task 2 的 `runPass2`(新 onProgress 签名 + signal);`saveClassification`(upsert,直接重复调);聊天路由的 SSE 帧格式(`data:`/`event: progress|done|error`)
- Produces(SSE 帧契约,前端 T4 依赖):
  ```
  event: progress   data: {"batch":5,"batches":11,"done":1365,"total":2976,"ruleCount":274}
  event: done       data: <与旧一次性 JSON 完全相同的响应形状>
  event: error      data: {"reason":"..."}
  ```
  **分批落库**:每收到一批 assignments 就 `saveClassification(db, id, [...ruleAssignments, ...got], failedBatches)` —— upsert 语义,最后一版就是完整结果。

**为什么 progress 里带 `ruleCount`**:§9D.2 明确"规则已接 N 条"在第一批的 progress 里就出现 —— 分栏(§9C.3 ③)在**过程**里成立,不等结束。

- [ ] **Step 1: 写失败的测试**

`routes.test.ts` 的 Pass 2 describe 里,**既有的一次性 JSON 断言全部要改成 SSE 解析**(这是破坏性传输变更,`app.inject` 拿到的 body 从 JSON 变成 SSE 文本;给测试加一个解析 helper):

```ts
  /** 把 SSE 文本解析成 {event, data}[] —— 归类改流式后所有断言走这个 */
  const sseEvents = (body: string) =>
    body.split('\n\n').filter((b) => b.trim()).map((b) => ({
      event: /^event: (.+)$/m.exec(b)?.[1] ?? 'message',
      data: JSON.parse(/^data: (.*)$/m.exec(b)?.[1] ?? '{}') as Record<string, unknown>,
    }));
```

新用例:

```ts
  it('run-pass-2 是 SSE:每批 progress(带 ruleCount),结束时 done', async () => {
    const { app, db } = makeApp();
    seed(db);
    const work = await seedWorkcopy(app);
    // 两批:两次 mock 返回(每批 1 条,batchSize 由 mock 的 ctx 决定不够真实 ——
    // makeApp 存的是 qwen2.5:14b → FALLBACK ctx → batchSize=68,3 条只会 1 批。
    // **要逼出多批,种 >68 条**;这里用 70 条)
    for (let i = 0; i < 70; i++) upsertItem(db, { id: `BV${i}`, type: 2, title: `标题${i}` });
    mocks.complete.mockImplementation(async ({ messages }: { messages: { content: string }[] }) => {
      // 按喂进来的条目数回对应条数的 assignments
      const n = (messages[1]!.content.match(/^\[BV/gm) ?? []).length;
      return JSON.stringify(Array.from({ length: n }, (_, i) => ({}))); // 占位,下一行修正
    });
    // ↑ 上面这个 mock 写不出 itemId —— 改成从 prompt 里抠 itemId 原样返回:
    mocks.complete.mockImplementation(async ({ messages }: { messages: { content: string }[] }) => {
      const ids = [...messages[1]!.content.matchAll(/^\[(BV\w+)\]/gm)].map((m) => m[1]!);
      return JSON.stringify(ids.map((id) => ({ itemId: id, folderTempId: String(work), confidence: 0.9, reason: 'r' })));
    });

    const sid = await newSession(app);
    const res = await app.inject({ method: 'POST', url: `/api/curator/sessions/${sid}/run-pass-2` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');

    const events = sseEvents(res.body);
    const progress = events.filter((e) => e.event === 'progress');
    expect(progress.length).toBeGreaterThanOrEqual(2);          // 70 条 / 68 = 2 批
    expect(progress[0]!.data.ruleCount).toBe(2);                 // seed 的 BV1/BV2 被规则接走(上条用例存的规则还在?—— 不,makeApp 每 test 重建。**这里不该断言 ruleCount=2**,见下)

    const done = events.find((e) => e.event === 'done')!;
    expect(done).toBeDefined();
    expect((done!.data.total as number)).toBe(72);
    await app.close();
  });
```

> **写测试时注意两处**:`makeApp()` 每个用例重建内存库,规则断言要在本用例里自己 `saveRule`;`upsertItem` 需要 import(`routes.test.ts` 已有)。上面第一条 progress 的 `ruleCount` 断言改为:在本用例开头 `saveRule(db, work, [{ field: 'title', any: ['a'] }], 'user')`,然后断言 `progress[0]!.data.ruleCount).toBe(2)`(seed 的两条标题是 'a'/'b',只有 'a' 命中 —— **实际是 1,按真实值写**)。

**分批落库**的用例:

```ts
  it('归类的结果分批落库 —— 每批完成就是一次 saveClassification(upsert)', async () => {
    const { app, db } = makeApp();
    seed(db);
    const work = await seedWorkcopy(app);
    for (let i = 0; i < 70; i++) upsertItem(db, { id: `BV${i}`, type: 2, title: `标题${i}` });
    mocks.complete.mockImplementation(async ({ messages }: { messages: { content: string }[] }) => {
      const ids = [...messages[1]!.content.matchAll(/^\[(BV\w+)\]/gm)].map((m) => m[1]!);
      return JSON.stringify(ids.map((id) => ({ itemId: id, folderTempId: String(work), confidence: 0.9, reason: 'r' })));
    });
    // 第一批的 mock 在第一批完成后中止 —— 模拟"用户中断"
    const controller = new AbortController();
    let calls = 0;
    mocks.complete.mockImplementation(async ({ messages }: { messages: { content: string }[] }) => {
      calls += 1;
      if (calls >= 2) controller.abort();
      const ids = [...messages[1]!.content.matchAll(/^\[(BV\w+)\]/gm)].map((m) => m[1]!);
      return JSON.stringify(ids.map((id) => ({ itemId: id, folderTempId: String(work), confidence: 0.9, reason: 'r' })));
    });

    const sid = await newSession(app);
    await app.inject({ method: 'POST', url: `/api/curator/sessions/${sid}/run-pass-2` });

    // **落库的不是 0 就是全部** —— 中断时已完成的批次要留下
    const stored = getClassification(db, sid)!;
    expect(stored.assignments.length).toBeGreaterThan(0);
    expect(stored.assignments.length).toBeLessThan(72); // 不是全部(第二批没跑)
    await app.close();
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -w server -- src/curator/routes.test.ts`
Expected: FAIL —— 响应还是一次性 JSON,`content-type` 对不上、没有 progress 帧

- [ ] **Step 3: 实现**

`run-pass-2` 路由整体重写(`routes.ts:285` 起)。保留的部分:会话/工作副本校验、`listRules` + 规则匹配 + `ruleAssignments`/`rest` 的计算、samples 组装 —— **这些一行不动**。变的是应答方式与 `runPass2` 的接线:

```ts
    // ── 应答改成 SSE(§9D A1)──────────────────────────────
    // hijack 之后没法再回 4xx —— 所以**全部校验都在 hijack 之前做完**
    // (会话存在、llm 已配、work.length > 0 的三个 4xx 分支保持在 hijack 前面)
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    /** 客户端还在吗 —— 每批发起前检查(§9D B2),死了就不开下一批 */
    const closed = () => reply.raw.writableEnded || reply.raw.destroyed;
    const controller = new AbortController();
    req.raw.on('close', () => controller.abort());

    try {
      if (ruleAssignments.length > 0) {
        saveClassification(db, id, ruleAssignments, []);
      }

      const result = rest.length
        ? await runPass2({
            config: llm.config, ctx: llm.ctx, folders, items: rest, samples,
            signal: controller.signal,
            onProgress: (p) => {
              // §9D A2:每批完成立刻落库 + 发进度。upsert,最后一版就是完整结果
              saveClassification(db, id, [...ruleAssignments, ...resultSoFar], failedSoFar);
              void p; // 见下:resultSoFar 在闭包里由 runPass2 的逐批回调维护 ——
                      // **实现时把"收集 assignments"从 runPass2 的返回值改为回调期间自己累积**,
                      // 具体做法:onProgress 里拿不到本批数据,所以路由在 runPass2 之外
                      // 维护不了 —— 见 Step 3 末尾的说明,正确做法是给 runPass2 的
                      // onProgress 再带上本批 assignments,或改用 onBatch 回调。
            },
          })
        : { assignments: [], failedBatches: [] };
      ...
```

> **Step 3 的自我纠正(实现者照这段做,别照上面那段)**:`onProgress` 只带计数不带数据,路由没法在回调里落库本批结果。**把回调改名为 `onBatch`,签名带上本批的 assignments**:
> ```ts
> onBatch?: (b: { batch: number; batches: number; done: number; total: number; assignments: readonly Assignment[] }) => void;
> ```
> (Task 2 的 Step 3 就直接用 `onBatch` 这个名字和形状 —— Task 2 的测试同步改成断言 `onBatch`。)路由侧:
> ```ts
>       const collected: Assignment[] = [];
>       let failedSoFar: FailedBatch[] = [];
>       const result = rest.length
>         ? await runPass2({
>             config: llm.config, ctx: llm.ctx, folders, items: rest, samples,
>             signal: controller.signal,
>             onBatch: (b) => {
>               collected.push(...b.assignments);
>               // **每批落库一次**(§9D A3):规则接走的 + 已完成的批次
>               saveClassification(db, id, [...ruleAssignments, ...collected], failedSoFar);
>               reply.raw.write(`event: progress\ndata: ${JSON.stringify({
>                 batch: b.batch, batches: b.batches, done: b.done, total: b.total,
>                 ruleCount: ruleAssignments.length,
>               })}\n\n`);
>             },
>           })
>         : { assignments: [], failedBatches: [] };
>       // failedBatches 只在结尾拿到 —— 中途缩批失败也照旧攒着,最终一次随 done 发出
> ```
> 缩批失败的批次在 runPass2 内部进 `failedBatches`,路由在 done 帧才拿到 —— **中途落库的 failedSoFar 先置空是错的**。修正:`saveClassification` 的 failed 参数在进度回调期间传 `[]`,**done 帧之前**把最终 failedBatches 再 upsert 一次补上。中断时(abort)失败批次本来就少,可接受;完整跑完时最终版一定带上。**或者**(更干净):Task 2 让 `onBatch` 也带 `failedBatches`(整个数组,截至本批)—— 照这个做,签名:
> ```ts
> onBatch?: (b: { batch: number; batches: number; done: number; total: number;
>                  assignments: readonly Assignment[]; failedBatches: readonly FailedBatch[] }) => void;
> ```
> Task 2 的测试相应断言 `failedBatches` 字段存在且随批更新。

收尾:

```ts
      if (closed()) return; // 客户端已断 —— 不用再写 done,连接没了
      const assignments = [...ruleAssignments, ...result.assignments];
      saveClassification(db, id, assignments, result.failedBatches); // 最终版(带 failedBatches)
      log.event({
        level: 'info', category: 'llm',
        message: `Pass 2 完成:规则 ${ruleAssignments.length} 条 + AI ${result.assignments.length} 条,${result.failedBatches.length} 批失败`,
      });
      reply.raw.write(`event: done\ndata: ${JSON.stringify({
        assignments, failedBatches: result.failedBatches, total: items.length,
        ruleCount: items.length - rest.length,
        aiCount: result.assignments.filter((a) => a.folderTempId !== null).length,
        suggestions, batchSize: batchSize(llm.ctx),
      })}\n\n`);
    } catch (e) {
      if (controller.signal.aborted) {
        // §9D B5:**主动中断是 warn,不是 error** —— 不是故障,是用户的行为
        log.event({ level: 'warn', category: 'llm', code: 'PASS2_ABORTED', message: '用户中止了归类 —— 已完成的批次已保留' });
        if (!closed()) reply.raw.write(`event: aborted\ndata: {"reason":"已中止"}\n\n`);
      } else {
        const message = (e as Error)?.message ?? String(e);
        log.event({ level: 'error', category: 'llm', code: 'PASS2_FAILED', message });
        if (!closed()) reply.raw.write(`event: error\ndata: ${JSON.stringify({ reason: message })}\n\n`);
      }
    } finally {
      reply.raw.end();
    }
```

**suggestions 的接线保持 Task 8(M4c)的现状**:建议调用在中止时同样被 `.catch` 成 `[]` —— 中断后建议不需要单独处理,`aborted` 分支先于它发生(它在 done 帧之前)。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -w server -- src/curator/routes.test.ts`
Expected: PASS(所有 Pass 2 用例改用 `sseEvents` 解析后全绿)

- [ ] **Step 5: 全量 + 提交**

```bash
npm test -w server
npm run typecheck -w server
git add server/src/curator/routes.ts server/src/curator/routes.test.ts
git commit -m "feat(curator): run-pass-2 改 SSE —— 每批进度 + 分批落库 + 可中止

 hijack 前完成全部 4xx 校验;每批 onBatch 落库一次(upsert,最终版带
 failedBatches);req.raw close → abort,provider 随之停。AbortError 记
 warn 不记 error —— 主动中断不是故障(§9D B5)。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: 聊天路由接中止 + 前端 API 层

**Files:**
- Modify: `server/src/curator/routes.ts:148-177`(`messages` SSE 路由接 `req.raw.on('close')` + 透传 signal)
- Modify: `web/src/api.ts`(`streamMessage` 加 signal;新增 `classifyStream`)
- Modify: `web/src/types.ts`(ProgressPayload)
- Test: `server/src/curator/routes.test.ts`(聊天中止用例)

**Interfaces:**
- Consumes: Task 1 的 `stream(..., { abortSignal })`
- Produces:
  ```ts
  // web/src/api.ts
  export async function streamMessage(
    sessionId: number, content: string,
    onDelta: (delta: string) => void,
    opts?: { signal?: AbortSignal },          // ← 新增
  ): Promise<string>
  export async function classifyStream(
    sessionId: number,
    onProgress: (p: ProgressPayload) => void, // ← 新增,§9D A2
  ): Promise<Pass2Response>                     // 解析 done 帧返回同一形状
  // web/src/types.ts
  export interface ProgressPayload {
    batch: number; batches: number; done: number; total: number; ruleCount: number;
  }
  ```

- [ ] **Step 1: 写失败的测试(服务端:聊天中止)**

```ts
  it('messages:客户端断开 → 流停止,半截回复落库并标注(已中断)', async () => {
    const { app, db } = makeApp();
    seed(db);
    const sid = await newSession(app);

    // stream mock:吐 3 个 chunk 后挂起(模拟还没生成完),让测试主动断开
    mocks.stream.mockImplementation(async ({ onChunk }: { onChunk: (s: string) => void }) => {
      onChunk('第一段');
      onChunk('第二段');
      await new Promise(() => {}); // 永不 resolve —— 等待 abort
    });

    // 发起请求,拿到响应后立刻断开
    const page = app.inject({ method: 'POST', url: `/api/curator/sessions/${sid}/messages`, payload: { content: '整理一下' } });
    await page; // inject 会等到 headers;SSE hijack 后 inject 的语义:body 到 done/error 才结束 ——
    // **测试技巧**:不能等 inject 完成(它不会完成)。改用底层:
    //   直接构造 http 请求太重 —— 现实做法是依赖 hijack 后的 req.raw close 事件,
    //   inject 环境里客户端断开难以模拟 → 这条用例改测**服务端单元行为**:
    //   把 close 模拟为手动触发 controller.abort() 后,断言 provider 收到 signal + 落库半截。
    // —— 实现:把"abort 后落半截"的逻辑放进 chatStream 可测的回调(见 Step 3)。
    await app.close();
  });
```

> **测试可行性说明(实现者必读)**:`app.inject` 无法模拟客户端中途断开 —— SSE 流在 hijack 后 inject 会一直等到 `end()`。所以这条用例的**可测单元**是:`chatStream` 接受可选 `signal`,`stream` 被中止抛 AbortError 时,`chatStream` 把**已拼的全文**返回而不是抛出。路由层只负责把 `req.raw close → controller.abort()` 接上(一行,靠 code review)。用例写成:

```ts
  it('chatStream 被中止 → 返回已生成的半截,不抛', async () => {
    const { chatStream } = await import('./chat.js');
    const { db, sid } = fresh();  // chat.test.ts 里已有的 helper;若写在 routes.test.ts 则用 makeApp + newSession
    mocks.stream.mockImplementation(async ({ onChunk }: { onChunk: (s: string) => void }) => {
      onChunk('第一段');
      throw new Error('This operation was aborted');
    });
    const controller = new AbortController();
    controller.abort();
    const full = await chatStream({ db, sessionId: sid, config, ctx: smallCtx, userMessage: '问', signal: controller.signal });
    expect(full).toBe('第一段');
  });
```

- [ ] **Step 2: 实现(服务端)**

`chat.ts` 的 `chatStream`:`opts` 加 `signal?: AbortSignal`;`stream(...)` 调用透传;catch 里**区分中止**:

```ts
    try {
      const full = await stream({ ..., ...(opts.signal ? { abortSignal: opts.signal } : {}) });
      ...
    } catch (e) {
      const aborted = opts.signal?.aborted || /aborted/i.test(String((e as Error)?.message));
      if (aborted) {
        // §9D B3:半截也是信息 —— 流到一半的全文落库,标注后返回(不抛)
        const partial = /* stream 的 onChunk 已把全文拼进调用方的累计 —— 见下 */;
        ...
      }
      throw e;
    }
```

> **实现细节**:`stream` 当前把全文累计在自己内部(`let full = ''`,onChunk 回调的是 delta)。要拿到"半截",`chatStream` 自己也按 delta 累计一份:
> ```ts
>   let partial = '';
>   const full = await stream({
>     ...,
>     onChunk: (delta) => { partial += delta; opts.onChunk(delta); },
>     ...(opts.signal ? { abortSignal: opts.signal } : {}),
>   });
> ```
> 中止时 `partial` 就是半截。`chatStream` 的现有契约是"返回全文(由调用方落库)"(`chat.ts:172-198`),路由的 finally/落库逻辑不动 —— **中止时 chatStream 返回 `partial` 而不是抛**,路由的 catch 分支就能照常落库。落库的标注在**路由层**做:`full = partial + '(已中断)'`(或前端展示层标注,二选一;**按 §9D B3 原文,落库内容带标注**,即路由层在 `event: done` 前把 content 换成 `partial + '\n\n(已中断)'`)。

`messages` 路由(`routes.ts:148`):

```ts
    const controller = new AbortController();
    req.raw.on('close', () => controller.abort());
    try {
      const full = await chatStream({ ..., signal: controller.signal });
      reply.raw.write(`event: done\ndata: ${JSON.stringify({ content: full })}\n\n`);
    } catch (e) { ...原样(AbortError 实际到不了这里 —— chatStream 中止时返回半截)... }
```

- [ ] **Step 3: 实现(前端)**

`web/src/api.ts` 的 `streamMessage`:

```ts
export async function streamMessage(
  sessionId: number,
  content: string,
  onDelta: (delta: string) => void,
  opts: { signal?: AbortSignal } = {},   // ← 新增,默认不传 = 旧行为
): Promise<string> {
  const res = await fetch(`/api/curator/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  ...其余原样...
```

新增 `classifyStream`(照 `streamMessage` 的骨架,处理 progress 帧):

```ts
/** 归类的流式应答(§9D A1):progress 帧喂给 onProgress,done 帧的载荷原样返回 */
export async function classifyStream(
  sessionId: number,
  onProgress: (p: ProgressPayload) => void,
  opts: { signal?: AbortSignal } = {},
): Promise<Pass2Response> {
  const res = await fetch(`/api/curator/sessions/${sessionId}/run-pass-2`, {
    method: 'POST',
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { reason?: string };
    throw new Error(body.reason ?? `请求失败 ${res.status}`);
  }
  if (!res.body) throw new Error('服务端没有返回流');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done: Pass2Response | null = null;
  let failure: string | null = null;

  for (;;) {
    const { done: eof, value } = await reader.read();
    if (eof) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() ?? '';
    for (const block of events) {
      const event = /^event: (.+)$/m.exec(block)?.[1] ?? 'message';
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (!data) continue;
      if (event === 'progress') onProgress(JSON.parse(data) as ProgressPayload);
      else if (event === 'done') done = JSON.parse(data) as Pass2Response;
      else if (event === 'aborted') throw new DOMException('已中止', 'AbortError');
      else if (event === 'error') failure = (JSON.parse(data) as { reason?: string }).reason ?? '归类失败';
    }
  }
  if (failure) throw new Error(failure);
  if (!done) throw new Error('服务端没有返回归类结果');
  return done;
}
```

`types.ts` 加 `ProgressPayload`(字段见 Produces)。`Pass2Response` 不变(done 帧的形状就是它)。

- [ ] **Step 4: 验证 + 提交**

```bash
npm test -w server
npm run typecheck -w server
cd web && npm run typecheck && npx max build && cd ..
git add server/src/curator/routes.ts server/src/curator/chat.ts server/src/curator/chat.test.ts web/src/api.ts web/src/types.ts
git commit -m "feat: 聊天可中止(半截落库+标注)+ 前端 classifyStream 吃进度帧

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 5: 抽屉的两枚按钮两态 + 进度行

**Files:**
- Modify: `web/src/components/ChatDrawer.tsx`(发送按钮、归类按钮、进度行、中断提示)

**Interfaces:**
- Consumes: Task 4 的 `classifyStream` / `streamMessage(..., { signal })`;`ProgressPayload`
- Produces: 无新导出(UI only)

**§9D.2 的形状**:

```
[发送 ▸] ←→ [■ 停止](danger 红边;hover 加亮;忙碌中输入框不禁用)
[按现在这份结构归类] ←→ [■ 停止]
进度行:第 5/11 批 · 已归 1365/2976 条 · 规则已接 274 条
中断后:已中断:5/11 批完成 —— 已完成的保留,重跑会算剩下的
```

- [ ] **Step 1: 状态与发送按钮**

`ChatDrawer.tsx` 里已有 `busy` state。加:

```tsx
  // §9D B1:进行中 = 最需要可点的时刻,loading 转圈不可点是对"进行中"的错误表达
  const classifyAbort = useRef<AbortController | null>(null);
  const chatAbort = useRef<AbortController | null>(null);
  const [progress, setProgress] = useState<ProgressPayload | null>(null);
  const [interrupted, setInterrupted] = useState('');
```

发送按钮改两态(`busy` 已存在,直接用):

```tsx
        <Button
          type="primary"
          danger={busy}                                   // 停止态用 danger 红边(§11.2 红色=操作)
          icon={busy ? <Square size={14} /> : <Send size={14} />}
          aria-label={busy ? '停止生成' : '发送'}
          disabled={!busy && !input.trim()}               // 忙碌时**不禁用** —— 它现在是停止键
          onClick={() => (busy ? chatAbort.current?.abort() : void send(input))}
        />
```

`send()` 里创建 controller 并在 finally 清理:

```tsx
  const send = async (text: string) => {
    ...既有校验...
    const controller = new AbortController();
    chatAbort.current = controller;
    try {
      await streamMessage(sid, text, onDelta, { signal: controller.signal });
    } catch (e) {
      if (controller.signal.aborted) return;              // 用户主动停 —— 不是错误
      setError((e as Error).message);
    } finally {
      chatAbort.current = null;
    }
  };
```

> `send` 的现有实现里"流中断不落半截"的行为由服务端保证(半截随 `event: done` 的 content 来),前端只需在 aborted 时静默返回。`onDelta` 累计的 `streaming` 字符串在 abort 后**保留在气泡里**(它就是用户看到的半截),`done` 到来时用服务端落库的全文覆盖。

从 `lucide-react` 补 `Square` import。

- [ ] **Step 2: 归类按钮两态 + 进度行**

`runClassify()` 改用 `classifyStream`:

```tsx
  const runClassify = async () => {
    ...既有会话准备...
    const controller = new AbortController();
    classifyAbort.current = controller;
    setBusy(true);
    setProgress(null);
    try {
      const r = await classifyStream(sid, (p) => setProgress(p));
      setSuggestions(r.suggestions);
      setDetail(await curatorApi.getSession(sid));
      const unclassified = r.assignments.filter((a) => a.folderTempId === null).length;
      setNotice(
        `归类完成:规则 ${r.ruleCount} 条 · AI ${r.aiCount} 条 · 未归类 ${unclassified} 条(共 ${r.total} 条)` +
        (r.failedBatches.length ? `;${r.failedBatches.length} 批没成功,那些条目没归上,留在原处` : ''),
      );
    } catch (e) {
      if (controller.signal.aborted) {
        setInterrupted('已中断 —— 已完成的批次保留在归类结果里,重跑会算剩下的');
      } else {
        setError((e as Error).message);
      }
    } finally {
      classifyAbort.current = null;
      setProgress(null);
      setBusy(false);
    }
  };
```

归类按钮改两态:

```tsx
          <Button
            size="small"
            danger={busy}
            icon={busy ? <Square size={12} /> : undefined}
            onClick={() => (busy ? classifyAbort.current?.abort() : void runClassify())}
          >
            {busy ? '停止' : detail?.classification ? '重新归类' : '按现在这份结构归类'}
          </Button>
```

进度行(放在归类按钮那块的面板里,`busy && progress` 时显示):

```tsx
          {busy && progress && (
            <div style={{ fontSize: 'var(--fs-12)', color: 'var(--text-dim)', marginTop: 6 }}>
              第 <span className="num">{progress.batch}</span>/<span className="num">{progress.batches}</span> 批
              · 已归 <span className="num">{progress.done.toLocaleString()}</span>/<span className="num">{progress.total.toLocaleString()}</span> 条
              {progress.ruleCount > 0 && <> · 规则已接 <span className="num" style={{ color: 'var(--accent)' }}>{progress.ruleCount.toLocaleString()}</span> 条</>}
            </div>
          )}
          {!busy && interrupted && (
            <div style={{ fontSize: 'var(--fs-12)', color: 'var(--warn)', marginTop: 6 }}>{interrupted}</div>
          )}
```

- [ ] **Step 3: typecheck + build**

Run: `cd web && npm run typecheck && npx max build`
Expected: 都通过

- [ ] **Step 4: 手动验证清单(spec §9D 没写自动化 UI 测试的等价物,这三条是真机验收)**

1. 发一条长消息(让它多写点),流式输出中点「■ 停止」→ 生成立即停,气泡里是半截 + `(已中断)`,再发新消息正常
2. 点「按现在这份结构归类」→ 进度行出现并跳动(第 1/11 批 → …),中途点「停止」→ 进度停,黄色提示"已中断",重跑正常
3. 全程右下角(顶栏)AI 图标的工作中状态照常闪烁/停止

- [ ] **Step 5: 提交**

```bash
git add web/src/components/ChatDrawer.tsx
git commit -m "feat(web): 发送/归类按钮两态化(进行中=停止)+ 归类进度行

loading 转圈不可点是对'进行中'的错误表达 —— 进行中恰恰是最需要可点的时刻
(§9D B1)。停止态 danger 红边;中断后黄字提示已完成多少。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Self-Review

### 1. Spec 覆盖(§9D 逐条)

| §9D 条款 | 落在哪 |
|---|---|
| A1 归类传输改 SSE | T3(照聊天路由的 hijack 样板) |
| A2 progress 帧(带 batches 与 ruleCount) | T2 的 `onBatch` 签名 + T3 的 progress 帧 + T4 的 `ProgressPayload` |
| A3 分批落库(upsert) | T3(`saveClassification` 每批一次 + 最终版带 failedBatches) |
| A4 done/error 帧与聊天形状对齐 | T3(done 帧载荷 = 旧一次性 JSON 的形状)+ T4(`classifyStream` 解析) |
| B1 按钮两态(同一枚) | T5(发送 + 归类两枚) |
| B2 abort 真停(provider 不再继续) | T1(signal 透传)+ T2(批间检查 + 批内 signal)+ T3/T4(`req.raw close → controller.abort`) |
| B3 半截回复落库 + (已中断) | T4(`chatStream` 中止返回 partial,路由层加标注落库) |
| B4 归类中断保留已完成批次 | T3(每批 upsert)+ T5(中断提示文案) |
| B5 AbortError 记 warn | T3(catch 分支区分 `signal.aborted`) |
| §9D.2 进度行形状("第 5/11 批…") | T5(逐字实现) |
| §9D.3 不做暂停/继续、不做断点续跑、Pass 1 不动 | 无任务做它们 ✓ |
| §9D.4 批语义不变 | T2 明确"缩批逻辑原样" ✓ |

**一处设计偏离,显式说明**:spec §9D A2 写的回调是 `onProgress`,实现改为 `onBatch`(多带本批 `assignments` 与截至本批的 `failedBatches`)。原因写在 T3 Step 3 的自我纠正里:路由要在每批落库,`onProgress` 只带计数拿不到数据。spec 的 A2 帧格式**不变**(`{batch, batches, done, total, ruleCount}`),变的只是引擎内部回调名 —— 帧契约是前后端之约,回调是内部接口。**建议 spec 顺手把 A2 的"引擎回调"一词改为"onBatch"以保持一致**(一行编辑,若你同意我改)。

### 2. Placeholder 扫描

T3 Step 1 的测试代码里有一段**写错又自我纠正的 mock**(两段 `mockImplementation`,第一段标了"占位,下一行修正")。这是**故意保留的教学痕迹**还是 plan 缺陷?按"No Placeholders"标准是缺陷 —— **实现者应只抄第二段(带 `matchAll` 抠 itemId 的那份)+ 按 note 修正 ruleCount 断言**。执行 brief 里会明确"只抄修正版"。除此之外无 TBD/TODO/"适当处理"。

### 3. 类型一致性

- `ProgressPayload` 帧字段(`T3` 发出的)与 `T4` 前端类型逐字段一致:`batch/batches/done/total/ruleCount`
- `onBatch`(T2 定义)与 T3 的消费一致;`batches`/`batch` 从 1 计,`done`/`total` 是条目数 —— T2 测试 `{batch:1,batches:1,done:3,total:3}` 钉死
- `classifyStream` 的返回类型就是既有 `Pass2Response`(done 帧载荷),无新类型漂移
- `streamMessage` 新参在**末尾**且可选 —— 既有调用点(不传)不破

## Execution Handoff

Plan 完成并保存到 `docs/superpowers/plans/2026-09-17-M4d-abort-and-progress.md`。两个执行选项:

1. **Subagent-Driven(推荐)** —— 每个任务派新 subagent,任务间评审
2. **Inline** —— 本会话按 executing-plans 批量执行

选哪个?
