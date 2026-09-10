# Asset Explorer V2 数据存储与读写说明

## 存储位置

桌面端数据库固定为 `%LOCALAPPDATA%\AssetHub\assethub-v2.db`，缩略图位于同一应用数据目录。V2 不读取、迁移或删除旧 `assethub.db`。数据库可从文件系统重新构建，但用户标记在正常扫描、监控刷新和文件暂时离线期间必须保留。

Web 端使用 PostgreSQL，Drizzle schema 位于 `src/db/schema.ts`，API 契约与桌面 V2 相同。

## SQLite 表及所有权

| 表 | 内容 | 写入者 |
| --- | --- | --- |
| `app_meta` | schema epoch、全局 revision | 数据库事务 |
| `roots` | 监视根、在线/dirty、活动和完成代次 | 扫描协调器 |
| `folders` | 路径树、mtime、代次、版本 | 扫描/监控 |
| `assets` | 可重建文件事实、软删除、记录版本 | 扫描/监控 |
| `asset_user_state` | 评分、收藏、颜色、自定义名、备注 | 用户修改命令 |
| `tags` / `collections` | 用户分类实体 | 用户修改命令 |
| `asset_tags` / `asset_collections` | 多对多关系 | 用户修改命令 |
| `smart_folders` | 查询规则 | 用户修改命令 |
| `scan_jobs` | 可恢复任务状态 | 索引协调器 |
| `file_event_journal` | 合并后的待处理路径 | 监控恢复链路 |
| `asset_errors` | 阶段性错误 | 索引/元数据链路 |
| `mutation_operations` | 幂等修改操作记录 | 批量修改事务 |

扫描写入绝不能触碰 `asset_user_state` 或两张关联表。文件重新扫描时只更新 `assets` 中的文件事实，并递增 `record_version`。

## 资产生命周期

1. 发现文件：按规范化路径和稳定 ID UPSERT `assets`。
2. 修改文件：更新 size、mtime、类型、尺寸等事实；用户状态不变。
3. 文件消失：设置 `deleted_at`，不删除用户状态。
4. 同一 ID 重新出现：UPSERT 将 `deleted_at` 清空，原用户状态重新关联。
5. 根目录完整扫描成功：只清理 `last_seen_generation` 不是当前代次的记录。
6. 扫描失败、取消或根离线：不执行第 5 步。

## 路径身份

Windows 路径在 Rust 中统一：去除外围空白、`/` 转 `\`、大小写归一、移除非盘符根的末尾分隔符。`assets.normalized_path` 与 `folders.normalized_path` 都唯一。盘符根如 `D:\` 保留根分隔符。

文件 ID 由规范化完整路径的 SHA-256 前 8 字节生成。未来可在取得 NTFS volume/file ID 时优先使用稳定文件身份，以在跨目录重命名时完全保留 ID。

## 扫描代次事务

`begin_root_scan` 原子递增 `roots.active_generation`；每个文件夹/资产批次写入该 generation。`complete_root_scan` 先确认传入代次仍是活动代次，再在一个事务中软删除未见资产、删除未见文件夹、更新 `completed_generation` 与 revision。

晚到的旧任务无法完成新代次，因为活动代次校验会失败。这避免并发扫描或取消后旧任务误删新数据。

## 查询

`query_assets_v2` 使用参数化 SQL，允许的排序字段是名称、mtime、大小，均以 ID 作为稳定次级键。游标编码排序类型、排序值和 ID；游标与查询排序不匹配时返回错误。页面大小被强制限制为 1–300。

`query_folders_v2` 只读取一个层级，并返回 `assetCount`、`hasChildren`；前端展开时再请求子级。`get_asset_details_v2` 只接受明确 ID，最多 1000 个。

用户批量修改由 `mutate_assets_v2` 执行。显式 ID 最多 1000 个；大范围操作传递 `SelectionExpression { query, excludedIds }`，后端在事务内把目标查询物化到临时表，不把几十万 ID 送入前端。`operation_id` 在 `mutation_operations` 中唯一，重试返回原结果；可选 `expected_version` 用于冲突检测。

主要 SQLite 索引：

- `idx_folders_parent_name(parent_id, name, id)`
- `idx_folders_root_path(root_id, normalized_path)`
- `idx_assets_folder_name(folder_id, name COLLATE NOCASE, id)`
- `idx_assets_folder_mtime(folder_id, mtime_ns DESC, id)`
- `idx_assets_folder_size(folder_id, size DESC, id)`
- `idx_assets_root_path(root_id, normalized_path)`
- `idx_assets_type_mtime(asset_type, mtime_ns DESC, id)`
- `idx_user_favorite_rating(favorite, rating, asset_id)`
- FTS5 `assets_fts(name, path, asset_type)` 与受控触发器

## 并发与背压

- WAL 允许读写并行。
- 只读连接池最多 4 个连接。
- 写入只有一个执行线程，队列容量 256。
- 扫描每批 200 条，事务中不做文件 I/O。
- SQLite 单条语句绑定参数按 500 分块，避免超过变量限制。
- 查询页、详情 ID、监控事件、索引任务和缩略图请求均有明确上限。

## Revision 与缓存失效

成功修改数据的事务递增 `app_meta.revision`。WorkspaceShell 和 AssetPage 返回 revision，前端以查询键缓存页面。扫描进度或文件事件只发送紧凑的 `query:invalidated`，前端重新读取活动查询，而不是将事件载荷并入全局资产数组。

## PostgreSQL 对应设计

Web 表按 `user_id` 隔离数据。`folders(user_id,path)` 和 `assets(user_id,path)` 唯一；资产对文件夹名称、修改时间、大小、收藏/评分建立用户前缀索引；`asset_tags`、`asset_collections` 使用复合主键防重复。`/api/v2` 统一限制 300 条并返回与桌面相同的 DTO。

当前 Web 游标是不可见的版本化 offset cursor；桌面 SQLite 使用 keyset cursor。若 Web 数据达到高并发百万级，下一步应将 Web cursor 升级为与桌面相同的 `(sort_value,id)` keyset，避免深 offset 成本。

## 备份与恢复

关闭窗口时执行 WAL checkpoint。可备份 `assethub-v2.db` 及 `-wal/-shm`（运行中备份应使用 SQLite backup API）。数据库损坏时可移走 V2 文件并重新索引；旧数据库不会受影响。缩略图是纯缓存，可独立清理并按源版本重建。
