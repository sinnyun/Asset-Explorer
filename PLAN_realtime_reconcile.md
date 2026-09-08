# 桌面端实时文件夹监控重构规划（对账式同步 + 元数据增量）

> 本文档为本次重构的**规划文档**，独立成文，不覆盖任何既有文档。
> 关联参考：`README.md`、`ARCHITECTURE.md`、`DATABASE_DESIGN.md`、`MIGRATION_GUIDE.md`。
> 目标代码位置：`src-tauri/src/{watcher.rs, sync.rs(新增), database.rs, models.rs, commands.rs}`、`src/hooks/useFileMonitoring.ts`、`src/types.ts`。

---

## 1. 背景与问题

当前"实时监控"以**数据库为展示源**，试图用 `notify` 事件流**逐文件增量维护** DB。该路径在以下场景失效：

1. **新建子文件夹永不入库/不上屏** —— `Create(dir)` 只触发 `scan_new_directory`，只索引文件、不写 `folders`、不发 `folder:added`；前端目录树由 `state.folders` 构建 → 新夹及其内部文件不可见。
2. **新子夹内文件 `folder_id` 匹配错误** —— `find_matching_folder` 只匹配"已存在的文件夹"前缀，新夹无记录 → 挂错父级或空 id，分列视图过滤不出。
3. **目录删除产生孤儿数据** —— `handle_removals` 仅按精确路径删资产，不删 folders 行、不删前缀子树资产。
4. **目录重命名全失效** —— `handle_rename_event` 只处理 `path.is_file()`，目录改名不动 folders、不迁移子资产。
5. **notify 事件不可靠 + 竞态** —— 目录整体拷贝可能只发 1 个 Create；事件处理时撞上拷贝未完成；丢失事件无兜底。

## 2. 核心架构理念（本次重构的根本转变）

> **磁盘是唯一真相源；数据库只是"可丢弃的缓存"，用于避免对未变动文件做重复的深度重读（SHA-256/元数据提取）。**

- 正确性**不依赖**事件流：由**对账（Reconcile）**保证 DB ⇔ 磁盘一致。
- 事件流只承担**实时感知 + 快速通道**：单文件增删改秒级生效。
- 用**文件系统自身元数据**做增量，避免无脑全量重扫：
  - **文件夹 mtime**（Windows 目录 LastWriteTime）在**结构变化**（子项增/删/改名）时变化 → 用于剪枝：`磁盘 mtime == 库内 mtime` 时整棵子树视为未变，跳过深扫。
  - **文件 mtime/size** 在**内容变化**时变化 → 用于精确过滤：仅对 `mtime/size` 发生变化的文件做深层重读（重新提取元数据/哈希），未变文件零开销。

## 3. 设计

### 3.1 数据模型 & 迁移
- `folders` 表新增列 `mtime TEXT`（文件夹磁盘修改时间，RFC3339）。
- Rust `Folder` 模型新增字段 `mtime: Option<String>`（`#[serde(rename = "mtime")]` 或透传，前端忽略即可，不强制改前端类型）。
- `database.rs::migrate_schema` 增加兼容迁移（参考现有 `existing_columns` + `ALTER TABLE folders ADD COLUMN mtime TEXT DEFAULT NULL`）。

### 3.2 新增对账模块 `sync.rs`（核心正确性喉舌）

对外核心函数：

```rust
/// 对单个监控根文件夹执行"磁盘为真相"的对账，产出并推送增量事件。
pub fn reconcile_root(app: &AppHandle, db: &Database, root_path: &Path,
                      mode: ReconcileMode) -> Result<ReconcileReport, String>

pub enum ReconcileMode {
    /// 目录 mtime 未变即剪枝整棵子树（周期/兜底用，廉价）
    Pruned,
    /// 全量元数据走查 + 按文件 mtime/size 差异重读（事件批量后/建夹后用）
    Deep,
}
```

对账步骤：
1. **走查磁盘**：用与 `indexer.rs` 一致的 `ignore::WalkBuilder` 规则收集 `(dir_path → 磁盘 mtime)`、`(file_path → (磁盘 mtime, size))`。
   - `Pruned` 模式下，递归时若 `磁盘 dir.mtime == 库内 folder.mtime` → 跳过该子树。
2. **加载库内现状**（限定在该根下）：`DB.folders` + `DB.assets` 的 `(path→id)` 映射。
3. **文件夹差异**：
   - 磁盘有、库无 → `upsert_folder`（id=`f_`+stable_hash(path)，计算 parent_id）→ emit `folder:added`。
   - 库有、磁盘无 → `delete_folder_tree`（级联删资产）→ emit `folder:removed`。
   - 双方都有但 name/parent 变 → 更新 → emit `folder:updated`。
   - 无论何种，凡是保留的文件夹都**回写磁盘 mtime** 到库，作为下次剪枝依据。
4. **资产差异**（仅对 `Pruned` 未剪枝处与其内文件）：
   - 磁盘有、库无 → 建资产（id=`ast_`+stable_hash(path)，`folder_id` 取真实父目录）→ emit `asset:added`。
   - 库有、磁盘无 → 删 → emit `asset:removed`。
   - 双方都有且**磁盘 (mtime,size) ≠ 库内 (date_modified,size)** → 深度重读（复用 `metadata_extractor`/`build_asset` 逻辑）→ 更新 → emit `asset:modified`。
5. 批量原子写库（参考 `batch_save_assets` 的事务模式）；返回 `ReconcileReport`（增/删/改数量，供日志与进度）。
> 复用原则：文件夹/资产 **id 均由路径确定性哈希**，对账天然幂等，可安全重复调用。

#### 关键保证：单文件/小文件修改绝不引发父级重扫（无向上级联）

这是本次设计的核心不变量，依据 NTFS/Linux 目录元数据语义：

- **文件 mtime/size** 属**叶子级**信号；**文件夹 mtime** 属**结构级**信号，二者严格分离：
  - 文件**内容**被改 → 只更新**该文件**的 mtime，**父目录/所有祖先的 mtime 不变**。
  - 目录 mtime 只有在**该目录的直接子项被 增/删/改名**（结构变化）时才变。
- 因此对账层对文件夹 mtime 的用法**仅限**："判断某个目录的**子项集合**是否变化" → 决定是否重扫**该目录这一层**。**绝不因叶子文件内容改动去重扫父目录**。
- 判定链路（以根 `a/b/` 下 `x.png` 内容被改为例）：
  1. `x.png` 的 (mtime,size) 与库内不同 → 唯一触发 `asset:modified`，对该文件做深度重读（元数据/哈希）。
  2. `a`、`b` 目录 mtime 均未变 → `Pruned` 模式整链剪枝跳过，`Deep` 模式也不对它们做任何重扫。
- **触发器克制**：单文件增删改一律走快速通道（`Create/Modify/Remove(file)`），**不调度整根对账**；整根 `Deep` 对账仅在 目录创建/删除/重命名、事件批量风暴 时触发。从而杜绝"改一个小文件把整个根目录重扫一遍"。

（以上链路对"大目录中仅个别文件被改"同样成立：即使根下目录很多，只要各自 mtime 未变，就只重读被改的少数字叶子。）

### 3.3 事件快速通道（改写 `watcher.rs::flush_events` 的逐事件处理）

保留 `notify` 监听，但**不承担正确性**，仅做快速通道；目录级/批量场景下沉到对账：

| 事件 | 处理 |
|---|---|
| `Create(file)` | 单文件快加（先确保父目录链 folder 行存在，再索引该文件）→ emit `asset:added` |
| `Create(dir)` | `reconcile_root(该新子夹, Deep)`（递归建 folder 行 + 索引文件）→ 默认由 reconnect 批量 emit |
| `Modify(file)` | 单文件重读（mtime/size 若变则更新）→ emit `asset:modified` |
| `Remove(file)` | 单文件删 → emit `asset:removed` |
| `Remove(dir)` | `delete_folder_tree`（按路径前缀）→ emit `folder:removed` + 子树 `asset:removed` |
| `Modify(Name)`（重命名/移动） | 目录移动 → 目标做 Deep 对账并清扫旧前缀；文件移动 → 单文件新增+旧路径删除 |
| 大批量/事件风暴 | 去抖后对整个受影响监控根做 `reconcile_root(Deep)` 兜底 |

### 3.4 周期/生命周期兜底
- 新增能力：定期（如 60s）与**窗口回焦**时对每个已监控根执行 `reconcile_root(Pruned)`，纠正 notify 任何漏检（结构变化会冒泡到目录 mtime，能被 Pruned 剪枝捕获路径差异）。内容级编辑主要由事件快速通道覆盖。
- 新增 Tauri 命令 `reconcile_monitored_folders`（供前端手动刷新/启动时机调用；`startup` 时已由 `WatcherRegistry::new` 注册并触发一次 Pruned 对账）。

### 3.5 前端：目录结构实时刷新
- `useFileMonitoring.ts` 新增监听：
  - `folder:added` → `normalizeFolders` 增量合入 `state.folders`，并把它加入 `expandedFolderIds`（参考 `useScanMonitor` 的做法）。
  - `folder:updated` → 按 id 替换对应项。
  - `folder:removed` → 按 id 过滤移除（同 id 子树一并移除）。
  - 沿用现有 50ms 批量缓冲 + 去重，避免渲染雪崩。
- 复用 `services/api/utils.ts` 的 `normalizeFolders`。

### 3.6 需新增/修改的 DB 方法（`database.rs`）
- `upsert_folder_with_mtime(&Folder)`（含 mtime 列）。
- `update_folder_mtime(id, mtime)`。
- `get_folders_by_prefix(path)` / `get_folders_under(path)`。
- `delete_folder_tree(id)`（级联删资产，供目录逻辑用）。
- `get_assets_by_path_prefix(path)` / `delete_assets_by_path_prefix(path)`。
- 迁移：`folders.mtime` 列 ADD。

---

## 4. 落地文件清单

| 文件 | 动作 |
|---|---|
| `src-tauri/src/sync.rs` | **新增** 对账模块 |
| `src-tauri/src/watcher.rs` | **改写** 事件快速通道 + 修复文件夹增删改/重命名；暴露对账触发 |
| `src-tauri/src/database.rs` | 迁移 mtime 列 + 新增上述 DB 方法 |
| `src-tauri/src/models.rs` | `Folder` 增 `mtime` |
| `src-tauri/src/commands.rs` | 新增 `reconcile_monitored_folders` 命令 |
| `src-tauri/src/lib.rs` | 注册新命令 + 启动/回焦触发对账 |
| `src/hooks/useFileMonitoring.ts` | 监听 `folder:*` 事件刷新目录树 |
| （新建）`CHANGELOG.md` | 项目当前无版本记录文件，依据规则新建并后续在文末追加每次修改 |

## 5. 验证方式
1. `cargo build`（src-tauri）与前端 `npm run build` / dev 通过。
2. 桌面运行：在监控根下**新建子文件夹 + 拷贝若干文件** → 目录树实时出现；**编辑文件内容** → 卡片实时更新；**删整个子夹** → 界面与 DB 同步移除，重启后不回弹。
3. 手动触发 `reconcile_monitored_folders`，确认无多余增删（幂等）。
4. 观察 `[Watcher]`/`[Sync]` 日志，确认普通文件变更走快速通道、大变更走对账，未变文件不再被深度重读。

## 6. 风险与取舍
- **目录 mtime 剪枝不覆盖"结构未变但文件内容被改且 notify 又丢事件"**：可接受——内容编辑主要靠事件快速通道；周期对账仅负责结构正确性兜底。
- **异步对账与事件写库并发**：全部走 `Database`（`parking_lot::Mutex`）串行化，前端以 id 去重兜底（现有逻辑已具备）。
- **重命名目录代价**：等价于"旧树删除 + 新树对账"，期间可能一次性 emit 较多事件——由前端批量缓冲吸收。