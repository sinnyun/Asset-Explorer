# Asset Explorer / AssetHub V2

面向 Windows 的高性能本地资产浏览器。V2 采用 React 19 + Tauri 2 + Rust + SQLite，并提供与桌面查询契约一致的 Express/PostgreSQL Web 模式。

这次重构不兼容旧数据：桌面端只使用 `%LOCALAPPDATA%\AssetHub\assethub-v2.db`，不会迁移或删除旧 `assethub.db`。目标规模为 100 万资产、10 万文件夹和 50GB 单文件。

## V2 的关键变化

- 启动只打开数据库、加载轻量工作区和注册监控；不再全量校验或自动深度对账。
- 资产使用稳定游标分页，单页最多 300；前端查询缓存最多 20 页。
- 网格、列表和双分列仅渲染视口附近行，资产总量不再决定 DOM 数量。
- 扫描按 200 条写入，2 个工作线程、32 个等待任务；同一根目录禁止并发全扫。
- 文件事件先进入 8192 容量队列并合并，只更新具体路径或新建子树。
- SQLite 最多 4 个读连接，所有写入经过容量 256 的单写入执行器。
- 文件事实与评分、收藏、颜色、标签、集合等用户状态分离；重新扫描不会覆盖标记。
- 缩略图最多 2 个并发解码、512 个待处理请求，前端对象 URL LRU 最多 256 项。
- 普通预览使用 Tauri 流式资源 URL；辅助读取只允许已监控根目录内、单次最多 4MB。
- 批量修改支持幂等操作 ID、记录版本冲突检查，以及“查询 + 排除项”的服务端选择表达式。

完整的数据流、故障行为和容量边界见 [ARCHITECTURE.md](ARCHITECTURE.md)，表结构、所有权和读写事务见 [DATABASE_DESIGN.md](DATABASE_DESIGN.md)。

## 运行

要求：Node.js、npm、Rust stable、Windows WebView2，以及 Tauri 所需的 Windows 构建工具。

```powershell
npm install
npm run desktop:dev
```

Web 开发模式需要 PostgreSQL 与 Firebase 配置：

```powershell
Copy-Item .env.example .env
npm run db:push
npm run dev
```

桌面模式直接通过 Tauri IPC 使用 SQLite，不需要启动 Express 服务。Web 模式通过 `/api/v2` 使用 PostgreSQL；本地文件监控、原生预览和资源管理器定位属于桌面能力。

## 验证与构建

```powershell
npm run test:ts
npm run lint
npm run build
npm run test:rust
npm run desktop:build
```

可选规模数据生成器：

```powershell
.\scripts\generate-scale-fixture.ps1 `
  -Destination D:\AssetHub-Fixture `
  -FileCount 100000 `
  -FolderCount 10000 `
  -SparseLargeFileBytes 53687091200
```

生成器拒绝盘符根目录、用户目录和默认情况下的非空目录。在 Windows 上创建大文件前会先设置 NTFS sparse 标志；失败时立即停止，避免真实占用 50GB。

## 核心模块

| 位置 | 职责 |
| --- | --- |
| `src-tauri/src/database.rs` | V2 schema、读池、写入执行器、扫描代次与事务 |
| `src-tauri/src/asset_query.rs` | 参数化过滤、稳定游标、资产/文件夹/详情读取 |
| `src-tauri/src/indexer.rs` | 有界流式文件发现与元数据头读取 |
| `src-tauri/src/index_jobs.rs` | single-flight、取消、并发和队列准入 |
| `src-tauri/src/watcher.rs` | 文件事件收集、合并后的目标路径处理 |
| `src-tauri/src/thumbnail_*` | 版本化缩略图缓存、像素限制与并发准入 |
| `src-tauri/src/preview_stream.rs` | 已授权路径的 4MB 上限区间读取 |
| `src/hooks/useAssetQuery.ts` | 有界分页缓存、旧响应保护和刷新 |
| `src/components/VirtualAsset*` | 主视图窗口化渲染 |
| `src/components/MonitoredSplitView.tsx` | 左右独立分页与虚拟滚动 |
| `src/server/v2Router.ts` | Web V2 分页、详情和批量修改契约 |

## 运行时语义

- 扫描失败、取消或磁盘离线时保留缓存数据，不把“暂时不可访问”当作删除。
- 只有完整扫描成功结束后，才按 generation 清理该根目录未见记录。
- 查询错误会显示为错误状态，不会降级为空数组，因此不会再次出现“数据库有内容但界面显示空工作区”的误判。
- 监控队列溢出会进入诊断指标，完整恢复必须显式启动，不在后台偷偷全盘扫描。
- 数据库初始化失败会显示原生错误并退出，不回退到临时内存数据库。

## 文档

- [V2 架构与完整数据流](ARCHITECTURE.md)
- [数据库存储与读写设计](DATABASE_DESIGN.md)
- [扩展性设计规格](docs/superpowers/specs/2026-09-09-asset-explorer-scalability-design.md)
- [分阶段实施计划](docs/superpowers/plans/2026-09-09-asset-explorer-v2-implementation.md)
- [变更记录](CHANGELOG.md)
