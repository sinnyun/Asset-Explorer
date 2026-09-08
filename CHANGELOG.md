# CHANGELOG

本文件记录 Asset-Explorer 桌面端各版本的变更。规则：每次修改历史追加在本文件末尾，不覆盖旧记录。

---

## v0.1.0 (2026-09-08) — 实时监控重构与优化

### 背景
- 原监控仅依赖 notify 事件源，存在漏检、目录增删改/重命名失效、新子文件夹不上屏等问题。
- 确立原则：**文件系统为唯一真相源**，数据库仅是**可丢弃的缓存**；通过「对账」保证二者一致，避免全量重扫。

### 核心设计（详阅 PLAN_realtime_reconcile.md）
- **文件 mtime/size 与 文件夹 mtime 严格分离**：
  - 文件内容修改只更新该文件自身的 mtime，**所有祖先目录 mtime 不变**（无向上级联）。
  - 目录 mtime 仅当**直接子项被增/删/改名**（结构变化）时才变化。
- **Pruned / Deep 两种对账模式**：
  - `Pruned`：目录 mtime 与库内一致 → 整棵子树剪枝跳过；不一致 → 深扫该子树。剪枝逐层进行。
  - `Deep`：无条件全量按文件 mtime/size 差异重读（新建/重命名目录后使用）。
- **事件快速通道 + 对账兜底**：
  - 单文件 增/删/改 走 notify 快速通道秒级生效。
  - 目录级 创建/重命名/移动 下沉为受范围子树对账。
  - 周期 60s + 窗口回焦 以 Pruned 模式对账兜底，纠正事件漏检。

### 关键保证
- **单文件/小文件修改绝不引发父级重扫**：文件内容变化不会改变目录 mtime，Pruned 对账在根目录即短路返回；即便结构变化，也只在 mtime 变化的那一层深扫，其余子树逐层剪枝。

### 变更文件
- `src-tauri/src/models.rs`：`Folder` 新增 `mtime` 字段。
- `src-tauri/src/database.rs`：`folders` 表新增 `mtime` 列迁移；新增 `upsert_folder` / `get_asset_signatures_under` / `delete_folder_tree_by_path` / `delete_assets_by_prefix` 等方法。
- `src-tauri/src/sync.rs`（新增）：对账模块 `reconcile_root` / `walk_disk` / `ReconcileMode`，产出并推送增量事件。
- `src-tauri/src/watcher.rs`：重写事件快速通道 `flush_events`，目录级操作下沉子树对账；修复 `resolve_folder_id` / `ensure_dir_chain` 挂载与删除/重命名。
- `src-tauri/src/commands.rs`：新增 `reconcile_monitored_folders` 指令。
- `src-tauri/src/main.rs`：注册 `sync` 模块、周期 60s 与窗口回焦 Pruned 对账、注册 reconcile 指令。
- `src/hooks/useFileMonitoring.ts`：新增监听 `folder:added` / `folder:updated` / `folder:removed` 实时刷新目录树。

### 说明
- 本次为后端重构主体 + 前端目录树实时事件。后续可继续优化前端状态合并粒度、大目录拖入的节流策略。