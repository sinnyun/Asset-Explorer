# Asset Explorer (AssetHub)

**本地高性能数字资产管理系统**，支持 **桌面版（Rust + Tauri + SQLite）** 与 **Web 版（Express + PostgreSQL + Firebase）** 双端运行，面向海量素材（10 万级）提供分类检索、智能过滤与实时文件监控能力。

> 本项目受 Eagle 和 Blender 设计理念启发，将**前端界面展示**与**底层数据引擎**彻底解耦：React 界面只负责渲染与交互，所有文件索引、数据持久化、聚合统计等重活全部交由后端引擎完成。

---

## 目录

- [功能特性](#功能特性)
- [运行环境](#运行环境)
- [架构总览](#架构总览)
- [模块级说明](#模块级说明)
  - [前端核心模块](#前端核心模块)
  - [前端组件模块](#前端组件模块)
  - [前端服务层模块](#前端服务层模块)
  - [数据库模块](#数据库模块)
  - [Rust 后端模块](#rust-后端模块)
- [快速开始](#快速开始)
- [本地开发](#本地开发)
- [构建部署](#构建部署)
- [配置说明](#配置说明)
- [已有文档](#已有文档)

---

## 功能特性

| 能力 | 说明 |
| :--- | :--- |
| **多环境支持** | 同一套代码同时支持桌面（Tauri + Rust + SQLite）和 Web（Express + PostgreSQL + Firebase） |
| **本地文件夹监视** | 添加本地目录后自动索引所有文件，支持**实时监听**文件增删改并自动刷新界面 |
| **分类标签系统** | 可自定义标签（含名称、颜色、描述），支持跨文件夹对资产进行分类 |
| **专属集合** | 按项目或主题归集资产，支持主题色、描述、置顶与排序 |
| **智能文件夹** | 基于规则引擎（文件名、标签、集合、类型）动态聚合资产，支持 AND/OR 匹配 |
| **双分列对比视图** | 监视工作区与子项目双列并排独立浏览，可识别父子嵌套层级 |
| **资产缩略图** | 桌面版使用 Windows Shell 原生缓存 + Rust 图像库双通道生成，懒加载以 base64 显示 |
| **一键数据迁移** | 完整迁移 SQLite 数据库、WAL 日志、缩略图缓存至指定磁盘目录 |
| **启动资产校验** | 自动清理数据库中文件已被删除的无效资产记录 |
| **深色/浅色主题** | 跟随系统、深色、浅色三种模式 |

---

## 运行环境

本项目可以在三种环境模式下运行：

| 模式 | 数据存储 | 后端引擎 | 适用场景 |
| :--- | :--- | :--- | :--- |
| **桌面模式** | 本地 SQLite (`%LOCALAPPDATA%\AssetHub\assethub.db`) | Rust (Tauri IPC) | Windows 本地部署，扫描本地磁盘文件 |
| **远程 Web 模式** | 云端 PostgreSQL | Node.js (Express API) | AI Studio / Cloud Run 云端部署 |
| **本地 Web 模式** | 本地 PostgreSQL | Node.js (Express API) | 开发调试环境 |

环境自动检测由 `src/services/environment.ts` 完成，前端无需手动配置。

---

## 架构总览

```text
┌─────────────────────────────────────────────────────────────────────┐
│                        前端 (React 19 + Vite)                        │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────────┐ │
│  │  App.tsx      │  │  components/ │  │      services/            │ │
│  │  (状态中枢)    │  │  UI 组件层    │  │  ┌─────────────────────┐ │ │
│  └──────┬───────┘  └──────┬───────┘  │  │ DataService (统一调度) │ │ │
│         │                  │           │  └────────┬────────────┘ │ │
│         └──────────────────┼───────────┘           │              │
│                            │             ┌─────────┴─────────┐    │
│                            │             │        │          │    │
│                    ┌───────▼───────┐ ┌───▼───┐ ┌──▼──────────┐ │
│                    │ Web Api Client │ │EnvDet │ │DesktopBridge│ │
│                    └───────┬───────┘ └───┬───┘ └──────┬───────┘ │
└────────────────────────────┼──────────────┼────────────┼──────────┘
                             │              │            │
                 ┌───────────▼───┐  ┌───────▼───────┐   │ (Tauri IPC)
                 │ Express API   │  │ Firebase Auth  │   │
                 │ (RESTful)     │  └───────────────┘   │
                 └───────────┬───┘                      │
                             │ (Drizzle ORM)            │
                     ┌───────▼────────┐   ┌─────────────▼──────────┐
                     │ PostgreSQL DB  │   │  Rust 后端 (src-tauri/) │
                     └────────────────┘   │  ├─ database.rs (SQLite) │
                                          │  ├─ indexer.rs           │
                                          │  ├─ aggregator.rs        │
                                          │  ├─ metadata_extractor.rs│
                                          │  ├─ thumbnail_cache.rs   │
                                          │  ├─ watcher.rs           │
                                          │  └─ commands.rs          │
                                          └──────────────────────────┘
```

**核心设计原则：**

1. **前后端彻底解耦** — 前端 `dataService.ts` 作为唯一数据入口，根据运行环境自动选择数据源
2. **全链路非阻塞** — 所有 IO 操作均为异步 Promise / Rust spawn_blocking，UI 永不卡顿
3. **乐观 UI 更新** — 点击操作先更新本地状态，同时异步持久化到后端
4. **桌面优先** — Web 模式仅为开发/云端预览用途，桌面模式完整覆盖扫描、监控、缩略图等核心能力

---

## 模块级说明

### 前端核心模块

#### `src/main.tsx` — 应用入口
React 应用入口文件。创建根节点并将 `App` 组件挂载到 HTML 的 `#root` 元素。启用 React 19 `StrictMode`。

#### `src/App.tsx` — 主应用容器与全局状态管理
应用的核心中枢，承担以下职责：

- **全局状态管理** — 维护 `AssetState`（资产、文件夹、标签、集合、选中项、视图模式、排序方式、主题等全部前端状态）
- **异步数据加载** — 通过 `dataService.loadWorkspace()` 从后端加载完整工作区数据
- **文件监控事件监听** — 桌面模式下监听 Rust 后端发出的 `asset:added` / `asset:removed` / `asset:modified` 事件，实时刷新视图
- **业务操作处理** — 包含全部事件处理器：选中资产/文件夹、切换视图、排序、搜索、创建/编辑/删除标签/集合/智能文件夹/文件夹、上下文菜单、批量操作、主题切换、路径重定向等
- **资产筛选逻辑** — 根据当前激活的文件夹/智能文件夹/标签/集合及搜索条件过滤资产
- **渲染顶层布局** — 组合 `Sidebar`（左栏）、`MainArea`（中央画布）、`PropertiesPanel`（右属性面板）及各弹窗组件

#### `src/types.ts` — TypeScript 类型定义
定义前端全部核心实体类型，与 Rust 后端 `models.rs` 中的结构精确映射：

| 类型 | 说明 |
| :--- | :--- |
| `Asset` | 资产：名称、类型(image/video/model/document/folder)、大小、修改时间、路径、标签、集合、缩略图URL等 |
| `Folder` | 文件夹：ID、名称、物理路径、是否监视、父级ID、标签、集合等 |
| `Tag` | 标签：名称、颜色、描述、是否置顶、排序 |
| `Collection` | 集合：名称、颜色、描述、是否置顶、排序 |
| `SmartFolderRule` | 智能文件夹规则：类型(name/tag/collection/type)、操作符(contains/equals)、匹配值 |
| `SmartFolder` | 智能文件夹：名称、图标、规则、匹配模式(AND/OR)、是否为搜索历史 |
| `AssetState` | 全局应用状态：全部数据集合、当前激活项、视图设置、排序方式、主题等 |

#### `src/data.ts` — 模拟数据与内置智能文件夹
提供 Web 开发模式下使用的本地模拟数据（约 2000 个资产、100+ 文件夹、150 个标签、120 个集合），以及系统内置的 5 个智能文件夹预设（全部资产、最近添加、未分类、图片、3D 模型）。

#### `src/index.css` — 全局样式
Tailwind CSS 入口文件，包含全局样式与自定义滚动条样式。

---

### 前端组件模块

#### `src/components/Sidebar.tsx` — 左侧导航栏
应用左侧双栏导航界面，包含：

- **主导航列** — 切换 Workspace 文件夹 / Smart Folders / Tags / Collections 四个标签页
- **文件夹树** — 递归渲染文件夹层级，支持展开/折叠、搜索、右键菜单、显示资产计数与监视标记
- **智能文件夹列表** — 分内置、自定义和搜索历史三组展示，显示实时匹配数、置顶排序
- **标签列表** — 显示颜色标识与匹配资产计数，支持搜索过滤
- **集合列表** — 显示颜色标识与匹配资产计数，支持搜索过滤
- **底部操作** — "添加本地监视文件夹"与"存储设置与系统迁移"入口
- 所有列表均支持右键上下文菜单操作

#### `src/components/MainArea.tsx` — 主内容区域
中央资产浏览画布，核心功能包括：

- **顶部工具栏** — 搜索输入框、子文件夹过滤开关、排序下拉框、视图切换（网格/列表）、双分列对比视图开关
- **资产网格视图** — 按文件夹分组展示资产缩略图卡片，显示文件格式角标、标签/集合指示、大小与日期
- **资产列表视图** — 紧凑列表模式，包含图标、名称、大小、修改日期
- **文件夹分组折叠** — 支持展开/收起文件夹分组
- **缩略图懒加载** — 桌面模式下调用 `dataService.getAssetThumbnail` 将本地路径缩略图转为 base64 data URL 后展示，避免 file:// 安全限制
- **性能保护** — 最多渲染 100 组文件夹，每组最多 500 个资产，超出显示警告提示

#### `src/components/PropertiesPanel.tsx` — 右侧属性面板
根据当前上下文自动切换展示不同实体的详细属性，优先级依次为：

1. 画布中选中的单个文件夹 → `FolderProperties`
2. 画布中选中的单个资产 → 资产详情面板（文件信息、关联标签、快捷操作）
3. 画布中批量选中的项 → 批量统计面板
4. 激活的标签 → `TagProperties`
5. 激活的集合 → `CollectionProperties`
6. 激活的智能文件夹 → `SmartFolderProperties`
7. 激活的文件夹 → `FolderProperties`
8. 兜底 → 应用总览统计面板

#### `src/components/ContextMenu.tsx` — 右键上下文菜单
通用右键菜单组件，支持：
- 自动调整菜单位置防止超出窗口边界
- ESC 键关闭
- 点击/右键菜单外部关闭
- 危险操作（红色样式）与分隔符

#### `src/components/BulkActionBar.tsx` — 批量操作栏
当多选资产/文件夹时，底部悬浮显示操作栏，支持：
- 批量添加标签
- 批量添加集合
- 批量删除
- 清除选中

#### `src/components/AddMonitoredFolderModal.tsx` — 添加监视文件夹弹窗
用于添加并扫描本地监视文件夹的模态窗口：
- 支持输入路径或通过 Windows 原生对话框浏览选择
- 自动检测与现有监视文件夹的层级嵌套关系（父子/独立）
- 显示路径关系提示与扫描进度状态

#### `src/components/CreateEntityModal.tsx` — 创建实体弹窗
通用的创建标签/集合模态窗口：
- 支持名称输入（去重校验）
- 预设色彩选择 + 自定义色值
- 描述说明输入
- 置顶开关
- 动态适配创建标签与创建集合两种模式

#### `src/components/RenameModal.tsx` — 重命名弹窗
通用重命名模态窗口，支持名称非空校验与实时错误提示。

#### `src/components/SettingsModal.tsx` — 设置弹窗
系统设置界面，包含两个标签页：

- **数据存储与完整迁移**
  - 展示当前数据存储目录与磁盘占用统计（数据库、缩略图缓存、总计）
  - 一键完整迁移功能：将 SQLite 数据库 + WAL + 缩略图缓存原子迁移至新目录并自动重启
  - 资产源文件路径重定向：批量更新数据库中记录的物理路径前缀（如 C 盘→D 盘）
- **主题与外观**
  - 浅色/深色/跟随系统三选一

#### `src/components/ThumbnailImage.tsx` — 缩略图图片组件
统一处理资产缩略图展示的可复用组件：
- **Web 环境** — 直接使用 `asset.thumbnailUrl`
- **桌面环境** — 自动调用 `dataService.getAssetThumbnail`，通过 Rust IPC 读取/生成缩略图并以 base64 data URL 返回
- 提供 loading 中动画与失败占位图标

#### `src/components/MonitoredSplitView.tsx` — 双分列对比视图
本地监视文件夹的双列并排独立浏览视图：
- 自动识别监视文件夹的父子嵌套层级关系
- 左列展示父级工作区的完整文件夹树与全部素材
- 右列独立展示嵌套子项目或另一个独立工作区的专属内容
- 每列均有独立搜索框与文件夹树展开/收起功能

#### `src/components/properties/` — 实体属性面板组件子目录

- **`TagProperties.tsx`** — 标签详情面板：名称重命名、色彩选择（预设 + HEX 自定义）、描述编辑、置顶/排序/删除操作、关联资产/文件夹统计、缩略图预览
- **`CollectionProperties.tsx`** — 集合详情面板：名称重命名、主题色标选择、描述编辑、置顶/排序/删除、收录资产统计与缩略图预览
- **`SmartFolderProperties.tsx`** — 智能文件夹详情面板：名称重命名、图标选择（12 种）、描述编辑、匹配规则构建器（AND/OR、添加/删除/修改规则）、实时匹配统计、缩略图预览。内置智能文件夹仅显示属性说明，不可编辑规则
- **`FolderProperties.tsx`** — 文件夹详情面板：名称重命名、物理路径展示与复制、资源管理器定位、监视开关、子文件夹数量与资产统计、同级目录排序

---

### 前端服务层模块

#### `src/services/dataService.ts` — 统一数据服务引擎 ⭐ 核心调度层
项目数据访问的**唯一入口**，根据运行环境自动路由数据源：

| 方法 | 职责 | 桌面(Rust) | Web(HTTP API) | Mock 降级 |
| :--- | :--- | :--- | :--- | :--- |
| `loadWorkspace` | 加载全量工作区数据 | ✅ Rust IPC + 重试 | ✅ Express API | ✅ |
| `scanDirectory` | 扫描本地目录 | ✅ Rust 后台 | ❌ | ✅ (模拟) |
| `getAssetThumbnail` | 获取缩略图 base64 | ✅ 读缓存/生成 | N/A | N/A |
| `validateAssets` | 校验无效资产路径 | ✅ 清理过期记录 | ❌ | ❌ |
| `setAssetRating` | 更新评分 | ✅ | ✅ | N/A |
| `setAssetFavorite` | 更新收藏 | ✅ | ❌ | N/A |
| `deleteAssets` | 批量删除 | ✅ | ✅ | N/A |
| `createFolder/updateFolder/deleteFolder` | 文件夹 CRUD | ✅ | ✅ | N/A |
| `createTag/updateTag/deleteTag` | 标签 CRUD | ✅ | ✅ | N/A |
| `createCollection/updateCollection/deleteCollection` | 集合 CRUD | ✅ | ✅ | N/A |
| `saveSmartFolder/deleteSmartFolder` | 智能文件夹 CRUD | ✅ | ✅ | N/A |
| `getStorageStats` | 获取存储统计 | ✅ | ✅ | 默认值 |
| `migrateDataStorage` | 完整数据迁移 | ✅ | 模拟 | N/A |
| `restartApplication` | 重启应用 | ✅ | `window.location.reload()` | N/A |

**重要设计**：桌面模式绝不允许降级到 Web API 或模拟数据，避免桌面 UI 混入 C:/Workspace 等 Web 模拟路径。

#### `src/services/desktopBridge.ts` — Rust IPC 通信适配层
前端与 Rust Tauri 后端的通信桥梁：
- 封装安全的 `invoke()` 异步调用，支持动态导入失败检测与日志分级
- 提供 `RustWorkspacePayload` / `RustScanResult` / `RustStorageStats` 等数据结构类型
- 定义全部 25+ 个 IPC 命令封装函数，与 Rust `commands.rs` 一一对应
- 内置 `isTauriDesktop()` 环境检测，非桌面环境安全返回 null
- 提供 Windows 原生文件夹选取对话框封装

#### `src/services/webApiClient.ts` — Web API 客户端
Web 模式下的 HTTP 请求封装：
- 自动获取 Firebase 当前用户认证令牌（Bearer token）
- 统一请求超时管理（远程 30s / 本地 15s）
- 错误分类处理（401 未授权、超时、网络异常、HTTP 错误）
- 提供与 `desktopBridge.ts` 一致的方法签名，使 `dataService` 可无缝切换数据源

#### `src/services/environment.ts` — 环境检测引擎
自动检测当前运行环境并返回配置信息：

```ts
type AppEnvironment = 'desktop' | 'remote-web' | 'local-web';
```

检测优先级：**Tauri 桌面 > 远程 Web > 本地 Web**
- 桌面检测：`window.__TAURI__` / `__TAURI_INTERNALS__` / `__TAURI_IPC__` 全局标记
- 远程 Web 检测：Vite 注入的 `VITE_APP_ENV === 'remote'` 或非 localhost 的 `VITE_APP_URL`
- 提供 `getApiBaseUrl()` 获取 API 基地址

---

### 数据库模块

#### `src/db/schema.ts` — PostgreSQL 表结构定义（Drizzle ORM）
使用 Drizzle ORM 定义 Web 模式下的 PostgreSQL 表结构：

| 表名 | 说明 |
| :--- | :--- |
| `users` | 用户（id + email + createdAt） |
| `folders` | 文件夹（name, userId, parentId, path, assetCount） |
| `tags` | 标签（name, color, usageCount） |
| `collections` | 集合（name, assetCount） |
| `assets` | 资产（name, type, size, folderId, path, thumbnailUrl, 时间戳） |
| `asset_tags` | 资产-标签多对多关联表 |
| `asset_collections` | 资产-集合多对多关联表 |
| `smart_folders` | 智能文件夹（name, matchAll, rulesJson） |

同时定义 Drizzle Relations 关系映射，支持链式关联查询。

#### `src/db/index.ts` — PostgreSQL 连接池管理
创建并导出 Drizzle db 实例：
- 使用全局单例模式（`global._postgresPool`）避免热重载创建多余连接池
- 从 `.env` 环境变量读取数据库配置（SQL_HOST、SQL_USER、SQL_PASSWORD、SQL_DB_NAME）
- 空闲连接池错误自动记录

#### `src/db/users.ts` — 用户同步工具
提供 `getOrCreateUser()` 函数：按 Firebase UID 查找用户，不存在则创建，存在则更新 email（upsert 语义）。

#### `src/db/drizzle.config.ts` — Drizzle Kit 配置
用于 `drizzle-kit push` 等 CLI 命令，从 `.env` 读取管理员数据库凭据。

#### `src/middleware/auth.ts` — Express 认证中间件
Firebase ID Token 验证中间件：
- 从请求头 `Authorization: Bearer <token>` 中提取令牌
- 调用 Firebase Admin SDK 验证令牌有效性
- 将解析后的用户信息挂载到 `req.user` 供后续路由使用
- 验证失败返回 401 Unauthorized

---

### Rust 后端模块

#### `src-tauri/src/main.rs` — Tauri 桌面应用入口
桌面应用主入口，包含：

- **单实例运行防护**：Windows 原生命名互斥锁，防止重复启动应用竞争数据库
- **数据库初始化**：调用 `Database::init()` 创建本地 SQLite 连接（失败时降级为内存数据库）
- **启动自动校验**：调用 `validate_assets()` 删除数据库中文件已不存在的资产记录
- **文件监听器启动**：初始化 `watcher::start_file_watcher`
- **窗口关闭清理**：触发 WAL checkpoint 并 `std::process::exit(0)` 彻底结束所有后台线程
- **注册 25+ 个 IPC Command**：供前端通过 `tauri::invoke()` 调用

#### `src-tauri/src/models.rs` — Rust 数据模型定义
跨模块统一的序列化模型定义（serde），包含：
- `Asset`：完整资产结构（含评分、收藏、宽高、文件哈希、缩略图URL）
- `Folder` / `Tag` / `Collection`：基础实体（含是否置顶、描述等扩展字段）
- `SmartFolderRule` / `SmartFolder`：智能文件夹规则与配置
- `ScanResult`：目录扫描结果报告
- `AggregationReport`：多维聚合分析报告

所有类型均实现 `Serialize` / `Deserialize`，与前端 TS 类型通过 `#[serde(rename)]` 精确映射。

#### `src-tauri/src/database.rs` — 本地 SQLite 数据库引擎
**核心数据持久化层**，使用 `rusqlite`（bundled 特性，零外部依赖）：

- **WAL 高并发模式**：`PRAGMA journal_mode = WAL; synchronous = NORMAL; foreign_keys = ON`
- **7 张核心数据表**：folders、tags、collections、assets、smart_folders、asset_tags、asset_collections
- **自动创建索引**：folder_id、asset_type、rating、name 等高性能查询索引
- **表结构自动迁移**：通过 `ALTER TABLE ... ADD COLUMN` 为旧库升级新增列
- **CRUD 完整操作**：全部实体提供插入/查询/更新/删除方法
- **原子事务批处理**：`batch_save_scan_results` 在单个事务中批量保存上千条文件夹和资产记录
- **数据完整迁移**：`migrate_storage` 原子复制数据库 + WAL + 缩略图到新目录，并更新配置文件
- **存储统计**：计算数据库文件 + WAL + 缩略图缓存的总磁盘占用
- **启动资产校验**：逐路径检查资产文件是否仍存在，删除无效记录

#### `src-tauri/src/indexer.rs` — 目录索引引擎
负责扫描本地磁盘目录并建立资产结构：

- 使用 `walkdir` 递归遍历目录树
- 自动排除隐藏目录（`.` 开头）、`node_modules`、`target`、`dist` 等构建缓存目录
- 通过文件扩展名快速推断资产大类（image/video/audio/document/3d/archive/other）
- 使用 `rayon` 多线程并发解析文件元数据
- 生成稳定的 ID（路径哈希）确保同一文件重复扫描不产生重复记录
- 返回 `ScanResult`（根文件夹 + 子文件夹树 + 资产列表 + 扫描统计）

#### `src-tauri/src/watcher.rs` — 文件实时监控器
使用 `notify` v6 库监听已监控文件夹的文件系统事件：

- 启动时为每个 `is_monitored=true` 的文件夹注册递归监听
- 处理事件类型：
  - **Create(File)** → 扫描新文件并写入数据库，向前端发送 `asset:added` 事件
  - **Remove** → 删除数据库中对应记录，向前端发送 `asset:removed` 事件
  - **Modify(Data/Metadata)** → 更新数据库中的修改时间和大小，发送 `asset:modified` 事件
- 自动跳过不支持格式（扩展名归类为 other）的文件
- 在后台独立线程中运行，不阻塞主线程

#### `src-tauri/src/aggregator.rs` — 多维数据聚合引擎
对内存中的资产数组执行并行统计分析：

- 使用 `rayon` 多核并行遍历
- 聚合维度：类型、文件夹、标签、集合、评分分布、大小分箱（<1MB / 1-10MB / 10-100MB / >100MB）、文件格式后缀
- 智能文件夹规则匹配引擎：支持 name / type / tag / collection / size 五种规则类型，contains / equals / greater_than / less_than 四种操作符，AND/OR 逻辑

#### `src-tauri/src/metadata_extractor.rs` — 深度元数据提取器
提取媒体文件的深度元数据：
- 使用 `infer` 库通过文件魔数检测真实 MIME 类型（不依赖扩展名）
- 使用 `image::image_dimensions` 轻量读取图片宽高（不解码全图）
- 使用 `sha2` 流式计算 SHA256 文件哈希（64KB 分块缓冲，内存占用极低）

#### `src-tauri/src/thumbnail_cache.rs` — 缩略图生成与缓存系统
多策略缩略图生成管线：

1. **缓存优先**：根据源文件路径 SHA256 哈希计算缓存文件名，命中直接返回
2. **Windows Shell 提取**（仅 Windows）：通过 COM 接口调用 `IShellItemImageFactory`，优先从 Windows 自带缩略图缓存中读取（`SIIGBF_INCACHEONLY`），未命中时触发 Windows Shell 实时提取
3. **Rust 图像库兜底**：使用 `image` crate 解码并缩放保存
4. **自动持久化**：缓存保存至 `{data_dir}/thumbnails/` 目录，跟随数据迁移
5. 支持 Windows GDI `HBITMAP` → PNG 格式转换

---

## 快速开始

### 桌面版（Windows）

```bash
# 1. 确保已安装 Node.js (v18+) 和 Rust (rustup)
# 2. 运行一键启动脚本
setup_and_run_windows.bat
# 或使用 PowerShell: setup_and_run.ps1
```

### Web 开发模式

```bash
npm install
npm run dev    # 启动 Express + Vite 开发服务器 (http://localhost:3000)
```

---

## 本地开发

| 命令 | 说明 |
| :--- | :--- |
| `npm run dev` | 启动开发服务器（Express API + Vite HMR） |
| `npm run build` | 生产构建（Vite 前端 + esbuild 打包 server.ts） |
| `npm start` | 启动生产服务器 |
| `npm run desktop:dev` | 启动 Tauri 桌面开发模式 |
| `npm run desktop:build` | 构建桌面应用安装包 |
| `npm run db:push` | 推送数据库 schema 变更至 PostgreSQL |
| `npm run lint` | TypeScript 类型检查 |

---

## 构建部署

### 桌面版 Windows EXE

```bash
build_windows_exe.bat
```

产物位于 `src-tauri/target/release/` 下，包括独立 EXE 和 MSI 安装包。

### Web 部署（Cloud Run / AI Studio）

```bash
npm run build
npm start
```

---

## 配置说明

所有环境配置通过 `.env` 文件管理（参见 `.env.example`）：

| 环境变量 | 用途 | 默认值 |
| :--- | :--- | :--- |
| `GEMINI_API_KEY` | Gemini AI API 调用密钥 | — |
| `APP_URL` | 应用对外访问 URL | `http://localhost:3000` |
| `APP_ENV` | 运行模式（remote / local） | `local` |
| `VITE_APP_ENV` | 前端环境变量（远程检测） | `local` |
| `VITE_APP_URL` | 前端 API 基地址 | `http://localhost:3000` |
| `SQL_HOST` / `SQL_USER` / `SQL_PASSWORD` / `SQL_DB_NAME` | PostgreSQL 连接配置 | — |

Firebase 配置位于 `firebase-applet-config.json`，用于 Web 模式的用户认证。

---

## 已有文档

| 文档 | 内容 |
| :--- | :--- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Rust 后端模块架构与替换指南 |
| [DATABASE_DESIGN.md](DATABASE_DESIGN.md) | Web 版 PostgreSQL 数据库设计 |
| [MIGRATION_GUIDE.md](MIGRATION_GUIDE.md) | 桌面版（Rust + Tauri）完整迁移与部署指南 |

