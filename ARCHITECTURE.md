# Rust 后端分离式功能架构与替换指南

本项目后端采用严格的 **单一职责原则 (Single Responsibility Principle)** 与 **模块彻底解耦架构**。
每个功能组件均封装在单独的 `.rs` 代码文件中，未来您若需升级、修改或替换某一项功能，仅需对该特定文件进行调整，无需变动其他业务逻辑。

---

## 模块清单与职责划分

| 功能组件 | 对应代码文件 | 采用开源库 (Crates) | 核心职责与设计说明 |
| :--- | :--- | :--- | :--- |
| **本地数据库管理** | `src-tauri/src/database.rs` | `rusqlite` (bundled), `dirs`, `parking_lot` | **【核心数据引擎】** 管理嵌入式 SQLite 数据库连接、WAL 高并发日志模式、表结构迁移、所有资产/文件夹/标签/智能文件夹的 CRUD 持久化与百万级记录原子事务批处理。 |
| **索引文件夹** | `src-tauri/src/indexer.rs` | `walkdir`, `rayon` | 递归遍历用户本地磁盘文件夹树，自动排除隐藏文件和构建缓存 (`node_modules` 等)，并发发现文件并组织结构。 |
| **数据聚合** | `src-tauri/src/aggregator.rs` | `rayon`, `serde` | 对海量资产数据进行多维聚合统计（按类型、格式、文件夹、标签、评分分布、大小区间分箱），支持智能规则多核并行过滤。 |
| **元数据提取** | `src-tauri/src/metadata_extractor.rs` | `infer`, `image`, `sha2` | 基于文件魔数自动探测真实 MIME 类型，轻量读取图片分辨率宽高，并进行流式 SHA256 哈希计算。 |
| **缩略图缓存** | `src-tauri/src/thumbnail_cache.rs` | `image`, `dirs` | 自动在 Windows `%LOCALAPPDATA%\AssetHub\thumbnails` 建立磁盘缓存，支持多规格高质量缩放，避免重复解码。 |
| **文件监控** | `src-tauri/src/watcher.rs` | `notify` | 监控已添加工作区文件夹的本地增删改操作，后台线程感知事件并向前端发送刷新指令。 |
| **IPC 指令路由** | `src-tauri/src/commands.rs` | `tauri`, `tokio` | 统一管理暴露给前端的 Tauri Command，所有任务均调度到 Tokio 后台工作线程池，**绝不阻塞主线程**。 |
| **数据模型定义** | `src-tauri/src/models.rs` | `serde` | 跨模块统一的序列化模型（Asset, Folder, Tag, SmartFolder 等），与前端 TypeScript 类型精确映射。 |

---

## 核心架构原则实现细节

### 1. 数据库与数据操作完全移入后端
- **物理数据库文件**：自动保存在 Windows 本地安全目录 `%LOCALAPPDATA%\AssetHub\assethub.db`。
- **开源方案**：选用 `rusqlite` 并开启 `bundled` 特性，SQLite C 源码直接编译打入二进制，用户电脑无需单独安装任何 SQLite 环境或 DLL。
- **关系表结构设计**：
  - `assets`：存储所有资产元数据、哈希、评分、收藏、宽高、路径等。
  - `folders`：层次化文件夹树。
  - `tags` / `collections`：分类与多对多关联表 (`asset_tags`, `asset_collections`)。
  - `smart_folders`：智能规则持久化配置表。

### 2. 前端纯显示，操作交给后端
- 前端 React 界面只负责渲染视图和捕获用户输入（如重命名、打标签、星级评分、创建智能文件夹）。
- 所有的操作均由 `src/services/dataService.ts` 派发给 `desktopBridge.ts`，由 Rust 底层 SQLite 执行持久化变更。

### 3. 全链路非阻塞 (Non-blocking & Zero-lag)
- **Rust 后端**：所有数据库读写、文件遍历、图像解码全部包裹在 `tokio::task::spawn_blocking` 中在后台线程池执行，主 UI 进程永远保持 60+ FPS。
- **数据库引擎**：开启 `PRAGMA journal_mode = WAL;`（预写日志），读写操作完全分离互不阻塞。
- **前端调用**：全部采用异步 Promise，配合乐观 UI 响应机制，点击按钮即刻反应，体验丝滑流畅。

---

## 单独修改与替换示例

### 场景 1：如果想更换或升级「数据库引擎」(`database.rs`)
- **文件定位**：`src-tauri/src/database.rs`
- **说明**：比如未来希望引入 DuckDB 处理千万级分析，或者开启 SQLite FTS5 全文搜索，只需修改 `database.rs` 中的表初始化和查询方法，其他索引、聚合或前端代码完全不受影响。

### 场景 2：如果想更换或优化「索引文件夹」算法 (`indexer.rs`)
- **文件定位**：`src-tauri/src/indexer.rs`
- **说明**：若未来希望引入 `ignore` 库读取 `.gitignore` 规则，只需直接修改 `indexer.rs`，保持返回 `Result<ScanResult, String>`。

### 场景 3：如果想替换「缩略图生成库」(`thumbnail_cache.rs`)
- **文件定位**：`src-tauri/src/thumbnail_cache.rs`
- **说明**：若未来集成 GPU 硬件加速或 FFmpeg 提取视频封面，仅需在 `thumbnail_cache.rs` 内替换实现。
