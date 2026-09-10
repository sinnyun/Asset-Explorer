# 中间文件夹层级控制与索引进度实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为中间文件夹卡片增加固定数字层级过滤，并让桌面扫描显示阶段、数量、百分比、速度和预计剩余时间。

**Architecture:** 新增纯函数负责按当前文件夹上下文计算卡片相对深度，`MainArea` 只过滤卡片展示数组；左侧树继续使用原始 `state.folders` 和 `expandedFolderIds`。扫描后端通过现有 Tauri 事件流发送紧凑统计字段，`useScanMonitor` 负责兼容旧事件并计算 UI 状态，`ScanProgressBar` 负责展示。

**Tech Stack:** React 19, TypeScript, Tauri 2, Rust, SQLite, Node `node:test`。

## Global Constraints

- 层级控制只作用于中间文件夹卡片，不修改左侧文件树。
- 层级按钮固定显示 `1 2 3 4 5 6 7 8 ∞`，默认值为 `3`。
- 项目内部资产和子文件夹仍由现有 active-folder/include-subfolders 逻辑控制。
- 扫描事件不得发送资产快照；继续保持增量写库和边扫边显示。
- 总量未知时不得显示虚假的百分比；旧事件字段缺失时使用安全默认值。

---

### Task 1: 文件夹卡片深度计算纯函数

**Files:**
- Create: `src/services/folderCardDepth.ts`
- Modify: `tests/asset-query.test.ts`

**Interfaces:**
- Produces `filterFoldersByDepth(folders: Folder[], contextFolderId: string | undefined, maxDepth: number | typeof Infinity): Folder[]`。
- `contextFolderId` 未定义时以 `parentId` 为空的根集合为第 1 层；有上下文时以该文件夹的直接子级为第 1 层。

- [ ] **Step 1: Write the failing tests**

在 `tests/asset-query.test.ts` 增加真实纯函数测试：三层树在深度 1、2、3 和 `Infinity` 下返回正确 ID；切换上下文后内部层级从 1 重新计算；缺失父节点和循环不会抛错。

```ts
test('folder card depth filters relative to the current folder context', () => {
  const folders = [
    { id: 'root', name: 'Root', path: 'D:/Root', parentId: undefined },
    { id: 'category', name: 'Category', path: 'D:/Root/Category', parentId: 'root' },
    { id: 'project', name: 'Project', path: 'D:/Root/Category/Project', parentId: 'category' },
    { id: 'inside', name: 'Inside', path: 'D:/Root/Category/Project/Inside', parentId: 'project' },
  ].map(folder => ({ ...folder, isMonitored: false, tags: [], collections: [] }));
  assert.deepEqual(filterFoldersByDepth(folders, undefined, 2).map(folder => folder.id), ['root', 'category']);
  assert.deepEqual(filterFoldersByDepth(folders, 'project', 1).map(folder => folder.id), ['inside']);
  assert.deepEqual(filterFoldersByDepth(folders, undefined, Infinity).map(folder => folder.id), ['root', 'category', 'project', 'inside']);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm run test:ts -- --test-name-pattern="folder card depth"`

Expected: FAIL because `src/services/folderCardDepth.ts` and `filterFoldersByDepth` do not exist yet.

- [ ] **Step 3: Implement the minimal depth filter**

Build a `Map` by folder ID, walk each folder's `parentId` toward the supplied context, stop on missing IDs or cycles, and retain folders whose calculated relative depth is within `maxDepth`. Treat a folder directly under the context as depth 1. For a missing/cyclic ancestry, retain the folder as a safe direct item instead of throwing.

- [ ] **Step 4: Run the focused test and the existing suite**

Run: `npm run test:ts -- --test-name-pattern="folder card depth"`

Expected: PASS.

Run: `npm run test:ts`

Expected: all existing tests plus the new depth tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/folderCardDepth.ts tests/asset-query.test.ts
git commit -m "feat: add folder card depth filtering"
```

### Task 2: 中间区域数字层级控制

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/components/MainArea.tsx`
- Modify: `tests/asset-query.test.ts`

**Interfaces:**
- `MainArea` consumes `folderCardDepth: number | typeof Infinity` and `onFolderCardDepthChange`.
- `App` owns `folderCardDepth`, initialized to `3`, and passes the existing `filteredFolders` through `filterFoldersByDepth` for the middle card list only.

- [ ] **Step 1: Write failing source-contract tests**

Assert that `MainArea` renders numeric controls `1` through `8` and `∞`, receives a depth value, and that `App` keeps `filteredFolders` separate from `state.folders`. Assert that `FolderRender.tsx` is unchanged by the feature wiring.

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm run test:ts -- --test-name-pattern="folder card depth control"`

Expected: FAIL because the new prop and controls are absent.

- [ ] **Step 3: Implement the controls and display filtering**

Add a compact button group in `MainArea`'s top toolbar. Use `aria-label="文件夹卡片显示层级"`, show active state for the current value, stop click propagation, and use `∞` for `Infinity`. Add an `App` state value and memoized display list. Do not pass the filtered list to sidebar components.

- [ ] **Step 4: Run tests and type check**

Run: `npm run test:ts` and `npm run lint`.

Expected: all tests pass and TypeScript exits with code 0.

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx src/components/MainArea.tsx tests/asset-query.test.ts
git commit -m "feat: add numeric folder card depth control"
```

### Task 3: 后端扫描进度统计字段

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/indexer.rs` only if the existing `ScanBatch` payload cannot expose total/progress data
- Modify: `src-tauri/src/database_v2_tests.rs`

**Interfaces:**
- `scan:started` payload adds `folderName` and `phase: "discovering"` while preserving `path` and `rootId`.
- `scan:progress` payload adds `done`, `total`, `phase`, `ratePerSecond`, and optional `etaSeconds`.
- `scan:finished` payload adds `phase: "finished"` while preserving existing totals.

- [ ] **Step 1: Write a failing Rust contract test**

Add a source contract test asserting the scan command emits `folderName`, `phase`, `total`, `ratePerSecond`, and `etaSeconds` fields without emitting asset arrays or `scan:chunk` snapshots.

- [ ] **Step 2: Run the focused Rust test and verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml database_v2_tests::scan_progress_payload_is_compact`

Expected: FAIL because the new event fields are absent.

- [ ] **Step 3: Implement bounded statistics**

Track the scan start time and last emitted count in `start_scan_job`. Emit the total when the streaming indexer reports it; calculate rate only after elapsed time is positive and calculate ETA only when total is known and rate is positive. Keep the existing 200 ms emission throttle and never include asset lists.

- [ ] **Step 4: Run Rust tests**

Run: `cargo test --manifest-path src-tauri/Cargo.toml database_v2_tests::scan_progress_payload_is_compact`.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands.rs src-tauri/src/indexer.rs src-tauri/src/database_v2_tests.rs
git commit -m "feat: expose compact scan progress statistics"
```

### Task 4: 前端扫描进度展示

**Files:**
- Modify: `src/hooks/useScanMonitor.ts`
- Modify: `src/components/ScanProgressBar.tsx`
- Modify: `tests/asset-query.test.ts`

**Interfaces:**
- `ScanProgress` adds `phase`, `ratePerSecond`, and `etaSeconds`.
- The hook accepts both new and old events, preserving existing start/finish/failure behavior.

- [ ] **Step 1: Write failing tests**

Add tests for phase labels, unknown total handling, speed/ETA rendering, and source wiring for the new event fields.

- [ ] **Step 2: Run focused tests and verify they fail**

Run: `npm run test:ts -- --test-name-pattern="scan progress"`

Expected: FAIL because the new fields and labels are absent.

- [ ] **Step 3: Implement hook compatibility and presentation**

Parse optional numeric fields with finite-value guards. Keep `total === 0` indeterminate. Render `已处理 / 总量`, percentage when known, `每秒 N 个`, and `预计剩余 N 秒` when available. Render fixed Chinese phase labels from the phase codes and preserve the existing failure/finished states.

- [ ] **Step 4: Run full frontend checks**

Run: `npm run test:ts`, `npm run lint`, and `npm run build`.

Expected: all tests pass, type check passes, and Vite/server production build exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useScanMonitor.ts src/components/ScanProgressBar.tsx tests/asset-query.test.ts
git commit -m "feat: show detailed indexing progress"
```

### Task 5: 集成验证与交付

**Files:**
- Modify: none unless verification finds an issue

- [ ] **Step 1: Review the plan against the design**

Verify that only the middle card list consumes `folderCardDepth`, `FolderRender.tsx` remains unchanged, project context resets relative depth, and scan events remain compact.

- [ ] **Step 2: Run the complete verification set**

Run: `npm run lint`, `npm run test:ts`, `cargo test --manifest-path src-tauri/Cargo.toml`, and `npm run build`.

Expected: TypeScript checks pass, frontend tests pass, Rust tests pass except any pre-existing unrelated flaky test must be reported with its exact name, and production build exits 0.

- [ ] **Step 3: Inspect the final diff and status**

Run: `git diff HEAD~4..HEAD --stat` and `git status --short`.

Expected: only the planned depth/progress files and tests are changed; working tree is clean.
