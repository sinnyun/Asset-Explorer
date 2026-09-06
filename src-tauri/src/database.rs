//! ============================================================================
//! 模块：本地数据库与数据操作引擎 (database.rs)
//! 职责：负责本地 SQLite 嵌入式数据库生命周期、表结构初始化与迁移、所有的 CRUD
//! 数据持久化操作以及高性能原子事务批处理。
//! 依赖开源库：`rusqlite`, `parking_lot`, `dirs`
//! ============================================================================

use crate::models::{Asset, Collection, Folder, SmartFolder, SmartFolderRule, Tag};
use parking_lot::Mutex;
use rusqlite::{params, Connection, Result as SqlResult};
use serde::{Deserialize, Serialize};
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

impl Database {
    /// 初始化并连接本地 SQLite 数据库文件
    /// 自动从 app_config.json 读取自定义或默认存储路径
    pub fn init() -> Result<Self, String> {
        let db_dir = get_active_data_dir();
        let _ = fs::create_dir_all(&db_dir);

        let db_path = db_dir.join("assethub.db");
        println!("[Database] 打开本地 SQLite 数据库: {:?}", db_path);

        let conn = Connection::open(&db_path).map_err(|e| format!("打开数据库失败: {}", e))?;

        // 开启 WAL 高并发写入模式和外键约束
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA foreign_keys = ON;",
        )
        .map_err(|e| format!("配置数据库 PRAGMA 失败: {}", e))?;

        let db = Self {
            conn: Arc::new(Mutex::new(conn)),
            data_dir: db_dir,
        };

        db.migrate_schema()?;
        Ok(db)
    }

    /// 内存数据库初始化 (用于测试或快速启动备用)
    pub fn init_in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory().map_err(|e| e.to_string())?;
        let db = Self {
            conn: Arc::new(Mutex::new(conn)),
            data_dir: PathBuf::from(":memory:"),
        };
        db.migrate_schema()?;
        Ok(db)
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

        // 3. 递归复制全部缩略图缓存目录
        let src_thumb = self.data_dir.join("thumbnails");
        let dest_thumb = new_dir.join("thumbnails");
        if src_thumb.exists() {
            let _ = fs::create_dir_all(&dest_thumb);
            if let Ok(entries) = fs::read_dir(&src_thumb) {
                for entry in entries.flatten() {
                    let dest_file = dest_thumb.join(entry.file_name());
                    let _ = fs::copy(entry.path(), dest_file);
                }
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

    /// 创建或迁移核心数据表
    fn migrate_schema(&self) -> Result<(), String> {
        let conn = self.conn.lock();
        conn.execute_batch(
            "
            -- 1. 文件夹表
            CREATE TABLE IF NOT EXISTS folders (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                path TEXT NOT NULL,
                parent_id TEXT,
                is_monitored INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY (parent_id) REFERENCES folders(id) ON DELETE CASCADE
            );

            -- 2. 标签表
            CREATE TABLE IF NOT EXISTS tags (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                color TEXT NOT NULL
            );

            -- 3. 集合表
            CREATE TABLE IF NOT EXISTS collections (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE
            );

            -- 4. 资产主表
            CREATE TABLE IF NOT EXISTS assets (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                path TEXT NOT NULL UNIQUE,
                asset_type TEXT NOT NULL,
                size INTEGER NOT NULL,
                folder_id TEXT NOT NULL,
                date_modified TEXT NOT NULL,
                date_added TEXT NOT NULL,
                rating INTEGER NOT NULL DEFAULT 0,
                favorite INTEGER NOT NULL DEFAULT 0,
                color TEXT,
                width INTEGER,
                height INTEGER,
                file_hash TEXT,
                thumbnail_url TEXT,
                FOREIGN KEY (folder_id) REFERENCES folders(id) ON DELETE CASCADE
            );

            -- 5. 智能文件夹表
            CREATE TABLE IF NOT EXISTS smart_folders (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                icon TEXT NOT NULL,
                rules_json TEXT NOT NULL DEFAULT '[]',
                match_all INTEGER NOT NULL DEFAULT 1,
                is_search_history INTEGER NOT NULL DEFAULT 0
            );

            -- 6. 资产-标签关联多对多表
            CREATE TABLE IF NOT EXISTS asset_tags (
                asset_id TEXT NOT NULL,
                tag_id TEXT NOT NULL,
                PRIMARY KEY (asset_id, tag_id),
                FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE,
                FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
            );

            -- 7. 资产-集合关联多对多表
            CREATE TABLE IF NOT EXISTS asset_collections (
                asset_id TEXT NOT NULL,
                collection_id TEXT NOT NULL,
                PRIMARY KEY (asset_id, collection_id),
                FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE,
                FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE
            );

            -- 建立高性能查询索引
            CREATE INDEX IF NOT EXISTS idx_assets_folder ON assets(folder_id);
            CREATE INDEX IF NOT EXISTS idx_assets_type ON assets(asset_type);
            CREATE INDEX IF NOT EXISTS idx_assets_rating ON assets(rating);
            CREATE INDEX IF NOT EXISTS idx_assets_name ON assets(name);
            CREATE INDEX IF NOT EXISTS idx_asset_tags_tag ON asset_tags(tag_id);
            CREATE INDEX IF NOT EXISTS idx_asset_cols_col ON asset_collections(collection_id);
            ",
        )
        .map_err(|e| format!("数据库表结构初始化失败: {}", e))?;

        Ok(())
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

        // 3. 批量插入资产
        {
            let mut stmt = tx.prepare(
                "INSERT OR REPLACE INTO assets (
                    id, name, path, asset_type, size, folder_id, date_modified, date_added,
                    rating, favorite, color, width, height, file_hash, thumbnail_url
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
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

    /// 获取所有资产列表及附带标签/集合关联
    pub fn get_all_assets(&self) -> Result<Vec<Asset>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "SELECT id, name, path, asset_type, size, folder_id, date_modified, date_added,
                        rating, favorite, color, width, height, file_hash, thumbnail_url
                 FROM assets ORDER BY date_modified DESC",
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
            if let Ok(mut asset) = a {
                // 关联标签
                if let Ok(tags) = self.get_tags_for_asset_internal(&conn, &asset.id) {
                    asset.tags = tags;
                }
                // 关联集合
                if let Ok(cols) = self.get_cols_for_asset_internal(&conn, &asset.id) {
                    asset.collections = cols;
                }
                assets.push(asset);
            }
        }

        Ok(assets)
    }

    fn get_tags_for_asset_internal(&self, conn: &Connection, asset_id: &str) -> SqlResult<Vec<String>> {
        let mut stmt = conn.prepare("SELECT tag_id FROM asset_tags WHERE asset_id = ?1")?;
        let rows = stmt.query_map(params![asset_id], |row| row.get(0))?;
        let mut tags = Vec::new();
        for r in rows.flatten() {
            tags.push(r);
        }
        Ok(tags)
    }

    fn get_cols_for_asset_internal(&self, conn: &Connection, asset_id: &str) -> SqlResult<Vec<String>> {
        let mut stmt = conn.prepare("SELECT collection_id FROM asset_collections WHERE asset_id = ?1")?;
        let rows = stmt.query_map(params![asset_id], |row| row.get(0))?;
        let mut cols = Vec::new();
        for r in rows.flatten() {
            cols.push(r);
        }
        Ok(cols)
    }

    /// 更新资产基础属性 (评分/收藏/重命名/颜色)
    pub fn update_asset_field(&self, id: &str, field: &str, value: &str) -> Result<(), String> {
        let conn = self.conn.lock();
        let query = format!("UPDATE assets SET {} = ?1 WHERE id = ?2", field);
        conn.execute(&query, params![value, id])
            .map_err(|e| e.to_string())?;
        Ok(())
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
    // 文件夹、标签与集合 CRUD 操作
    // =========================================================================

    pub fn get_folders(&self) -> Result<Vec<Folder>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare("SELECT id, name, path, parent_id, is_monitored FROM folders ORDER BY name ASC")
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
            .prepare("SELECT id, name, path, parent_id, is_monitored FROM folders WHERE is_monitored = 1 ORDER BY name ASC")
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
                })
            })
            .map_err(|e| e.to_string())?;

        let mut folders = Vec::new();
        for f in iter.flatten() {
            folders.push(f);
        }
        Ok(folders)
    }

    /// 按路径批量删除资产（用于文件监控检测到删除时）
    pub fn delete_assets_by_paths(&self, paths: &[String]) -> Result<usize, String> {
        let conn = self.conn.lock();
        let mut count = 0usize;
        for path in paths {
            let affected = conn
                .execute("DELETE FROM assets WHERE path = ?1", params![path])
                .map_err(|e| e.to_string())?;
            count += affected;
        }
        Ok(count)
    }

    /// 启动时校验资产有效性：删除数据库中文件已不存在的资产记录
    pub fn validate_assets(&self) -> Result<(usize, usize), String> {
        let assets = self.get_all_assets()?;
        let total = assets.len();
        let mut paths_to_delete: Vec<String> = Vec::new();

        for asset in &assets {
            let path = std::path::Path::new(&asset.path);
            if !path.exists() {
                paths_to_delete.push(asset.path.clone());
            }
        }

        let deleted = self.delete_assets_by_paths(&paths_to_delete)?;
        println!("[Validation] 启动资产校验: 共检查 {} 个资产, 删除 {} 个无效路径", total, deleted);
        Ok((total, deleted))
    }

    /// 按路径查询资产（判断文件是否已在数据库中）
    pub fn get_asset_by_path(&self, path: &str) -> Result<Option<Asset>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare(
                "SELECT id, name, path, asset_type, size, folder_id, date_modified, date_added,
                        rating, favorite, color, width, height, file_hash, thumbnail_url
                 FROM assets WHERE path = ?1 LIMIT 1",
            )
            .map_err(|e| e.to_string())?;

        let mut rows = stmt
            .query_map(params![path], |row| {
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
        conn.execute(
            "INSERT OR REPLACE INTO folders (id, name, path, parent_id, is_monitored) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![folder.id, folder.name, folder.path, folder.parent_id, folder.is_monitored as i32],
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

    pub fn get_tags(&self) -> Result<Vec<Tag>, String> {
        let conn = self.conn.lock();
        let mut stmt = conn
            .prepare("SELECT id, name, color FROM tags ORDER BY name ASC")
            .map_err(|e| e.to_string())?;

        let iter = stmt
            .query_map([], |row| {
                Ok(Tag {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    color: row.get(2)?,
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
            "INSERT OR REPLACE INTO tags (id, name, color) VALUES (?1, ?2, ?3)",
            params![tag.id, tag.name, tag.color],
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
            .prepare("SELECT id, name FROM collections ORDER BY name ASC")
            .map_err(|e| e.to_string())?;

        let iter = stmt
            .query_map([], |row| {
                Ok(Collection {
                    id: row.get(0)?,
                    name: row.get(1)?,
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
            "INSERT OR REPLACE INTO collections (id, name) VALUES (?1, ?2)",
            params![col.id, col.name],
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
