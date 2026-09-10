# 文件夹分组资产视图 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在单一虚拟滚动容器中恢复按文件夹分组资产与分组折叠。

**Architecture:** 新增纯分组模型，把当前资产页转换为文件夹标题与资产项目组成的扁平数组；新增虚拟分组视图负责统一计算行高度、滚动范围和可见项目。现有查询、分页、标签集合关系和状态字段继续复用。

**Tech Stack:** React、TypeScript、Node test runner、Tauri/Rust 现有 V2 API。

## Global Constraints

- 不读取全库资产到前端；资产查询页上限保持 300。
- 不为每个文件夹创建独立滚动容器。
- 网格和列表模式共享同一分组项目模型。
- 折叠状态使用 `AssetState.collapsedGroupIds`。

---

### Task 1: 分组项目纯函数

**Files:**
- Create: `src/components/groupedAssetModel.ts`
- Test: `tests/asset-query.test.ts`

**Interfaces:**
- Produces `buildGroupedAssetItems(assets: Asset[], folders: Folder[], collapsedGroupIds: string[]): GroupedAssetItem[]`。
- `GroupedAssetItem` 为 `{ kind: 'header'; groupId; folder; assetCount }` 或 `{ kind: 'asset'; asset }`。

- [ ] **Step 1: 写失败测试**：验证同一文件夹合并、折叠只保留标题、未知文件夹进入固定组。
- [ ] **Step 2: 运行 `npm run test:ts` 确认新导入/断言失败。**
- [ ] **Step 3: 实现稳定分组和扁平化，组按路径排序，资产保留输入顺序。**
- [ ] **Step 4: 重新运行测试，确认分组测试通过。**
- [ ] **Step 5: 提交 `feat: add grouped asset item model`。**

### Task 2: 单一虚拟分组视图

**Files:**
- Create: `src/components/VirtualGroupedAssetView.tsx`
- Modify: `src/components/MainArea.tsx`
- Test: `tests/asset-query.test.ts`

**Interfaces:**
- `VirtualGroupedAssetView` 接收 `items`, `viewMode`, `collapsedGroupIds`, `onToggleGroupCollapse` 及现有资产交互回调。

- [ ] **Step 1: 写失败的源码合同测试**：确认普通区域调用分组视图，并传入折叠状态和折叠回调。
- [ ] **Step 2: 运行测试确认失败。**
- [ ] **Step 3: 实现单一滚动容器，标题项目和资产项目共用虚拟范围；标题高度固定，资产高度按网格/列表模式计算。**
- [ ] **Step 4: 在 `MainArea` 中用分组视图替换当前独立资产网格/列表区域，保留文件夹卡片入口和空状态。**
- [ ] **Step 5: 运行 TypeScript 检查和前端测试。**
- [ ] **Step 6: 提交 `feat: restore virtual grouped asset view`。**

### Task 3: 交互与回归验证

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/components/MainArea.tsx`
- Modify: `tests/asset-query.test.ts`

- [ ] **Step 1: 写测试确认折叠一个组不会隐藏其他组，且网格/列表共享项目模型。**
- [ ] **Step 2: 运行测试确认失败。**
- [ ] **Step 3: 接入现有 `handleToggleGroupCollapse`，删除不再使用的旧直通资产渲染路径。**
- [ ] **Step 4: 运行 `npm run lint`、`npm run test:ts`、`cargo test --manifest-path src-tauri/Cargo.toml`。**
- [ ] **Step 5: 运行 `git diff --check` 并提交 `fix: verify grouped folder interactions`。**
