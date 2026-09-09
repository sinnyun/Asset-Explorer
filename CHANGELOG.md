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

---

## v0.1.1 (2026-09-08) — 修改联动元数据重读 + 大目录拖入批量入库

### 背景
- v0.1.0 的快速通道在文件内容被修改时只更新 mtime/size，图片宽高与哈希停留在旧值，详情面板数据与磁盘脱节。
- 逐文件入库路径存在 N 次 `get_folders()` 全表查询 + 单条 SAVE，超大目录拖入时数据库往返过多。

### 变更内容
1. **修改事件联动重读元数据**（`watcher.rs` `handle_file_modified`）：
   - 图片类资产：重新提取 width/height（`metadata_extractor::extract_metadata`）。
   - 哈希：体积 ≤ 阈值（图片 2MB / 其他 1MB，与 sync.rs 对账口径一致）时重算 SHA-256；大文件跳过全量读盘、保留旧值。
   - 新增 `database.rs` `update_asset_signature`：单语句更新 date_modified/size/width/height/file_hash，替代原先两次 `update_asset_field` 往返。
2. **批量新增 + 目录缓存**（`watcher.rs`）：
   - `flush_events` 一次 `get_folders()` 同时构建 路径→id 缓存，本批所有新增文件共享，消除逐文件全表查询。
   - `handle_file_added`（逐文件）改为 `handle_file_additions`（批量）：内存构建全部资产 → `batch_save_assets` 单事务入库 → 统一广播事件。
   - `resolve_folder_id` 改为缓存优先（命中直取，未命中走 `ensure_dir_chain` 并回填缓存）；`backfill_existing_assets` 同样接入缓存。
3. **死代码清理**：删除已无引用的 `update_asset_field`、`get_folders_under`。

### 效果
- 文件内容修改后，详情面板的尺寸/哈希随磁盘实时准确。
- 拖入 1000 文件级别的目录时：目录解析从 1000 次全表查询降为 1 次，入库从 1000 个独立写事务降为 1 个批量事务；事件侧原有 300ms 微批 + 前端 50ms 合并保持不变。

### 变更文件
- `src-tauri/src/database.rs`：新增 `update_asset_signature`；删除 `update_asset_field` / `get_folders_under`。
- `src-tauri/src/watcher.rs`：`handle_file_modified` 联动重读；`handle_file_additions` 批量入库；`resolve_folder_id` 缓存化；`backfill_existing_assets` 接缓存。

---

## v0.1.2 (2026-09-09) — 修复补齐索引编译错误

### 背景
- v0.1.1 将 `resolve_folder_id` 改为缓存化时，函数签名新增了 `app_handle: &AppHandle` 参数（供未命中缓存时调用 `ensure_dir_chain` 补建目录链），但 `backfill_existing_assets` 内的调用点漏改，导致编译失败（E0061：参数数量不匹配）。

### 变更内容
- `src-tauri/src/watcher.rs`：`backfill_existing_assets` 内 `resolve_folder_id` 调用补回 `app_handle` 实参。

### 效果
- `cargo check` 通过，零错误零警告，应用可正常启动。

---

## v0.1.3 (2026-09-09) — 修复重命名文件后从界面消失

### 背景
- 用户反馈：监控文件夹内文件改名后，旧路径能正确触发 `asset:removed`，但新路径没有触发 `asset:added`，文件从界面"消失"。添加/删除均正常，唯独重命名失效。

### 根因
- `indexer.rs` 的初始扫描 `build_asset` **不按扩展名过滤**，所有文件（含 `.cdr`、`.ai`、`.indd` 等 `mime_guess` 无法归类的"other"类型）都会入库。
- 但运行时监控链路（`watcher.rs` `handle_file_additions` / `backfill_existing_assets`、`sync.rs` `walk_disk` / `build_asset_from_disk`）均加了 `if infer_category_from_extension(ext) == "other" { continue/return None }` 的过滤。
- 结果：`.cdr` 这类设计文件初始扫描能入库，但被改名后新路径的 `Create` 事件与兜底对账都被"other"过滤拦截，新路径无法重新入库。`folder:updated` 仍会广播（父目录 mtime 变化），但资产层面永远只删不增。

### 变更内容
- `src-tauri/src/watcher.rs`：
  - `handle_file_additions` 移除 `infer_category_from_extension(ext) == "other"` 过滤。
  - `backfill_existing_assets` 同步移除该过滤。
- `src-tauri/src/sync.rs`：
  - `walk_disk` 移除 "other" 扩展名跳过，使对账与初始扫描口径一致。
  - `build_asset_from_disk` 移除 `if asset_type == "other" { return None }`，让对账能把改名后的设计文件重新入库。

### 效果
- 文件改名后新路径会同时由「Create 快速通道」+「兜底对账」两条路径补回入库，前端能立即看到改名后的文件。
- `cargo check` 通过，零错误零警告。

### 设计说明
- 本修复采用「与 indexer 初始扫描对齐」的口径，不再按扩展名区分"应入库/不应入库"。初始扫描本就索引所有非忽略目录下的文件，运行时监控与对账也保持同一行为，避免「初始能入、运行时被滤」的不一致。
- 若未来需要按扩展名精筛，应在 `indexer.rs` 的初始扫描同步加过滤，确保三条链路（初始扫描 / 事件快速通道 / 兜底对账）口径完全一致。

---

## v0.1.4 (2026-09-09) — 修复删除监控文件夹后界面不刷新

### 背景
- 用户反馈：删除一个监控文件夹后，界面没有刷新，该文件夹下的资产仍显示；需重启程序后内容才会消失。

### 根因
- `delete_folder` 指令仅做了 `db.delete_folder()` + `registry.remove_folder()`，**未广播任何事件**给前端。
- 前端 `handleDeleteFolder` 的乐观更新只移除了文件夹行本身，**未移除该文件夹下的资产**。
- 由于 DB 层 `folders`/`assets` 表均配 `ON DELETE CASCADE` 且 `PRAGMA foreign_keys = ON`，DB 删除会级联清理子文件夹与资产；重启时前端重新读取 DB 自然就看不到已删内容，但运行时前端状态与 DB 脱节，所以"不重启就不消失"。

### 变更内容
- `src-tauri/src/commands.rs`：
  - `delete_folder` 删除前先取出完整 `Folder` 对象（含 id/path），DB 删除 + 注销监控器后，广播 `folder:removed` 事件。
  - 前端 `folder:removed` 监听器（`useFileMonitoring.ts`）已实现"移除该文件夹及其整棵子孙树 + 清理其下全部资产"的逻辑，收到事件即可即时清理界面状态，无需重启。

### 效果
- 删除监控文件夹后，界面即时移除该文件夹、子文件夹及全部资产，无需重启。
- `cargo check` 通过，零错误零警告。