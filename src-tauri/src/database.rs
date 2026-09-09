//! ============================================================================
//! 模块：本地数据库与数据操作引擎 (database.rs)
//! 职责：负责本地 SQLite 嵌入式数据库生命周期、表结构初始化与迁移、所有的 CRUD
//! 数据持久化操作以及高性能原子事务批处理。
//! 依赖开源库：`rusqlite`, `parking_lot`, `dirs`, `fs_extra`
//! ============================================================================

use crate::models::{
    Asset, AssetDetail, AssetUserPatch, Collection, FileFact, Folder, MutationSummary,
    SmartFolder, SmartFolderRule, Tag,
};
use parking_lot::Mutex;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppConfig {
    pub data_dir: String,
    pub monitored_folders: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct StorageStats {
    pub data_dir: String,
    pub db_size_bytes: u64,
    pub thumbnails_size_bytes: u64,
    pub total_size_bytes: u64,
    pub asset_count: usize,
}

/// 获取全局默认配置存储路径 (%LOCALAPPDATA%\AssetHub\app_config.json)
pub fn get_config_file_path() -> PathBuf {
    let mut base = dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("./.data"));
    base.push("AssetHub");
    let _ = fs::create_dir_all(&base);
    base.join("app_config.json")
}

/// 读取或初始化当前激活的数据根目录
pub fn get_active_data_dir() -> PathBuf {
    let cfg_path = get_config_file_path();
    if cfg_path.exists() {
        if let Ok(content) = fs::read_to_string(&cfg_path) {
            if let Ok(cfg) = serde_json::from_str::<AppConfig>(&content) {
                let p = PathBuf::from(cfg.data_dir);
                if p.exists() || fs::create_dir_all(&p).is_ok() {
                    return p;
                }
            }
        }
    }

    let mut default_dir = dirs::data_local_dir().unwrap_or_else(|| PathBuf::from("./.data"));
    default_dir.push("AssetHub");
    let _ = fs::create_dir_all(&default_dir);
    default_dir
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

/// V2 使用独立数据库文件。旧版 assethub.db 保留在原处，不迁移也不删除。
pub const V2_DATABASE_FILE: &str = "assethub-v2.db";

/// 规范化根路径：去掉首尾空白与末尾分隔符，避免前缀误匹配。
fn normalize_root(p: &str) -> String {
    p.trim().trim_end_matches(['/', '\\']).to_string()
}

/// 判断文件路径是否位于某根目录（含根本身）之下。兼容 Windows/Linux 分隔符与大小写。
fn is_path_under(path: &str, root: &str) -> bool {
    let p = path.to_lowercase();
    let r = root.to_lowercase();
    if p == r {
        return true;
    }
    p.starts_with(&format!("{}/", r)) || p.starts_with(&format!("{}\\", r))
}

impl Database {
    /// 创建或打开全新的 V2 数据库。
    pub fn init_v2() -> Result<Self, String> {
        let db_dir = get_active_data_dir();
        fs::create_dir_all(&db_dir).map_err(|e| format!("创建 V2 数据目录失败: {e}"))?;
        Self::init_v2_at(&db_dir.join(V2_DATABASE_FILE))
    }

    /// 在指定位置创建 V2 数据库，供测试和显式存储位置使用。
    pub fn init_v2_at(db_path: &Path) -> Result<Self, String> {
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
            .query_row("SELECT COUNT(*) FROM assets", [], |row| row.get::<_, i64>(0))
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
        let db_file = self.data_dir.join("assethub.db");
        let db_wal = self.data_dir.join("assethub.db-wal");
        let db_shm = self.data_dir.join("assethub.db-shm");
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

        let asset_count = {
            let conn = self.conn.lock();
            conn.query_row("SELECT COUNT(*) FROM assets", [], |r| r.get::<_, i64>(0))
                .unwrap_or(0) as usize
        };

        StorageStats {
            data_dir: self.data_dir.to_string_lossy().to_string(),
            db_size_bytes: db_size,
            thumbnails_size_bytes: thumb_size,
            total_size_bytes: db_size + thumb_size,
            asset_count,
        }
    }

    /// 核心功能：完整本地数据迁移
    /// 将数据库、WAL 事务日志、全部缩略图缓存迁移至新目录，更新配置，并支持重启
    /// 使用 fs_extra 开源库替代手写目录复制逻辑
    pub fn migrate_storage(&self, new_dir: &Path) -> Result<(), String> {
        if !new_dir.exists() {
            fs::create_dir_all(new_dir).map_err(|e| format!("创建目标新目录失败: {}", e))?;
        }

        // 1. 刷写 SQLite WAL 日志
        self.checkpoint();

        // 2. 复制数据库核心文件
        let files_to_copy = ["assethub.db", "assethub.db-wal", "assethub.db-shm"];
        for f_name in &files_to_copy {
            let src = self.data_dir.join(f_name);
            if src.exists() {
                let dest = new_dir.join(f_name);
                fs::copy(&src, &dest).map_err(|e| format!("复制文件 {} 失败: {}", f_name, e))?;
            }
        }

        // 3. 递归复制全部缩略图缓存目录（使用 fs_extra 开源库替代手写 read_dir 遍历）
        let src_thumb = self.data_dir.join("thumbnails");
        let dest_thumb = new_dir.join("thumbnails");
        if src_thumb.exists() {
            fs::create_dir_all(&dest_thumb).map_err(|e| format!("创建缩略图目标目录失败: {}", e))?;
            // copy_inside=false(默认): 将源目录内容复制到目标目录中
            let mut copy_opts = fs_extra::dir::CopyOptions::new();
            copy_opts.overwrite = true;
            if let Err(e) = fs_extra::dir::copy(&src_thumb, &dest_thumb, &copy_opts) {
                eprintln!("[Database] 递归复制缩略图目录失败: {}", e);
            }
        }

        // 4. 更新持久化配置文件 app_config.json
        let cfg = AppConfig {
            data_dir: new_dir.to_string_lossy().to_string(),
            monitored_folders: Vec::new(),
        };
        let cfg_json = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
        let cfg_path = get_config_file_path();
        fs::write(&cfg_path, cfg_json).map_err(|e| format!("写入新路径配置失败: {}", e))?;

        println!("[Database] 数据完整迁移成功！已指向新目录: {:?}", new_dir);
        Ok(())
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

            CREATE TRIGGER IF NOT EXISTS assets_au
            AFTER UPDATE OF name, path, asset_type ON assets BEGIN
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
                    fact.normalized_path,
                    fact.name,
                    fact.extension,
                    fact.asset_type,
                    fact.mime,
                    fact.size as i64,
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
                tx.execute(
                    "INSERT OR IGNORE INTO asset_user_state(asset_id, updated_at) VALUES (?1, ?2)",
                    params![fact.id, now],
                )
                .map_err(|e| format!("初始化用户状态失败: {e}"))?;
            }
        }
        tx.commit().map_err(|e| format!("提交文件事实失败: {e}"))?;
        Ok(facts.len())
    }

    pub fn patch_user_state(&self, patch: &AssetUserPatch) -> Result<MutationSummary, String> {
        let conn = self.conn.lock();
        let now = chrono::Utc::now().timestamp_millis();
        let affected = conn
            .execute(
                "UPDATE asset_user_state SET
                    rating = COALESCE(?2, rating),
                    favorite = COALESCE(?3, favorite),
                    color = COALESCE(?4, color),
                    custom_name = COALESCE(?5, custom_name),
                    notes = COALESCE(?6, notes),
                    updated_at = ?7
                 WHERE asset_id = ?1",
                params![
                    patch.asset_id,
                    patch.rating,
                    patch.favorite.map(i32::from),
                    patch.color,
                    patch.custom_name,
                    patch.notes,
                    now,
                ],
            )
            .map_err(|e| format!("更新用户状态失败: {e}"))?;
        let revision = if affected > 0 {
            conn.execute(
                "UPDATE app_meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'revision'",
                [],
            )
            .map_err(|e| format!("更新数据版本失败: {e}"))?;
            conn.query_row(
                "SELECT CAST(value AS INTEGER) FROM app_meta WHERE key = 'revision'",
                [],
                |row| row.get(0),
            )
            .map_err(|e| format!("读取数据版本失败: {e}"))?
        } else {
            0
        };
        Ok(MutationSummary { affected, revision })
    }

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

    /// 批量保存扫描到的文件夹与资产 (原子事务加速，10,000 条记录在数十毫秒内完成)
    pub fn batch_save_scan_results(
        &self,
        root_folder: &Folder,
        sub_folders: &[Folder],
        assets: &[Asset],
    ) -> Result<(), String> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction().map_err(|e| e.to_string())?;

        // 1. 插入根文件夹
        tx.execute(
            "INSERT OR REPLACE INTO folders (id, name, path, parent_id, is_monitored) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                root_folder.id,
                root_folder.name,
                root_folder.path,
                root_folder.parent_id,
                root_folder.is_monitored as i32
            ],
        ).map_err(|e| e.to_string())?;

        // 2. 插入子文件夹
        for f in sub_folders {
            tx.execute(
                "INSERT OR REPLACE INTO folders (id, name, path, parent_id, is_monitored) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![f.id, f.name, f.path, f.parent_id, f.is_monitored as i32],
            ).map_err(|e| e.to_string())?;
        }

        // 3. 批量插入资产（使用 UPSERT 保留已有关联，避免 INSERT OR REPLACE 级联清空 asset_tags/asset_collections）
        {
            let mut stmt = tx.prepare(
                "INSERT INTO assets (
                    id, name, path, asset_type, size, folder_id, date_modified, date_added,
                    rating, favorite, color, width, height, file_hash, thumbnail_url
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
                ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    path = excluded.path,
                    asset_type = excluded.asset_type,
                    size = excluded.size,
                    folder_id = excluded.folder_id,
                    date_modified = excluded.date_modified,
                    date_added = excluded.date_added,
                    rating = excluded.rating,
                    favorite = excluded.favorite,
                    color = excluded.color,
                    width = excluded.width,
                    height = excluded.height,
                    file_hash = excluded.file_hash,
                    thumbnail_url = excluded.thumbnail_url",
            ).map_err(|e| e.to_string())?;

            for a in assets {
                stmt.execute(params![
                    a.id,
                    a.name,
                    a.path,
                    a.asset_type,
                    a.size as i64,
                    a.folder_id,
                    a.date_modified,
                    a.date_added,
                    a.rating as i32,
                    a.favorite as i32,
                    a.color,
                    a.width,
                    a.height,
                    a.file_hash,
                    a.thumbnail_url
                ])
                .map_err(|e| e.to_string())?;
            }
        }

        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 仅批量写入资产（UPSERT 保留已有关联）。
    /// 供增量扫描的分批阶段使用——文件夹已在「扫描开始」阶段由 batch_save_scan_results
    /// 一次性写入，此处只负责资产本身，避免每批都重复插入整棵目录树。
    pub fn batch_save_assets(&self, assets: &[Asset]) -> Result<(), String> {
        let mut conn = self.conn.lock();
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        {
            let mut stmt = tx.prepare(
                "INSERT INTO assets (
                    id, name, path, asset_type, size, folder_id, date_modified, date_added,
                    rating, favorite, color, width, height, file_hash, thumbnail_url
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
                ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    path = excluded.path,
                    asset_type = excluded.asset_type,
                    size = excluded.size,
                    folder_id = excluded.folder_id,
                    date_modified = excluded.date_modified,
                    date_added = excluded.date_added,
                    rating = excluded.rating,
                    favorite = excluded.favorite,
                    color = excluded.color,
                    width = excluded.width,
                    height = excluded.height,
                    file_hash = excluded.file_hash,
                    thumbnail_url = excluded.thumbnail_url",
            ).map_err(|e| e.to_string())?;

            for a in assets {
                stmt.execute(params![
                    a.id,
                    a.name,
                    a.path,
                    a.asset_type,
                    a.size as i64,
                    a.folder_id,
                    a.date_modified,
                    a.date_added,
                    a.rating as i32,
                    a.favorite as i32,
                    a.color,
                    a.width,
                    a.height,
                    a.file_hash,
                    a.thumbnail_url
                ])
                .map_err(|e| e.to_string())?;
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
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

        // 第一步：一次 JOIN 查询拉取全部资产
        let mut stmt = conn
            .prepare(
                "SELECT a.id, a.name, a.path, a.asset_type, a.size, a.folder_id,
                        a.date_modified, a.date_added, a.rating, a.favorite,
                        a.color, a.width, a.height, a.file_hash, a.thumbnail_url
                 FROM assets a
                 ORDER BY a.date_modified DESC",
            )
            .map_err(|e| e.to_string())?;

        let asset_iter = stmt
            .query_map([], |row| {
                Ok(Asset {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    path: row.get(2)?,
                    asset_type: row.get(3)?,
                    size: row.get::<_, i64>(4)? as u64,
                    folder_id: row.get(5)?,
                    date_modified: row.get(6)?,
                    date_added: row.get(7)?,
                    rating: row.get::<_, i32>(8)? as u8,
                    favorite: row.get::<_, i32>(9)? != 0,
                    color: row.get(10)?,
                    width: row.get(11)?,
                    height: row.get(12)?,
                    file_hash: row.get(13)?,
                    thumbnail_url: row.get(14)?,
                    tags: Vec::new(),
                    collections: Vec::new(),
                })
            })
            .map_err(|e| e.to_string())?;

        let mut assets = Vec::new();
        for a in asset_iter {
            if let Ok(asset) = a {
                assets.push(asset);
            }
        }

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

        // 通过 FTS5 索引定位匹配的 rowid，再 JOIN assets 表获取完整数据
        let sql = format!(
            "SELECT a.id, a.name, a.path, a.asset_type, a.size, a.folder_id,
                    a.date_modified, a.date_added, a.rating, a.favorite,
                    a.color, a.width, a.height, a.file_hash, a.thumbnail_url
             FROM assets_fts f
             JOIN assets a ON a.rowid = f.rowid
             WHERE f MATCH ?1
             ORDER BY a.date_modified DESC
             LIMIT ?2"
        );

        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| format!("FTS5 搜索准备失败: {}", e))?;

        let rows = stmt
            .query_map(params![fts_query, limit as i64], |row| {
                Ok(Asset {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    path: row.get(2)?,
                    asset_type: row.get(3)?,
                    size: row.get::<_, i64>(4)? as u64,
                    folder_id: row.get(5)?,
                    date_modified: row.get(6)?,
                    date_added: row.get(7)?,
                    rating: row.get::<_, i32>(8)? as u8,
                    favorite: row.get::<_, i32>(9)? != 0,
                    color: row.get(10)?,
                    width: row.get(11)?,
                    height: row.get(12)?,
                    file_hash: row.get(13)?,
                    thumbnail_url: row.get(14)?,
                    tags: Vec::new(),
                    collections: Vec::new(),
                })
            })
            .map_err(|e| format!("FTS5 搜索执行失败: {}", e))?;

        let mut found = Vec::new();
        for r in rows.flatten() {
            found.push(r);
        }

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

    /// 更新资产缩略图 URL（懒加载生成后保存）
    pub fn update_asset_thumbnail_url(&self, id: &str, thumbnail_url: &str) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE assets SET thumbnail_url = ?1 WHERE id = ?2",
            params![thumbnail_url, id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 单语句更新资产的磁盘签名字段（mtime/size/宽高/哈希），供 watcher 快速通道
    /// 在文件内容被修改后联动重读元数据使用，避免逐字段 UPDATE 的多次往返。
    pub fn update_asset_signature(
        &self,
        asset_id: &str,
        date_modified: &str,
        size: u64,
        width: Option<u32>,
        height: Option<u32>,
        file_hash: Option<&str>,
    ) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE assets SET date_modified = ?1, size = ?2, width = ?3, height = ?4, file_hash = ?5
             WHERE id = ?6",
            params![date_modified, size as i64, width, height, file_hash, asset_id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 更新资产评分与收藏状态
    pub fn set_asset_rating(&self, id: &str, rating: u8) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE assets SET rating = ?1 WHERE id = ?2",
            params![rating as i32, id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn set_asset_favorite(&self, id: &str, favorite: bool) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE assets SET favorite = ?1 WHERE id = ?2",
            params![favorite as i32, id],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
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
            .prepare("SELECT id, name, path, parent_id, is_monitored, mtime FROM folders ORDER BY name ASC")
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
                    mtime: row.get(5)?,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut folders = Vec::new();
        for f in iter.flatten() {
            folders.push(f);
        }
        Ok(folders)
    }

    /// 获取所有已监控的文件夹（用于启动时自动挂载文件监听器）
    pub fn get_monitored_folders(&self) -> Result<Vec<Folder>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare("SELECT id, name, path, parent_id, is_monitored, mtime FROM folders WHERE is_monitored = 1 ORDER BY name ASC")
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
                    mtime: row.get(5)?,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut folders = Vec::new();
        for f in iter.flatten() {
            folders.push(f);
        }
        Ok(folders)
    }

    /// 按路径批量删除资产（用于文件监控检测到删除时，兼容斜杠与大小写差异）
    pub fn delete_assets_by_paths(&self, paths: &[String]) -> Result<usize, String> {
        let conn = self.conn.lock();
        let mut count = 0usize;
        for path in paths {
            let p_raw = path.trim();
            let p_bs = p_raw.replace('/', "\\");
            let p_norm = p_bs.to_lowercase();
            let affected = conn
                .execute(
                    "DELETE FROM assets WHERE path = ?1 OR path = ?2 OR lower(replace(path, '/', '\\')) = ?3",
                    params![p_raw, p_bs, p_norm],
                )
                .map_err(|e| e.to_string())?;
            count += affected;
        }
        Ok(count)
    }

    /// 按 ID 批量删除资产（主键删除，最精确且不受路径格式影响）
    pub fn delete_assets_by_ids(&self, ids: &[String]) -> Result<usize, String> {
        let conn = self.conn.lock();
        let mut count = 0usize;
        for id in ids {
            let affected = conn
                .execute("DELETE FROM assets WHERE id = ?1", params![id])
                .unwrap_or(0);
            count += affected;
        }
        Ok(count)
    }

    /// 启动时校验资产有效性：删除数据库中文件已不存在的资产记录
    pub fn validate_assets(&self) -> Result<(usize, usize), String> {
        let assets = self.get_all_assets()?;
        let total = assets.len();
        let mut paths_to_delete: Vec<String> = Vec::new();
        let mut sample_paths: Vec<String> = Vec::new(); // 记录前 5 个路径用于调试

        for (i, asset) in assets.iter().enumerate() {
            let path = std::path::Path::new(&asset.path);
            let exists = path.exists();
            if i < 5 {
                sample_paths.push(format!("{} (存在: {})", asset.path, exists));
            }
            if !exists {
                paths_to_delete.push(asset.path.clone());
            }
        }

        // 输出前 5 个资产路径的检查结果，方便排查为什么 C:/Workspace 等路径未被清理
        println!("[Validation] 启动资产校验: 共检查 {} 个资产, 删除 {} 个无效路径, 前 5 个样本路径:", total, paths_to_delete.len());
        for s in &sample_paths {
            println!("[Validation]   路径: {}", s);
        }

        let deleted = self.delete_assets_by_paths(&paths_to_delete)?;
        println!("[Validation] 数据库实际删除记录数: {}", deleted);
        Ok((total, deleted))
    }

    /// 按路径查询资产（判断文件是否已在数据库中，兼容斜杠与大小写差异）
    pub fn get_asset_by_path(&self, path: &str) -> Result<Option<Asset>, String> {
        let conn = self.conn.lock();
        let p_raw = path.trim();
        let p_bs = p_raw.replace('/', "\\");
        let p_norm = p_bs.to_lowercase();
        let mut stmt = conn
            .prepare(
                "SELECT id, name, path, asset_type, size, folder_id, date_modified, date_added,
                        rating, favorite, color, width, height, file_hash, thumbnail_url
                 FROM assets 
                 WHERE path = ?1 OR path = ?2 OR lower(replace(path, '/', '\\')) = ?3 
                 LIMIT 1",
            )
            .map_err(|e| e.to_string())?;

        let mut rows = stmt
            .query_map(params![p_raw, p_bs, p_norm], |row| {
                Ok(Asset {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    path: row.get(2)?,
                    asset_type: row.get(3)?,
                    size: row.get::<_, i64>(4)? as u64,
                    folder_id: row.get(5)?,
                    date_modified: row.get(6)?,
                    date_added: row.get(7)?,
                    rating: row.get::<_, i32>(8)? as u8,
                    favorite: row.get::<_, i32>(9)? != 0,
                    color: row.get(10)?,
                    width: row.get(11)?,
                    height: row.get(12)?,
                    file_hash: row.get(13)?,
                    thumbnail_url: row.get(14)?,
                    tags: Vec::new(),
                    collections: Vec::new(),
                })
            })
            .map_err(|e| e.to_string())?;

        match rows.next() {
            Some(Ok(asset)) => Ok(Some(asset)),
            _ => Ok(None),
        }
    }

    pub fn insert_folder(&self, folder: &Folder) -> Result<(), String> {
        let conn = self.conn.lock();
        // 使用安全 UPSERT（ON CONFLICT DO UPDATE），避免 INSERT OR REPLACE 触发
        // 级联删除子文件夹/资产。
        conn.execute(
            "INSERT INTO folders (id, name, path, parent_id, is_monitored, mtime)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                path = excluded.path,
                parent_id = excluded.parent_id,
                is_monitored = excluded.is_monitored,
                mtime = excluded.mtime",
            params![
                folder.id,
                folder.name,
                folder.path,
                folder.parent_id,
                folder.is_monitored as i32,
                folder.mtime
            ],
        ).map_err(|e| e.to_string())?;
        Ok(())
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
        let conn = self.conn.lock();
        conn.execute(
            "UPDATE folders SET name = ?1, path = ?2, parent_id = ?3, is_monitored = ?4 WHERE id = ?5",
            params![
                folder.name,
                folder.path,
                folder.parent_id,
                folder.is_monitored as i32,
                folder.id,
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    // =========================================================================
    // 实时对账（Reconcile）支持方法
    // 磁盘为唯一真相源，数据库只是可丢弃缓存：对账时以磁盘目录/文件 mtime
    // 为增量信号，只对发生变化的条目做深度重读（详阅 PLAN_realtime_reconcile.md）。
    // =========================================================================

    /// 以安全 UPSERT 方式写入/更新单个文件夹（含 mtime），供对账增量使用。
    /// 使用 ON CONFLICT DO UPDATE，避免替换触发级联删除子文件夹/资产。
    pub fn upsert_folder(&self, folder: &Folder) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO folders (id, name, path, parent_id, is_monitored, mtime)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                path = excluded.path,
                parent_id = excluded.parent_id,
                is_monitored = excluded.is_monitored,
                mtime = excluded.mtime",
            params![
                folder.id,
                folder.name,
                folder.path,
                folder.parent_id,
                folder.is_monitored as i32,
                folder.mtime
            ],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 轻量读取某根目录下全部资产的签名 (id, path, date_modified, size)，
    /// 供对账与库内现状比对，避免携带 tags/collections 的额外开销。
    pub fn get_asset_signatures_under(&self, root_path: &str) -> Result<Vec<(String, String, String, i64)>, String> {
        let root = normalize_root(root_path);
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare("SELECT id, path, date_modified, size FROM assets")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for r in rows.flatten() {
            if is_path_under(&r.1, &root) {
                out.push(r);
            }
        }
        Ok(out)
    }

    /// 按文件夹物理路径删除该文件夹及其整棵子孙树（子文件夹与全部资产经外键级联）。
    /// 返回值表示删除的文件夹行数。
    pub fn delete_folder_tree_by_path(&self, path: &str) -> Result<usize, String> {
        let conn = self.conn.lock();
        // folders(parent_id)→folders 与 assets(folder_id)→folders 均为 ON DELETE CASCADE，
        // 删除父文件夹行即可级联清理整棵子树。
        let folder_id: Option<String> = conn
            .query_row("SELECT id FROM folders WHERE path = ?1 LIMIT 1", params![path], |r| r.get(0))
            .ok();
        let mut affected = 0usize;
        if let Some(fid) = folder_id {
            affected = conn
                .execute("DELETE FROM folders WHERE id = ?1", params![fid])
                .map_err(|e| e.to_string())?;
        }
        Ok(affected)
    }

    /// 按物理路径前缀删除资产（如目录重命名/移除后清理旧路径下的孤儿资产）。
    pub fn delete_assets_by_prefix(&self, prefix: &str) -> Result<usize, String> {
        let root = normalize_root(prefix);
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare("SELECT path FROM assets")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        let mut doomed: Vec<String> = Vec::new();
        for r in rows.flatten() {
            if is_path_under(&r, &root) {
                doomed.push(r);
            }
        }
        drop(stmt);
        let mut count = 0usize;
        if !doomed.is_empty() {
            count = self.delete_assets_by_paths(&doomed)?;
        }
        Ok(count)
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
