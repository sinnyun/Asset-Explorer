# Asset Hub 本地桌面版 (Rust + Tauri) 完整迁移与部署指南

本文档指导您如何将本项目从 Web 开发环境完整迁移并部署到您的 **本地 Windows 系统**，运行为原生高性能的 **Rust + Tauri** 桌面应用程序。

---

## 目录结构解耦规范

项目已完成前后端彻底分离与重组：

```text
├── src/                               # 【前端工程】React 19 + Tailwind CSS + Lucide
│   ├── components/                    # 界面视图组件 (Sidebar, MainArea, PropertiesPanel 等)
│   ├── services/
│   │   └── desktopBridge.ts           # 前端与底层 Rust IPC 通信桥接层
│   ├── types.ts                       # 前端 TypeScript 实体定义
│   ├── data.ts                        # 默认数据与智能文件夹初始配置
│   ├── App.tsx                        # 主应用容器
│   └── main.tsx                       # 入口渲染
│
├── src-tauri/                         # 【后端工程】Rust 高性能本地计算与桌面服务
│   ├── Cargo.toml                     # Rust 依赖声明 (walkdir, rayon, image, infer, notify 等)
│   ├── tauri.conf.json                # Tauri 桌面应用窗口、权限与打包配置
│   ├── build.rs                       # Tauri 编译构建脚本
│   └── src/
│       ├── main.rs                    # 桌面应用入口与插件调度
│       ├── models.rs                  # 核心数据模型 (Asset, Folder, Tag, SmartFolder 等)
│       ├── database.rs                # 【核心引擎 0】本地 SQLite 嵌入式数据库与原子事务持久化
│       ├── indexer.rs                 # 【专一模块 1】本地文件夹多线程遍历与快速索引
│       ├── aggregator.rs              # 【专一模块 2】多维数据聚合、分箱统计与智能过滤
│       ├── metadata_extractor.rs      # 【专一模块 3】媒体深度元数据解析与 SHA256 哈希
│       ├── thumbnail_cache.rs         # 【专一模块 4】本地图片缩略图生成与磁盘缓存
│       ├── watcher.rs                 # 【专一模块 5】本地文件夹实时变动监听 (notify)
│       └── commands.rs                # 【IPC 路由】向前端暴露的 Tauri 异步命令接口
│
├── setup_and_run_windows.bat          # 【一键运行】Windows 批处理自动部署与启动脚本
├── setup_and_run.ps1                  # 【一键运行】Windows PowerShell 自动化脚本
├── build_windows_exe.bat              # 【一键打包】构建生成独立 Windows EXE 和安装包
├── package.json                       # 项目包定义与前后端脚本映射
└── MIGRATION_GUIDE.md                 # 迁移操作手册
```

---

## 一、本地 Windows 前置准备（只需安装一次）

在本地 Windows 运行 Rust + Tauri 桌面程序，需要以下两款标准开发工具：

1. **Node.js (v18 或 v20 LTS)**：
   - 官方下载：[https://nodejs.org/](https://nodejs.org/)
   - 安装时选择默认选项一路下一步即可。
2. **Rust 编译工具链 (rustup)**：
   - 官方下载：[https://rustup.rs/](https://rustup.rs/)
   - 下载 `rustup-init.exe` 并双击运行，在出现的命令行窗口直接按 **回车** 选择默认安装。
3. **C++ 构建工具 (MSVC)**：
   - 如果您的电脑从未编译过 C++ 程序，Rust 编译需要 Visual Studio C++ 工具。
   - 如果提示缺少 MSVC，请从微软官网下载安装：[Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)，勾选 **“使用 C++ 的桌面开发”** 安装即可。

---

## 二、一键启动使用步骤

下载项目 ZIP 并解压到本地 Windows 目录（例如 `D:\Workspace\AssetHub`）后：

### 方法 1：双击批处理脚本（最简单推荐）
1. 在文件夹中直接找到并 **双击运行 `setup_and_run_windows.bat`**。
2. 脚本将自动按顺序完成以下动作：
   - 检查本地 Node.js 和 Rust 编译环境（如未安装会直接弹出下载页面）。
   - 自动复制并初始化 `.env` 配置文件。
   - 自动执行 `npm install` 安装所有前端及 Tauri 依赖。
   - 自动拉起 Rust 编译器编译后端模块，并打开原生的 Windows 桌面客户端应用窗口。

### 方法 2：使用 PowerShell
右键点击 `setup_and_run.ps1`，选择 **使用 PowerShell 运行**。

---

## 三、一键打包为独立 Windows 安装程序 (EXE / MSI)

当您在本地开发测试满意，想要生成不依赖任何开发环境、可直接分发运行的单个 EXE 时：

1. 直接双击运行项目根目录下的 **`build_windows_exe.bat`**。
2. 脚本将自动完成：
   - 生产环境前端静态优化 (`vite build`)。
   - 开启 Rust 编译最高优化等级 (`opt-level = 3`，`lto = true`，自动剥离调试符号)。
   - 生成的独立可执行文件位于：
     - `src-tauri\target\release\AssetHub.exe`
     - `src-tauri\target\release\bundle\msi\AssetHub_0.1.0_x64_en-US.msi`

---

## 四、核心前后端通信与全异步非阻塞机制 (IPC)

前端通过 `src/services/dataService.ts` 与 `src/services/desktopBridge.ts` 与 Rust 后端建立无锁非阻塞通信：

- **数据库由后端全权管理**：前端不存任何实际业务数据库，所有数据持久化在 `%LOCALAPPDATA%\AssetHub\assethub.db` (SQLite WAL 模式)。
- **操作绝不堵塞界面 (0ms UI 响应)**：
  - 前端点击创建文件夹、打标签、改评分、智能过滤等操作后，立即更新视图（乐观更新），同时通过非阻塞 Promise 向 Rust 后端提交事务。
  - Rust 后端所有命令函数全部通过 `tokio::task::spawn_blocking` 将文件读写、数据库执行与磁盘扫描扔到专用后台线程池，主 UI 线程与渲染引擎绝不卡顿。
- **扫描文件夹**：前端点击「Scan Local Folder」，在桌面环境下直接触发 Rust 原生 `scan_directory` 命令，调用 `walkdir` 并发多线程扫描磁盘文件，并直接以原子事务批量存入 SQLite。
- **数据聚合**：前端调用 `aggregate_data`，Rust 负责利用多核 CPU (`rayon`) 执行大规模分箱统计并毫秒级返回给 React 渲染。
- **在资源管理器中定位**：在前端右键任意素材，点击「在资源管理器中定位」，Rust 将直接调用 Windows 原生 Explorer 进程高亮定位目标文件。
