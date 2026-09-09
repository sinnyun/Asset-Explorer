//! ============================================================================
//! 模块：本地数据库与数据操作引擎 (database.rs)
//! 职责：负责本地 SQLite 嵌入式数据库生命周期、表结构初始化与迁移、所有的 CRUD
//! 数据持久化操作以及高性能原子事务批处理。
//! 依赖开源库：`rusqlite`, `parking_lot`, `dirs`, `fs_extra`
//! ============================================================================

use crate::models::{
    Asset, AssetUserPatch, Collection, FileFact, Folder, MutationSummary,
    SmartFolder, SmartFolderRule, Tag,
};
#[cfg(test)]
use crate::models::AssetDetail;
use parking_lot::Mutex;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[derive(Debug, Serialize, Deserialize)]
pub struct StorageStats {
    pub data_dir: String,
    pub db_size_bytes: u64,
    pub thumbnails_size_bytes: u64,
    pub total_size_bytes: u64,
    pub asset_count: usize,
}

/// V2 always uses the local application-data directory; storage selection is deferred.
pub fn get_active_data_dir() -> Result<PathBuf, String> {
    dirs::data_local_dir()
        .map(|base| base.join("AssetHub"))
        .ok_or_else(|| "无法定位 Windows 本地应用数据目录".to_string())
}

/// Canonical Windows identity key. Preserve drive roots and the rooted separator.
pub fn normalize_windows_path(path: &str) -> String {
    let normalized = path.trim().replace('/', "\\").to_lowercase();
    let trimmed = normalized.trim_end_matches('\\');
    if trimmed.len() == 2 && trimmed.as_bytes()[1] == b':' && normalized.len() > 2 {
        format!("{trimmed}\\")
    } else if trimmed.is_empty() && !normalized.is_empty() {
        "\\".to_string()
    } else {
        trimmed.to_string()
    }
}

fn timestamp_ns(value: &str) -> Result<i64, String> {
    chrono::DateTime::parse_from_rfc3339(value)
        .map_err(|e| format!("无效文件时间: {e}"))?
        .timestamp_nanos_opt()
        .ok_or_else(|| "文件时间超出纳秒范围".to_string())
}

fn scan_file_fact(asset: &Asset) -> Result<FileFact, String> {
    let extension = Path::new(&asset.path).extension()
        .map(|value| value.to_string_lossy().to_lowercase()).unwrap_or_default();
    Ok(FileFact {
        id: asset.id.clone(),
        folder_id: (!asset.folder_id.is_empty()).then(|| asset.folder_id.clone()),
        path: asset.path.clone(),
        normalized_path: normalize_windows_path(&asset.path),
        name: asset.name.clone(),
        mime: mime_guess::from_ext(&extension).first_raw().map(str::to_string),
        extension,
        asset_type: asset.asset_type.clone(),
        size: asset.size,
        mtime_ns: timestamp_ns(&asset.date_modified)?,
        volume_id: None,
        file_id: None,
        width: asset.width,
        height: asset.height,
        metadata_status: "pending".to_string(),
        generation: 0,
    })
}

fn revision_after_mutation(tx: &rusqlite::Transaction<'_>, affected: usize) -> Result<i64, String> {
    if affected > 0 {
        tx.execute("UPDATE app_meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'revision'", [])
            .map_err(|e| format!("更新数据版本失败: {e}"))?;
    }
    tx.query_row("SELECT CAST(value AS INTEGER) FROM app_meta WHERE key = 'revision'", [], |row| row.get(0))
        .map_err(|e| format!("读取数据版本失败: {e}"))
}

/// 数据库全局状态句柄
#[derive(Clone)]
pub struct Database {
    conn: Arc<Mutex<Connection>>,
    data_dir: PathBuf,
}

/// 批量关联映射：asset_id → Vec<name_or_id>
type AssocMap = HashMap<String, Vec<String>>;

/// 单条 SQL 语句中允许的最大绑定参数数量。
/// SQLite 默认 SQLITE_MAX_VARIABLE_NUMBER=999，为稳妥起见取 500，
/// 避免大量资产时单个 `IN (...)` 查询超出该上限而报
/// "too many SQL variables" 错误。
const SQLITE_VAR_LIMIT: usize = 500;

/// V2 uses a separate database; no legacy database is opened or relocated.
pub const V2_DATABASE_FILE: &str = "assethub-v2.db";

const ASSET_COLUMNS: &str = "a.id, a.name, a.path, a.asset_type, a.size, COALESCE(a.folder_id, ''),
    a.mtime_ns, a.first_seen_at, COALESCE(u.rating, 0), COALESCE(u.favorite, 0),
    u.color, a.width, a.height";

/// Project V2 facts and user state into the existing scan/watcher response shape.
fn asset_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Asset> {
    let first_seen: i64 = row.get(7)?;
    let added = chrono::DateTime::from_timestamp_millis(first_seen)
        .ok_or(rusqlite::Error::IntegralValueOutOfRange(7, first_seen))?;
    Ok(Asset {
        id: row.get(0)?, name: row.get(1)?, path: row.get(2)?,
        asset_type: row.get(3)?, size: row.get::<_, i64>(4)? as u64,
        folder_id: row.get(5)?,
        date_modified: chrono::DateTime::from_timestamp_nanos(row.get(6)?).to_rfc3339(),
        date_added: added.to_rfc3339(),
        rating: row.get(8)?, favorite: row.get(9)?, color: row.get(10)?,
        width: row.get(11)?, height: row.get(12)?,
        file_hash: None, thumbnail_url: None, tags: Vec::new(), collections: Vec::new(),
    })
}

impl Database {
    /// 创建或打开全新的 V2 数据库。
    pub fn init_v2() -> Result<Self, String> {
        let db_dir = get_active_data_dir()?;
        fs::create_dir_all(&db_dir).map_err(|e| format!("创建 V2 数据目录失败: {e}"))?;
        Self::init_v2_at(&db_dir.join(V2_DATABASE_FILE))
    }

    /// 在隔离位置创建 V2 数据库，供测试使用。
    pub fn init_v2_at(db_path: &Path) -> Result<Self, String> {
        if db_path.file_name() != Some(std::ffi::OsStr::new(V2_DATABASE_FILE)) {
            return Err(format!("V2 数据库必须命名为 {V2_DATABASE_FILE}"));
        }
        let data_dir = db_path
            .parent()
            .ok_or_else(|| "V2 数据库路径缺少父目录".to_string())?
            .to_path_buf();
        fs::create_dir_all(&data_dir).map_err(|e| format!("创建 V2 数据目录失败: {e}"))?;

        let conn = Connection::open(db_path).map_err(|e| format!("打开 V2 数据库失败: {e}"))?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = ON;
             PRAGMA busy_timeout = 5000;",
        )
        .map_err(|e| format!("配置 V2 数据库失败: {e}"))?;

        let db = Self {
            conn: Arc::new(Mutex::new(conn)),
            data_dir,
        };
        db.migrate_schema()?;
        Ok(db)
    }

    pub fn asset_count(&self) -> Result<usize, String> {
        self.conn
            .lock()
            .query_row("SELECT COUNT(*) FROM assets WHERE deleted_at IS NULL", [], |row| row.get::<_, i64>(0))
            .map(|count| count as usize)
            .map_err(|e| format!("读取资产数量失败: {e}"))
    }

    /// 强制执行 WAL 检查点，安全刷盘
    pub fn checkpoint(&self) {
        let conn = self.conn.lock();
        let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
    }

    /// 获取当前数据目录路径（缩略图、配置等均与此目录关联）
    pub fn get_data_dir(&self) -> &Path {
        &self.data_dir
    }

    /// 获取存储占用统计信息
    pub fn get_storage_stats(&self) -> StorageStats {
        let db_file = self.data_dir.join(V2_DATABASE_FILE);
        let db_wal = self.data_dir.join(format!("{V2_DATABASE_FILE}-wal"));
        let db_shm = self.data_dir.join(format!("{V2_DATABASE_FILE}-shm"));
        let thumb_dir = self.data_dir.join("thumbnails");

        let mut db_size = fs::metadata(&db_file).map(|m| m.len()).unwrap_or(0);
        db_size += fs::metadata(&db_wal).map(|m| m.len()).unwrap_or(0);
        db_size += fs::metadata(&db_shm).map(|m| m.len()).unwrap_or(0);

        let mut thumb_size = 0u64;
        if thumb_dir.exists() {
            if let Ok(entries) = fs::read_dir(&thumb_dir) {
                for entry in entries.flatten() {
                    if let Ok(meta) = entry.metadata() {
                        thumb_size += meta.len();
                    }
                }
            }
        }

        let asset_count = self.asset_count().unwrap_or(0);

        StorageStats {
            data_dir: self.data_dir.to_string_lossy().to_string(),
            db_size_bytes: db_size,
            thumbnails_size_bytes: thumb_size,
            total_size_bytes: db_size + thumb_size,
            asset_count,
        }
    }

    /// V2 storage selection is not available at this task boundary.
    pub fn migrate_storage(&self, _new_dir: &Path) -> Result<(), String> {
        Err("V2 暂不支持迁移存储位置".to_string())
    }

    /// 创建全新的 V2 schema。V2 数据库不兼容也不迁移旧表。
    fn migrate_schema(&self) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute_batch(
            "
            BEGIN IMMEDIATE;

            CREATE TABLE IF NOT EXISTS app_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            INSERT OR REPLACE INTO app_meta(key, value) VALUES ('schema_epoch', '2');
            INSERT OR IGNORE INTO app_meta(key, value) VALUES ('revision', '0');

            CREATE TABLE IF NOT EXISTS roots (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                path TEXT NOT NULL,
                normalized_path TEXT NOT NULL UNIQUE,
                online INTEGER NOT NULL DEFAULT 1,
                dirty INTEGER NOT NULL DEFAULT 0,
                active_generation INTEGER NOT NULL DEFAULT 0,
                completed_generation INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS folders (
                id TEXT PRIMARY KEY,
                root_id TEXT,
                name TEXT NOT NULL,
                path TEXT NOT NULL,
                normalized_path TEXT NOT NULL UNIQUE,
                parent_id TEXT,
                is_monitored INTEGER NOT NULL DEFAULT 0,
                mtime_ns INTEGER NOT NULL DEFAULT 0,
                last_seen_generation INTEGER NOT NULL DEFAULT 0,
                record_version INTEGER NOT NULL DEFAULT 1,
                FOREIGN KEY (root_id) REFERENCES roots(id) ON DELETE CASCADE,
                FOREIGN KEY (parent_id) REFERENCES folders(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS assets (
                id TEXT PRIMARY KEY,
                root_id TEXT,
                folder_id TEXT,
                path TEXT NOT NULL,
                normalized_path TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                extension TEXT NOT NULL DEFAULT '',
                asset_type TEXT NOT NULL,
                mime TEXT,
                size INTEGER NOT NULL CHECK(size >= 0),
                mtime_ns INTEGER NOT NULL,
                volume_id TEXT,
                file_id TEXT,
                width INTEGER,
                height INTEGER,
                duration_ms INTEGER,
                metadata_status TEXT NOT NULL DEFAULT 'pending',
                thumbnail_status TEXT NOT NULL DEFAULT 'missing',
                thumbnail_version TEXT,
                first_seen_at INTEGER NOT NULL,
                last_seen_generation INTEGER NOT NULL DEFAULT 0,
                deleted_at INTEGER,
                record_version INTEGER NOT NULL DEFAULT 1,
                FOREIGN KEY (root_id) REFERENCES roots(id) ON DELETE CASCADE,
                FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE SET NULL
            );

            CREATE TABLE IF NOT EXISTS asset_user_state (
                asset_id TEXT PRIMARY KEY,
                rating INTEGER NOT NULL DEFAULT 0 CHECK(rating BETWEEN 0 AND 5),
                favorite INTEGER NOT NULL DEFAULT 0,
                color TEXT,
                custom_name TEXT,
                notes TEXT,
                updated_at INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS tags (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                color TEXT NOT NULL,
                description TEXT,
                is_pinned INTEGER NOT NULL DEFAULT 0,
                sort_order INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS collections (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                color TEXT,
                description TEXT,
                is_pinned INTEGER NOT NULL DEFAULT 0,
                sort_order INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS smart_folders (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                icon TEXT NOT NULL,
                rules_json TEXT NOT NULL DEFAULT '[]',
                match_all INTEGER NOT NULL DEFAULT 1,
                is_search_history INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS asset_tags (
                asset_id TEXT NOT NULL,
                tag_id TEXT NOT NULL,
                PRIMARY KEY (asset_id, tag_id),
                FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE,
                FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS asset_collections (
                asset_id TEXT NOT NULL,
                collection_id TEXT NOT NULL,
                PRIMARY KEY (asset_id, collection_id),
                FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE,
                FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS scan_jobs (
                id TEXT PRIMARY KEY,
                root_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                state TEXT NOT NULL,
                generation INTEGER NOT NULL,
                discovered_count INTEGER NOT NULL DEFAULT 0,
                indexed_count INTEGER NOT NULL DEFAULT 0,
                failed_count INTEGER NOT NULL DEFAULT 0,
                started_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                completed_at INTEGER,
                error TEXT,
                FOREIGN KEY (root_id) REFERENCES roots(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS file_event_journal (
                root_id TEXT NOT NULL,
                normalized_path TEXT NOT NULL,
                event_kind TEXT NOT NULL,
                observed_at INTEGER NOT NULL,
                PRIMARY KEY (root_id, normalized_path),
                FOREIGN KEY (root_id) REFERENCES roots(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS asset_errors (
                asset_id TEXT NOT NULL,
                stage TEXT NOT NULL,
                message TEXT NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (asset_id, stage),
                FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS mutation_operations (
                operation_id TEXT PRIMARY KEY,
                affected INTEGER NOT NULL,
                revision INTEGER NOT NULL,
                created_at INTEGER NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_folders_parent_name ON folders(parent_id, name, id);
            CREATE INDEX IF NOT EXISTS idx_folders_root_path ON folders(root_id, normalized_path);
            CREATE INDEX IF NOT EXISTS idx_assets_folder_name ON assets(folder_id, name COLLATE NOCASE, id);
            CREATE INDEX IF NOT EXISTS idx_assets_folder_mtime ON assets(folder_id, mtime_ns DESC, id);
            CREATE INDEX IF NOT EXISTS idx_assets_folder_size ON assets(folder_id, size DESC, id);
            CREATE INDEX IF NOT EXISTS idx_assets_root_path ON assets(root_id, normalized_path);
            CREATE INDEX IF NOT EXISTS idx_assets_type_mtime ON assets(asset_type, mtime_ns DESC, id);
            CREATE INDEX IF NOT EXISTS idx_assets_file_identity ON assets(volume_id, file_id);
            CREATE INDEX IF NOT EXISTS idx_user_favorite_rating ON asset_user_state(favorite, rating, asset_id);
            CREATE INDEX IF NOT EXISTS idx_asset_tags_tag ON asset_tags(tag_id);
            CREATE INDEX IF NOT EXISTS idx_asset_cols_col ON asset_collections(collection_id);

            CREATE VIRTUAL TABLE IF NOT EXISTS assets_fts USING fts5(
                name,
                path,
                asset_type,
                content='assets',
                content_rowid='rowid',
                tokenize='unicode61'
            );

            CREATE TRIGGER IF NOT EXISTS assets_ai AFTER INSERT ON assets BEGIN
                INSERT INTO assets_fts(rowid, name, path, asset_type)
                VALUES (new.rowid, new.name, new.path, new.asset_type);
            END;

            CREATE TRIGGER IF NOT EXISTS assets_ad AFTER DELETE ON assets BEGIN
                INSERT INTO assets_fts(assets_fts, rowid, name, path, asset_type)
                VALUES ('delete', old.rowid, old.name, old.path, old.asset_type);
            END;

            DROP TRIGGER IF EXISTS assets_au;
            CREATE TRIGGER assets_au
            AFTER UPDATE OF name, path, asset_type ON assets
            WHEN old.name IS NOT new.name OR old.path IS NOT new.path OR old.asset_type IS NOT new.asset_type
            BEGIN
                INSERT INTO assets_fts(assets_fts, rowid, name, path, asset_type)
                VALUES ('delete', old.rowid, old.name, old.path, old.asset_type);
                INSERT INTO assets_fts(rowid, name, path, asset_type)
                VALUES (new.rowid, new.name, new.path, new.asset_type);
            END;

            COMMIT;
            ",
        )
        .map_err(|e| format!("V2 数据库表结构初始化失败: {e}"))?;

        Ok(())
    }

    /// 批量写入文件系统事实，不接触用户状态。
    pub fn upsert_file_facts(&self, facts: &[FileFact]) -> Result<usize, String> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction().map_err(|e| format!("开始文件事实事务失败: {e}"))?;
        Self::write_file_facts(&tx, facts)?;
        revision_after_mutation(&tx, facts.len())?;
        tx.commit().map_err(|e| format!("提交文件事实失败: {e}"))?;
        Ok(facts.len())
    }

    fn write_file_facts(tx: &rusqlite::Transaction<'_>, facts: &[FileFact]) -> Result<(), String> {
        let now = chrono::Utc::now().timestamp_millis();
        {
            let mut stmt = tx
                .prepare(
                    "INSERT INTO assets (
                        id, folder_id, path, normalized_path, name, extension, asset_type, mime,
                        size, mtime_ns, volume_id, file_id, width, height, metadata_status,
                        first_seen_at, last_seen_generation, record_version
                     ) VALUES (
                        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
                        ?9, ?10, ?11, ?12, ?13, ?14, ?15,
                        ?16, ?17, 1
                     )
                     ON CONFLICT(id) DO UPDATE SET
                        folder_id = excluded.folder_id,
                        path = excluded.path,
                        normalized_path = excluded.normalized_path,
                        name = excluded.name,
                        extension = excluded.extension,
                        asset_type = excluded.asset_type,
                        mime = excluded.mime,
                        size = excluded.size,
                        mtime_ns = excluded.mtime_ns,
                        volume_id = excluded.volume_id,
                        file_id = excluded.file_id,
                        width = excluded.width,
                        height = excluded.height,
                        metadata_status = excluded.metadata_status,
                        last_seen_generation = excluded.last_seen_generation,
                        deleted_at = NULL,
                        record_version = assets.record_version + 1",
                )
                .map_err(|e| format!("准备文件事实写入失败: {e}"))?;

            for fact in facts {
                stmt.execute(params![
                    fact.id,
                    fact.folder_id,
                    fact.path,
                    normalize_windows_path(&fact.path),
                    fact.name,
                    fact.extension,
                    fact.asset_type,
                    fact.mime,
                    i64::try_from(fact.size).map_err(|_| "文件大小超出 SQLite 整数范围".to_string())?,
                    fact.mtime_ns,
                    fact.volume_id,
                    fact.file_id,
                    fact.width,
                    fact.height,
                    fact.metadata_status,
                    now,
                    fact.generation,
                ])
                .map_err(|e| format!("写入 normalized_path={} 失败: {e}", fact.normalized_path))?;
            }
        }
        Ok(())
    }

    pub fn patch_user_state(&self, patch: &AssetUserPatch) -> Result<MutationSummary, String> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction().map_err(|e| format!("开始用户状态事务失败: {e}"))?;
        let now = chrono::Utc::now().timestamp_millis();
        let affected = tx.execute(
            "INSERT INTO asset_user_state(asset_id, rating, favorite, color, custom_name, notes, updated_at)
             SELECT id, COALESCE(?2, 0), COALESCE(?3, 0), ?4, ?5, ?6, ?7
             FROM assets WHERE id = ?1 AND deleted_at IS NULL
             ON CONFLICT(asset_id) DO UPDATE SET
                rating = COALESCE(?2, rating),
                favorite = COALESCE(?3, favorite),
                color = COALESCE(?4, color),
                custom_name = COALESCE(?5, custom_name),
                notes = COALESCE(?6, notes),
                updated_at = ?7",
            params![patch.asset_id, patch.rating, patch.favorite.map(i32::from),
                patch.color, patch.custom_name, patch.notes, now],
        ).map_err(|e| format!("更新用户状态失败: {e}"))?;
        let revision = revision_after_mutation(&tx, affected)?;
        tx.commit().map_err(|e| format!("提交用户状态失败: {e}"))?;
        Ok(MutationSummary { affected, revision })
    }

    #[cfg(test)]
    pub fn get_asset_detail(&self, id: &str) -> Result<Option<AssetDetail>, String> {
        let conn = self.conn.lock();
        let result = conn.query_row(
            "SELECT a.id, a.path, a.normalized_path, a.name, a.asset_type, a.size, a.mtime_ns,
                    COALESCE(u.rating, 0), COALESCE(u.favorite, 0), u.color,
                    u.custom_name, u.notes, a.record_version
             FROM assets a
             LEFT JOIN asset_user_state u ON u.asset_id = a.id
             WHERE a.id = ?1 AND a.deleted_at IS NULL",
            params![id],
            |row| {
                Ok(AssetDetail {
                    id: row.get(0)?,
                    path: row.get(1)?,
                    normalized_path: row.get(2)?,
                    name: row.get(3)?,
                    asset_type: row.get(4)?,
                    size: row.get::<_, i64>(5)? as u64,
                    mtime_ns: row.get(6)?,
                    rating: row.get::<_, i64>(7)? as u8,
                    favorite: row.get::<_, i64>(8)? != 0,
                    color: row.get(9)?,
                    custom_name: row.get(10)?,
                    notes: row.get(11)?,
                    record_version: row.get(12)?,
                })
            },
        );
        match result {
            Ok(detail) => Ok(Some(detail)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(format!("读取资产详情失败: {e}")),
        }
    }

    #[cfg(test)]
    pub fn table_columns(&self, table: &str) -> Result<Vec<String>, String> {
        const TABLES: &[&str] = &[
            "roots",
            "folders",
            "assets",
            "asset_user_state",
            "tags",
            "collections",
            "asset_tags",
            "asset_collections",
            "scan_jobs",
            "file_event_journal",
            "asset_errors",
        ];
        if !TABLES.contains(&table) {
            return Err(format!("不允许检查未知表: {table}"));
        }
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(&format!("PRAGMA table_info({table})"))
            .map_err(|e| format!("读取表结构失败: {e}"))?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| format!("查询表结构失败: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("解析表结构失败: {e}"))
    }

    // =========================================================================
    // 资产 CRUD 操作
    // =========================================================================

    /// Persist a complete scan batch atomically without writing user state or removing unseen rows.
    pub fn batch_save_scan_results(
        &self,
        root_folder: &Folder,
        sub_folders: &[Folder],
        assets: &[Asset],
    ) -> Result<(), String> {
        let facts = assets.iter().map(scan_file_fact).collect::<Result<Vec<_>, _>>()?;
        let mut conn = self.conn.lock();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        Self::write_folder(&tx, root_folder)?;
        for folder in sub_folders {
            Self::write_folder(&tx, folder)?;
        }
        Self::write_file_facts(&tx, &facts)?;
        revision_after_mutation(&tx, 1 + sub_folders.len() + facts.len())?;
        tx.commit().map_err(|e| e.to_string())
    }

    /// Incremental scans use the same protected fact writer.
    pub fn batch_save_assets(&self, assets: &[Asset]) -> Result<(), String> {
        let facts = assets.iter().map(scan_file_fact).collect::<Result<Vec<_>, _>>()?;
        self.upsert_file_facts(&facts).map(|_| ())
    }

    fn write_folder(tx: &rusqlite::Transaction<'_>, folder: &Folder) -> Result<(), String> {
        let mtime_ns = folder.mtime.as_deref().map(timestamp_ns).transpose()?.unwrap_or(0);
        tx.execute(
            "INSERT INTO folders(id, name, path, normalized_path, parent_id, is_monitored, mtime_ns)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name, path = excluded.path, normalized_path = excluded.normalized_path,
                parent_id = excluded.parent_id, mtime_ns = excluded.mtime_ns,
                record_version = folders.record_version + 1",
            params![folder.id, folder.name, folder.path, normalize_windows_path(&folder.path),
                folder.parent_id, i32::from(folder.is_monitored), mtime_ns],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    // =========================================================================
    // 批量关联加载工具（解决 N+1 查询问题）
    //
    // 旧方案：get_all_assets() 对每个资产分别执行 2 条查询 (get_tags_for_asset_internal
    // 与 get_cols_for_asset_internal)，10 万资产时会产生 20 万次额外查询 → 极大延迟。
    //
    // 新方案：仅用 2 条 JOIN 查询将全部资产的 tags / collections 批量拉回，
    // 建立 HashMap 索引后 O(1) 内存合并。10 万资产查询耗时从 ~秒级降至毫秒级。
    // =========================================================================

    /// 获取所有资产列表及附带标签/集合关联
    pub fn get_all_assets(&self) -> Result<Vec<Asset>, String> {
        let conn = self.conn.lock();

        let mut stmt = conn.prepare(&format!(
            "SELECT {ASSET_COLUMNS} FROM assets a
             LEFT JOIN asset_user_state u ON u.asset_id = a.id
             WHERE a.deleted_at IS NULL ORDER BY a.mtime_ns DESC"
        )).map_err(|e| e.to_string())?;
        let mut assets = stmt.query_map([], asset_from_row)
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;

        if assets.is_empty() {
            return Ok(assets);
        }

        // 第二步：批量加载全部 asset_id → tags 映射（仅 1 条 JOIN 查询）
        let asset_ids: Vec<&str> = assets.iter().map(|a| a.id.as_str()).collect();
        let tags_map = Self::load_tags_for_assets(&conn, &asset_ids)?;
        let cols_map = Self::load_cols_for_assets(&conn, &asset_ids)?;

        // 第三步：内存 O(1) 合并
        for asset in &mut assets {
            asset.tags = tags_map.get(&asset.id).cloned().unwrap_or_default();
            asset.collections = cols_map.get(&asset.id).cloned().unwrap_or_default();
        }

        Ok(assets)
    }

    /// 分批 JOIN 查询加载全部资产的标签（消除 N+1，并规避单条 IN 超变量上限）
    fn load_tags_for_assets(conn: &Connection, asset_ids: &[&str]) -> Result<AssocMap, String> {
        let mut map: AssocMap = HashMap::new();
        if asset_ids.is_empty() {
            return Ok(map);
        }
        // 分批处理，避免单条 SQL 中 IN (...) 的绑定变量数超过 SQLite 上限
        for chunk in asset_ids.chunks(SQLITE_VAR_LIMIT) {
            let placeholders = vec!["?"; chunk.len()].join(",");
            let query = format!(
                "SELECT at.asset_id, t.id
                 FROM asset_tags at
                 JOIN tags t ON t.id = at.tag_id
                 WHERE at.asset_id IN ({})",
                placeholders
            );

            let mut stmt = conn.prepare(&query).map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(rusqlite::params_from_iter(chunk), |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|e| e.to_string())?;

            for r in rows.flatten() {
                map.entry(r.0).or_default().push(r.1);
            }
        }
        Ok(map)
    }

    /// 分批 JOIN 查询加载全部资产的集合（消除 N+1，并规避单条 IN 超变量上限）
    fn load_cols_for_assets(conn: &Connection, asset_ids: &[&str]) -> Result<AssocMap, String> {
        let mut map: AssocMap = HashMap::new();
        if asset_ids.is_empty() {
            return Ok(map);
        }
        // 分批处理，避免单条 SQL 中 IN (...) 的绑定变量数超过 SQLite 上限
        for chunk in asset_ids.chunks(SQLITE_VAR_LIMIT) {
            let placeholders = vec!["?"; chunk.len()].join(",");
            let query = format!(
                "SELECT ac.asset_id, c.id
                 FROM asset_collections ac
                 JOIN collections c ON c.id = ac.collection_id
                 WHERE ac.asset_id IN ({})",
                placeholders
            );

            let mut stmt = conn.prepare(&query).map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(rusqlite::params_from_iter(chunk), |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })
                .map_err(|e| e.to_string())?;

            for r in rows.flatten() {
                map.entry(r.0).or_default().push(r.1);
            }
        }
        Ok(map)
    }

    // =========================================================================
    // FTS5 全文搜索
    // =========================================================================

    /// 全文搜索资产（基于 SQLite FTS5 索引）
    /// query: 用户输入的搜索关键字（支持 FTS5 MATCH 语法）
    /// limit: 返回最大条数
    pub fn search_assets(&self, query: &str, limit: usize) -> Result<Vec<Asset>, String> {
        let query = query.trim();
        if query.is_empty() {
            return Ok(Vec::new());
        }

        // 构造 FTS5 搜索表达式：支持 name/path/asset_type 三个列
        // 将用户输入转义 FTS5 特殊字符，构造 MATCH 语法
        let fts_query = build_fts_query(query);

        let conn = self.conn.lock();

        let sql = format!(
            "SELECT {ASSET_COLUMNS}
             FROM assets_fts
             JOIN assets a ON a.rowid = assets_fts.rowid
             LEFT JOIN asset_user_state u ON u.asset_id = a.id
             WHERE assets_fts MATCH ?1 AND a.deleted_at IS NULL
             ORDER BY a.mtime_ns DESC LIMIT ?2"
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| format!("FTS5 搜索准备失败: {e}"))?;
        let mut found = stmt.query_map(params![fts_query, limit as i64], asset_from_row)
            .map_err(|e| format!("FTS5 搜索执行失败: {e}"))?
            .collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;

        // 若结果非空，同样批量加载关联标签与集合（消除 N+1）
        if !found.is_empty() {
            let ids: Vec<&str> = found.iter().map(|a| a.id.as_str()).collect();
            let tags_map = Self::load_tags_for_assets(&conn, &ids)?;
            let cols_map = Self::load_cols_for_assets(&conn, &ids)?;
            for asset in &mut found {
                asset.tags = tags_map.get(&asset.id).cloned().unwrap_or_default();
                asset.collections = cols_map.get(&asset.id).cloned().unwrap_or_default();
            }
        }

        Ok(found)
    }

    /// Refresh only V2 filesystem signature fields for watcher modifications.
    pub fn update_asset_signature(
        &self, asset_id: &str, date_modified: &str, size: u64,
        width: Option<u32>, height: Option<u32>, _file_hash: Option<&str>,
    ) -> Result<(), String> {
        let mtime_ns = timestamp_ns(date_modified)?;
        let size = i64::try_from(size).map_err(|_| "文件大小超出 SQLite 整数范围".to_string())?;
        let mut conn = self.conn.lock();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let affected = tx.execute(
            "UPDATE assets SET mtime_ns = ?1, size = ?2, width = ?3, height = ?4,
                record_version = record_version + 1 WHERE id = ?5",
            params![mtime_ns, size, width, height, asset_id],
        ).map_err(|e| e.to_string())?;
        revision_after_mutation(&tx, affected)?;
        tx.commit().map_err(|e| e.to_string())
    }

    /// 更新资产评分与收藏状态
    pub fn set_asset_rating(&self, id: &str, rating: u8) -> Result<(), String> {
        self.patch_user_state(&AssetUserPatch::rating(id, rating)).map(|_| ())
    }

    pub fn set_asset_favorite(&self, id: &str, favorite: bool) -> Result<(), String> {
        self.patch_user_state(&AssetUserPatch {
            asset_id: id.to_string(), favorite: Some(favorite), ..AssetUserPatch::default()
        }).map(|_| ())
    }

    /// 批量删除资产
    pub fn delete_assets(&self, ids: &[String]) -> Result<(), String> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for id in ids {
            tx.execute("DELETE FROM assets WHERE id = ?1", params![id])
                .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    // =========================================================================
    // 资产-标签/集合 关联关系同步（供 UI 设置标签/集合后持久化）
    // =========================================================================

    /// 同步设置单个资产的标签集合（全量替换：删除旧的关联再写入新关联）
    pub fn sync_asset_tags(&self, asset_id: &str, tag_ids: &[String]) -> Result<(), String> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM asset_tags WHERE asset_id = ?1", params![asset_id])
            .map_err(|e| e.to_string())?;
        {
            let mut stmt = tx.prepare(
                "INSERT OR IGNORE INTO asset_tags (asset_id, tag_id) VALUES (?1, ?2)"
            ).map_err(|e| e.to_string())?;
            for tag_id in tag_ids {
                stmt.execute(params![asset_id, tag_id])
                    .map_err(|e| e.to_string())?;
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 同步设置单个资产的集合集合（全量替换）
    pub fn sync_asset_collections(&self, asset_id: &str, collection_ids: &[String]) -> Result<(), String> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM asset_collections WHERE asset_id = ?1", params![asset_id])
            .map_err(|e| e.to_string())?;
        {
            let mut stmt = tx.prepare(
                "INSERT OR IGNORE INTO asset_collections (asset_id, collection_id) VALUES (?1, ?2)"
            ).map_err(|e| e.to_string())?;
            for col_id in collection_ids {
                stmt.execute(params![asset_id, col_id])
                    .map_err(|e| e.to_string())?;
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 批量同步多个资产的标签（用于 UI 中一次多选后统一打标签）
    pub fn sync_many_asset_tags(&self, asset_ids: &[String], tag_ids: &[String]) -> Result<(), String> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        {
            let mut stmt = tx.prepare(
                "INSERT OR IGNORE INTO asset_tags (asset_id, tag_id) VALUES (?1, ?2)"
            ).map_err(|e| e.to_string())?;
            for asset_id in asset_ids {
                for tag_id in tag_ids {
                    stmt.execute(params![asset_id, tag_id])
                        .map_err(|e| e.to_string())?;
                }
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 批量同步多个资产的集合（用于 UI 中一次多选后统一加入集合）
    pub fn sync_many_asset_collections(&self, asset_ids: &[String], collection_ids: &[String]) -> Result<(), String> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        {
            let mut stmt = tx.prepare(
                "INSERT OR IGNORE INTO asset_collections (asset_id, collection_id) VALUES (?1, ?2)"
            ).map_err(|e| e.to_string())?;
            for asset_id in asset_ids {
                for col_id in collection_ids {
                    stmt.execute(params![asset_id, col_id])
                        .map_err(|e| e.to_string())?;
                }
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 从资产移除指定标签
    pub fn remove_asset_tags(&self, asset_id: &str, tag_ids: &[String]) -> Result<(), String> {
        let conn = self.conn.lock();
        for tag_id in tag_ids {
            conn.execute(
                "DELETE FROM asset_tags WHERE asset_id = ?1 AND tag_id = ?2",
                params![asset_id, tag_id],
            ).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// 从资产移除指定集合
    pub fn remove_asset_collections(&self, asset_id: &str, collection_ids: &[String]) -> Result<(), String> {
        let conn = self.conn.lock();
        for col_id in collection_ids {
            conn.execute(
                "DELETE FROM asset_collections WHERE asset_id = ?1 AND collection_id = ?2",
                params![asset_id, col_id],
            ).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    // =========================================================================
    // 文件夹、标签与集合 CRUD 操作
    // =========================================================================

    pub fn get_folders(&self) -> Result<Vec<Folder>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare("SELECT id, name, path, parent_id, is_monitored, mtime_ns FROM folders ORDER BY name ASC")
            .map_err(|e| e.to_string())?;

        let iter = stmt
            .query_map([], |row| {
                Ok(Folder {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    path: row.get(2)?,
                    parent_id: row.get(3)?,
                    is_monitored: row.get::<_, i32>(4)? != 0,
                    asset_count: None,
                    mtime: Some(chrono::DateTime::from_timestamp_nanos(row.get(5)?).to_rfc3339()),
                })
            })
            .map_err(|e| e.to_string())?;

        iter.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    /// 获取所有已监控的文件夹（用于启动时自动挂载文件监听器）
    pub fn get_monitored_folders(&self) -> Result<Vec<Folder>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare("SELECT id, name, path, parent_id, is_monitored, mtime_ns FROM folders WHERE is_monitored = 1 ORDER BY name ASC")
            .map_err(|e| e.to_string())?;

        let iter = stmt
            .query_map([], |row| {
                Ok(Folder {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    path: row.get(2)?,
                    parent_id: row.get(3)?,
                    is_monitored: row.get::<_, i32>(4)? != 0,
                    asset_count: None,
                    mtime: Some(chrono::DateTime::from_timestamp_nanos(row.get(5)?).to_rfc3339()),
                })
            })
            .map_err(|e| e.to_string())?;

        iter.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    /// Confirmed filesystem removals retain user state and relations for rediscovery.
    pub fn delete_assets_by_paths(&self, paths: &[String]) -> Result<usize, String> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let mut affected = 0;
        for path in paths {
            affected += tx.execute(
                "UPDATE assets SET deleted_at = ?1, record_version = record_version + 1
                 WHERE normalized_path = ?2 AND deleted_at IS NULL",
                params![chrono::Utc::now().timestamp_millis(), normalize_windows_path(path)],
            ).map_err(|e| e.to_string())?;
        }
        revision_after_mutation(&tx, affected)?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(affected)
    }

    pub fn delete_assets_by_ids(&self, ids: &[String]) -> Result<usize, String> {
        self.complete_scan_removals(&[], ids).map(|(_, assets)| assets)
    }

    /// Called only after a successful traversal and refresh. Cleanup and revision commit together.
    pub fn complete_scan_removals(
        &self, folder_paths: &[String], asset_ids: &[String],
    ) -> Result<(usize, usize), String> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let mut folders = 0;
        let mut assets = 0;
        for path in folder_paths {
            folders += tx.execute(
                "DELETE FROM folders WHERE normalized_path = ?1",
                [normalize_windows_path(path)],
            ).map_err(|e| e.to_string())?;
        }
        for id in asset_ids {
            assets += tx.execute(
                "UPDATE assets SET deleted_at = ?1, record_version = record_version + 1
                 WHERE id = ?2 AND deleted_at IS NULL",
                params![chrono::Utc::now().timestamp_millis(), id],
            ).map_err(|e| e.to_string())?;
        }
        revision_after_mutation(&tx, folders + assets)?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok((folders, assets))
    }

    /// Startup has no completed scan evidence: an absent/offline path is not a deletion.
    pub fn validate_assets(&self) -> Result<(usize, usize), String> {
        Ok((self.asset_count()?, 0))
    }

    /// 按路径查询资产（判断文件是否已在数据库中，兼容斜杠与大小写差异）
    pub fn get_asset_by_path(&self, path: &str) -> Result<Option<Asset>, String> {
        use rusqlite::OptionalExtension;
        let conn = self.conn.lock();
        conn.query_row(&format!(
            "SELECT {ASSET_COLUMNS} FROM assets a
             LEFT JOIN asset_user_state u ON u.asset_id = a.id
             WHERE a.normalized_path = ?1 AND a.deleted_at IS NULL"
        ), [normalize_windows_path(path)], asset_from_row)
            .optional().map_err(|e| e.to_string())
    }

    pub fn insert_folder(&self, folder: &Folder) -> Result<(), String> {
        self.upsert_folder(folder)
    }

    pub fn rename_folder(&self, id: &str, new_name: &str) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE folders SET name = ?1 WHERE id = ?2",
            params![new_name, id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn delete_folder(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM folders WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn update_folder(&self, folder: &Folder) -> Result<(), String> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let affected = tx.execute(
            "UPDATE folders SET name = ?1, path = ?2, normalized_path = ?3,
                parent_id = ?4, is_monitored = ?5, record_version = record_version + 1 WHERE id = ?6",
            params![folder.name, folder.path, normalize_windows_path(&folder.path),
                folder.parent_id, i32::from(folder.is_monitored), folder.id],
        ).map_err(|e| e.to_string())?;
        revision_after_mutation(&tx, affected)?;
        tx.commit().map_err(|e| e.to_string())
    }

    /// Reconciliation updates filesystem facts while retaining the monitoring preference.
    pub fn upsert_folder(&self, folder: &Folder) -> Result<(), String> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        Self::write_folder(&tx, folder)?;
        revision_after_mutation(&tx, 1)?;
        tx.commit().map_err(|e| e.to_string())
    }

    /// 轻量读取某根目录下全部资产的签名 (id, path, date_modified, size)，
    /// 供对账与库内现状比对，避免携带 tags/collections 的额外开销。
    pub fn get_asset_signatures_under(&self, root_path: &str) -> Result<Vec<(String, String, String, i64)>, String> {
        let root = normalize_windows_path(root_path);
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare("SELECT id, path, mtime_ns, size FROM assets WHERE deleted_at IS NULL")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    chrono::DateTime::from_timestamp_nanos(row.get(2)?).to_rfc3339(),
                    row.get::<_, i64>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            let r = row.map_err(|e| e.to_string())?;
            if crate::sync::is_path_under(&r.1, &root) {
                out.push(r);
            }
        }
        Ok(out)
    }

    /// Remove a confirmed absent folder tree; assets retain user state through SET NULL.
    pub fn delete_folder_tree_by_path(&self, path: &str) -> Result<usize, String> {
        self.complete_scan_removals(&[path.to_string()], &[]).map(|(folders, _)| folders)
    }

    /// Mark confirmed removals within an exact directory boundary; never cascade user state.
    pub fn delete_assets_by_prefix(&self, prefix: &str) -> Result<usize, String> {
        let root = normalize_windows_path(prefix);
        let lower = format!("{}\\", root.trim_end_matches('\\'));
        let upper = format!("{}]", root.trim_end_matches('\\'));
        let mut conn = self.conn.lock();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let affected = tx.execute(
            "UPDATE assets SET deleted_at = ?1, record_version = record_version + 1
             WHERE deleted_at IS NULL AND
                (normalized_path = ?2 OR (normalized_path >= ?3 AND normalized_path < ?4))",
            params![chrono::Utc::now().timestamp_millis(), root, lower, upper],
        ).map_err(|e| e.to_string())?;
        revision_after_mutation(&tx, affected)?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(affected)
    }

    pub fn get_tags(&self) -> Result<Vec<Tag>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare("SELECT id, name, color, description, is_pinned FROM tags ORDER BY name ASC")
            .map_err(|e| e.to_string())?;

        let iter = stmt
            .query_map([], |row| {
                Ok(Tag {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    color: row.get(2)?,
                    description: row.get(3)?,
                    is_pinned: Some(row.get::<_, i32>(4)? != 0),
                    count: None,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut tags = Vec::new();
        for t in iter.flatten() {
            tags.push(t);
        }
        Ok(tags)
    }

    pub fn insert_tag(&self, tag: &Tag) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO tags (id, name, color, description, is_pinned) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                tag.id,
                tag.name,
                tag.color,
                tag.description,
                tag.is_pinned.unwrap_or(false) as i32
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn update_tag(&self, id: &str, tag: &Tag) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE tags SET name = ?1, color = ?2, description = ?3, is_pinned = ?4 WHERE id = ?5",
            params![
                tag.name,
                tag.color,
                tag.description,
                tag.is_pinned.unwrap_or(false) as i32,
                id,
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn delete_tag(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM tags WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_collections(&self) -> Result<Vec<Collection>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare("SELECT id, name, color, description, is_pinned FROM collections ORDER BY name ASC")
            .map_err(|e| e.to_string())?;

        let iter = stmt
            .query_map([], |row| {
                Ok(Collection {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    color: row.get(2)?,
                    description: row.get(3)?,
                    is_pinned: Some(row.get::<_, i32>(4)? != 0),
                    count: None,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut cols = Vec::new();
        for c in iter.flatten() {
            cols.push(c);
        }
        Ok(cols)
    }

    pub fn insert_collection(&self, col: &Collection) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT OR REPLACE INTO collections (id, name, color, description, is_pinned) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                col.id,
                col.name,
                col.color,
                col.description,
                col.is_pinned.unwrap_or(false) as i32
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn update_collection(&self, id: &str, col: &Collection) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE collections SET name = ?1, color = ?2, description = ?3, is_pinned = ?4 WHERE id = ?5",
            params![
                col.name,
                col.color,
                col.description,
                col.is_pinned.unwrap_or(false) as i32,
                id,
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn delete_collection(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM collections WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    // =========================================================================
    // 智能文件夹持久化
    // =========================================================================

    pub fn get_smart_folders(&self) -> Result<Vec<SmartFolder>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare("SELECT id, name, icon, rules_json, match_all, is_search_history FROM smart_folders")
            .map_err(|e| e.to_string())?;

        let iter = stmt
            .query_map([], |row| {
                let rules_raw: String = row.get(3)?;
                let rules: Option<Vec<SmartFolderRule>> = serde_json::from_str(&rules_raw).ok();
                Ok(SmartFolder {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    icon: row.get(2)?,
                    rules,
                    match_all: Some(row.get::<_, i32>(4)? != 0),
                    is_search_history: Some(row.get::<_, i32>(5)? != 0),
                })
            })
            .map_err(|e| e.to_string())?;

        let mut list = Vec::new();
        for sf in iter.flatten() {
            list.push(sf);
        }
        Ok(list)
    }

    pub fn insert_smart_folder(&self, sf: &SmartFolder) -> Result<(), String> {
        let conn = self.conn.lock();
        let rules_json = serde_json::to_string(&sf.rules.clone().unwrap_or_default())
            .unwrap_or_else(|_| "[]".to_string());
        conn.execute(
            "INSERT OR REPLACE INTO smart_folders (id, name, icon, rules_json, match_all, is_search_history)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                sf.id,
                sf.name,
                sf.icon,
                rules_json,
                sf.match_all.unwrap_or(true) as i32,
                sf.is_search_history.unwrap_or(false) as i32
            ],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn delete_smart_folder(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute("DELETE FROM smart_folders WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

/// 将用户输入的关键词转为 FTS5 安全搜索表达式
/// 支持多词 AND 匹配：用户输入多个空格分隔的单词时，全部单词都必须出现
fn build_fts_query(user_input: &str) -> String {
    let words: Vec<&str> = user_input
        .split_whitespace()
        .map(|w| w.trim_matches(|c: char| !c.is_alphanumeric()))
        .filter(|w| !w.is_empty())
        .collect();

    if words.is_empty() {
        return user_input.to_string();
    }

    // 对每个词转义 FTS5 特殊字符，并用双引号包裹防止语法注入
    let escaped: Vec<String> = words
        .iter()
        .map(|w| {
            let cleaned: String = w
                .chars()
                .map(|c| match c {
                    '"' | '\'' | '(' | ')' | ':' | '*' | '-' | '^' | '/' | '~' | '\\' | '{' | '}' | '[' | ']' | '!' | '&' | '|' | '>' | '<' | '+' | '=' | '%' => ' ',
                    c => c,
                })
                .collect::<String>()
                .split_whitespace()
                .collect::<Vec<&str>>()
                .join(" ");

            if cleaned.contains(' ') {
                // 若被分割成多个片段，各片段独立 AND 匹配
                cleaned
                    .split_whitespace()
                    .map(|s| format!("\"{}\"", s))
                    .collect::<Vec<String>>()
                    .join(" ")
            } else if !cleaned.is_empty() {
                format!("\"{}\"", cleaned)
            } else {
                String::new()
            }
        })
        .filter(|s| !s.is_empty())
        .collect();

    if escaped.is_empty() {
        return user_input.to_string();
    }
    escaped.join(" ")
}
