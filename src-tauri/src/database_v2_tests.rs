use crate::database::{Database, V2_DATABASE_FILE};
use crate::models::{
    Asset, AssetQuery, AssetSort, AssetUserPatch, FileFact, Folder, FolderQuery,
    WorkspaceShell,
};
use rusqlite::{params, Connection};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};
use std::sync::{Arc, Barrier};
use std::time::{Duration, Instant};

struct TestDir(PathBuf);

impl TestDir {
    fn new(label: &str) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock before epoch")
            .as_nanos();
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target").join(format!(
            "asset-explorer-v2-{label}-{}-{nonce}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).expect("create test directory");
        Self(path)
    }

    fn join(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn v2_database_uses_distinct_file_and_starts_empty() {
    let dir = TestDir::new("empty");
    let v2_path = dir.join(V2_DATABASE_FILE);
    let legacy_path = dir.join("assethub.db");
    let sentinel = b"legacy sentinel: never open as SQLite or modify";
    std::fs::write(&legacy_path, sentinel).unwrap();
    let db = Database::init_v2_at(&v2_path).expect("initialize V2 database");

    assert_eq!(db.asset_count().expect("count assets"), 0);
    assert!(v2_path.exists());
    assert_eq!(std::fs::read(&legacy_path).unwrap(), sentinel);
}

#[test]
fn v2_default_directory_ignores_obsolete_storage_config() {
    assert_eq!(crate::database::get_active_data_dir().unwrap(), dirs::data_local_dir().unwrap().join("AssetHub"));
    assert!(!include_str!("database.rs").contains("app_config.json"), "obsolete config must not redirect or be read by V2");
}

#[test]
fn v2_storage_relocation_is_disabled_without_side_effects() {
    let (dir, db) = test_db("no-relocation");
    let target = dir.join("relocated");
    assert!(db.migrate_storage(&target).is_err(), "storage selection is outside Task 1");
    assert!(!target.exists());
}

#[test]
fn v2_storage_statistics_count_only_v2_database_files() {
    let (dir, db) = test_db("stats");
    let expected: u64 = [V2_DATABASE_FILE.to_string(), format!("{V2_DATABASE_FILE}-wal"), format!("{V2_DATABASE_FILE}-shm")]
        .iter().map(|name| std::fs::metadata(dir.join(name)).map(|m| m.len()).unwrap_or(0)).sum();
    assert!(expected > 0);
    assert_eq!(db.get_storage_stats().db_size_bytes, expected);
}

#[test]
fn startup_reports_a_visible_windows_error_before_exit() {
    let source = include_str!("main.rs");
    assert!(source.contains("MessageBoxW"), "release builds need a native error dialog");
    let report = source.find("show_initialization_error(&error)").expect("report initialization error");
    let exit = source[report..].find("std::process::exit(1)").expect("exit after reporting");
    assert!(exit > 0);
    assert!(!source.contains("自动备份原文件"));
}

fn test_db(label: &str) -> (TestDir, Database) {
    let dir = TestDir::new(label);
    let db = Database::init_v2_at(&dir.join(V2_DATABASE_FILE)).expect("initialize test database");
    (dir, db)
}

fn fact(id: &str, normalized_path: &str, size: u64, mtime_ns: i64) -> FileFact {
    FileFact {
        id: id.to_string(),
        folder_id: None,
        path: normalized_path.to_string(),
        normalized_path: normalized_path.to_string(),
        name: normalized_path.rsplit('\\').next().unwrap_or(id).to_string(),
        extension: "png".to_string(),
        asset_type: "image".to_string(),
        mime: Some("image/png".to_string()),
        size,
        mtime_ns,
        volume_id: None,
        file_id: None,
        width: None,
        height: None,
        metadata_status: "pending".to_string(),
        generation: 1,
    }
}

#[test]
fn rescanning_file_facts_preserves_user_state() {
    let (_dir, db) = test_db("preserve-user-state");
    db.upsert_file_facts(&[fact("asset-a", r"d:\assets\a.png", 100, 10)])
        .expect("insert file fact");
    db.patch_user_state(&AssetUserPatch::rating("asset-a", 5))
        .expect("set rating");

    db.upsert_file_facts(&[fact("asset-a", r"d:\assets\a.png", 200, 20)])
        .expect("refresh file fact");

    let detail = db
        .get_asset_detail("asset-a")
        .expect("read detail")
        .expect("asset exists");
    assert_eq!(detail.rating, 5);
    assert_eq!(detail.size, 200);
    assert_eq!(detail.mtime_ns, 20);
}

#[test]
fn normalized_path_is_unique() {
    let (_dir, db) = test_db("unique-path");
    db.upsert_file_facts(&[fact("asset-a", r"d:\assets\same.png", 100, 10)])
        .expect("insert first path");

    let error = db
        .upsert_file_facts(&[fact("asset-b", r"d:\assets\same.png", 100, 10)])
        .expect_err("duplicate normalized path must be rejected");

    assert!(error.contains("normalized_path"), "unexpected error: {error}");
}

#[test]
fn user_state_is_stored_outside_assets_table() {
    let (_dir, db) = test_db("separate-user-state");
    assert!(!db.table_columns("assets").unwrap().contains(&"rating".to_string()));
    assert!(db
        .table_columns("asset_user_state")
        .unwrap()
        .contains(&"rating".to_string()));
}

#[test]
fn reads_do_not_wait_for_a_slow_writer_connection() {
    let (_dir, db) = test_db("read-write-overlap");
    let started = Arc::new(Barrier::new(2));
    let writer_db = db.clone();
    let writer_started = Arc::clone(&started);
    let writer = std::thread::spawn(move || {
        writer_db
            .write(move |_conn| {
                writer_started.wait();
                std::thread::sleep(Duration::from_millis(250));
                Ok(())
            })
            .unwrap();
    });

    started.wait();
    let before = Instant::now();
    assert_eq!(db.asset_count().unwrap(), 0);
    assert!(
        before.elapsed() < Duration::from_millis(150),
        "read waited for the writer connection: {:?}",
        before.elapsed()
    );
    writer.join().unwrap();
}

#[test]
fn database_write_queue_has_a_fixed_capacity() {
    let (_dir, db) = test_db("write-capacity");
    assert_eq!(db.write_queue_capacity(), 256);
    assert_eq!(db.read_pool_capacity(), 4);
}

#[test]
fn cursor_pages_are_stable_when_sort_values_are_equal() {
    let (_dir, db) = test_db("cursor-stability");
    let facts = (0..7)
        .map(|index| {
            let mut item = fact(
                &format!("asset-{index}"),
                &format!(r"d:\assets\{index}.png"),
                100,
                10,
            );
            item.name = "same.png".to_string();
            item
        })
        .collect::<Vec<_>>();
    db.upsert_file_facts(&facts).unwrap();

    let mut query = AssetQuery {
        sort: AssetSort::NameAsc,
        limit: 3,
        ..AssetQuery::default()
    };
    let first = db.query_assets(&query).unwrap();
    assert_eq!(first.items.len(), 3);
    assert!(first.next_cursor.is_some());

    query.cursor = first.next_cursor;
    let second = db.query_assets(&query).unwrap();
    let first_ids = first.items.iter().map(|asset| &asset.id).collect::<std::collections::HashSet<_>>();
    assert!(second.items.iter().all(|asset| !first_ids.contains(&asset.id)));
    assert_eq!(second.items.len(), 3);
}

#[test]
fn asset_query_rejects_invalid_cursor_and_clamps_page_size() {
    let (_dir, db) = test_db("cursor-validation");
    let invalid = AssetQuery {
        cursor: Some("not-a-v2-cursor".to_string()),
        ..AssetQuery::default()
    };
    assert!(db.query_assets(&invalid).unwrap_err().contains("游标"));

    let query = AssetQuery { limit: 10_000, ..AssetQuery::default() };
    let page = db.query_assets(&query).unwrap();
    assert_eq!(page.limit, 300);
}

#[test]
fn asset_query_filters_user_state_without_loading_the_full_table() {
    let (_dir, db) = test_db("query-user-state");
    db.upsert_file_facts(&[
        fact("favorite", r"d:\assets\favorite.png", 100, 20),
        fact("plain", r"d:\assets\plain.png", 100, 10),
    ])
    .unwrap();
    db.patch_user_state(&AssetUserPatch {
        asset_id: "favorite".to_string(),
        favorite: Some(true),
        ..AssetUserPatch::default()
    })
    .unwrap();

    let page = db
        .query_assets(&AssetQuery {
            favorite: Some(true),
            sort: AssetSort::ModifiedDesc,
            ..AssetQuery::default()
        })
        .unwrap();
    assert_eq!(page.items.iter().map(|asset| asset.id.as_str()).collect::<Vec<_>>(), ["favorite"]);
}

#[test]
fn folder_query_loads_only_the_requested_level() {
    let (_dir, db) = test_db("lazy-folders");
    let root = folder("root", r"d:\assets");
    let mut child = folder("child", r"d:\assets\child");
    child.parent_id = Some(root.id.clone());
    let mut grandchild = folder("grandchild", r"d:\assets\child\deep");
    grandchild.parent_id = Some(child.id.clone());
    db.upsert_folder(&root).unwrap();
    db.upsert_folder(&child).unwrap();
    db.upsert_folder(&grandchild).unwrap();

    let page = db
        .query_folders(&FolderQuery {
            parent_id: Some(root.id.clone()),
            limit: 100,
            ..FolderQuery::default()
        })
        .unwrap();
    assert_eq!(page.items.iter().map(|item| item.id.as_str()).collect::<Vec<_>>(), ["child"]);
}

#[test]
fn asset_details_are_loaded_only_for_requested_ids() {
    let (_dir, db) = test_db("asset-details");
    db.upsert_file_facts(&[
        fact("a", r"d:\assets\a.png", 10, 10),
        fact("b", r"d:\assets\b.png", 20, 20),
        fact("c", r"d:\assets\c.png", 30, 30),
    ])
    .unwrap();

    let details = db
        .get_asset_details(&["b".to_string(), "a".to_string()])
        .unwrap();
    assert_eq!(details.iter().map(|item| item.id.as_str()).collect::<Vec<_>>(), ["b", "a"]);
}

#[test]
fn v2_query_dtos_round_trip_with_frontend_field_names() {
    let query = AssetQuery {
        folder_id: Some("folder-a".to_string()),
        include_descendants: true,
        sort: AssetSort::ModifiedDesc,
        limit: 200,
        ..AssetQuery::default()
    };
    let value = serde_json::to_value(&query).unwrap();
    assert_eq!(value["folderId"], "folder-a");
    assert_eq!(value["includeDescendants"], true);
    assert_eq!(value["sort"], "modified_desc");
    let decoded: AssetQuery = serde_json::from_value(value).unwrap();
    assert_eq!(decoded.folder_id.as_deref(), Some("folder-a"));
}

#[test]
fn v2_commands_are_registered_without_replacing_errors_with_empty_data() {
    let main = include_str!("main.rs");
    let commands = include_str!("commands.rs");
    for command in [
        "get_workspace_shell_v2",
        "query_assets_v2",
        "query_folders_v2",
        "get_asset_details_v2",
    ] {
        assert!(main.contains(command), "missing command registration: {command}");
        assert!(commands.contains(&format!("fn {command}")), "missing command implementation: {command}");
    }
    assert!(!commands.contains("unwrap_or_default() // v2"));
    let _: Option<WorkspaceShell> = None;
}

fn connection(dir: &TestDir) -> Connection {
    let conn = Connection::open(dir.join(V2_DATABASE_FILE)).unwrap();
    conn.execute_batch("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;").unwrap();
    conn
}

fn number(conn: &Connection, sql: &str) -> i64 {
    conn.query_row(sql, [], |row| row.get(0)).unwrap()
}

fn folder(id: &str, path: &str) -> Folder {
    Folder { id: id.into(), name: id.into(), path: path.into(), parent_id: None,
        is_monitored: true, asset_count: None, mtime: Some("2026-09-09T00:00:00Z".into()) }
}

fn scan_asset(id: &str, folder_id: &str, path: &str) -> Asset {
    Asset { id: id.into(), name: "a.png".into(), path: path.into(), asset_type: "image".into(),
        size: 100, folder_id: folder_id.into(), tags: vec![], collections: vec![],
        date_modified: "2026-09-09T00:00:00Z".into(), date_added: "2026-09-09T00:00:00Z".into(),
        rating: 0, favorite: false, color: None, width: None, height: None,
        file_hash: None, thumbnail_url: None }
}

#[test]
fn file_facts_normalize_paths_in_rust_and_reject_equivalent_duplicates() {
    let (_dir, db) = test_db("canonical-assets");
    let mut first = fact("a", "  D:/Assets/A.PNG/  ", 100, 10);
    first.normalized_path = "caller supplied nonsense".into();
    db.upsert_file_facts(&[first]).unwrap();
    assert_eq!(db.get_asset_detail("a").unwrap().unwrap().normalized_path, r"d:\assets\a.png");
    for path in [r"d:\assets\a.png", "D:/ASSETS/A.PNG", " d:/assets/a.png\\ "] {
        assert!(db.upsert_file_facts(&[fact("b", path, 200, 20)]).is_err(), "duplicate: {path}");
    }
}

#[test]
fn scan_path_ids_are_case_and_separator_independent() {
    assert_eq!(crate::indexer::stable_hash(" D:/Assets/A.PNG/ "), crate::indexer::stable_hash(r"d:\assets\a.png"));
}

#[test]
fn folder_writers_normalize_and_preserve_children() {
    let (dir, db) = test_db("folder-writers");
    let mut root = folder("root", " D:/Assets/ ");
    db.insert_folder(&root).unwrap();
    let mut child = folder("child", "D:/Assets/Child/");
    child.parent_id = Some(root.id.clone());
    db.upsert_folder(&child).unwrap();
    db.batch_save_scan_results(&root, &[], &[]).unwrap();
    root.path = "D:/Renamed/".into();
    db.update_folder(&root).unwrap();
    let conn = connection(&dir);
    let stored: String = conn.query_row("SELECT normalized_path FROM folders WHERE id='root'", [], |r| r.get(0)).unwrap();
    assert_eq!(stored, r"d:\renamed");
    assert_eq!(number(&conn, "SELECT count(*) FROM folders"), 2);
    assert!(db.insert_folder(&folder("duplicate", r"d:\renamed")).is_err());
    assert_eq!(db.get_folders().unwrap().len(), 2);
    assert_eq!(db.get_monitored_folders().unwrap().len(), 2);
}

#[test]
fn folder_update_normalizes_existing_v2_rows() {
    let (dir, db) = test_db("folder-update");
    connection(&dir).execute(r"INSERT INTO folders(id,name,path,normalized_path) VALUES ('root','root','D:/Old','d:\old')", []).unwrap();
    db.update_folder(&folder("root", " D:/New/ ")).unwrap();
    let stored: String = connection(&dir).query_row("SELECT normalized_path FROM folders", [], |r| r.get(0)).unwrap();
    assert_eq!(stored, r"d:\new");
}

#[test]
fn file_facts_never_create_or_update_user_state() {
    let (dir, db) = test_db("fact-ownership");
    let conn = connection(&dir);
    conn.execute_batch("CREATE TRIGGER forbid_state_insert BEFORE INSERT ON asset_user_state BEGIN SELECT RAISE(ABORT, 'fact writer touched user state'); END;
        CREATE TRIGGER forbid_state_update BEFORE UPDATE ON asset_user_state BEGIN SELECT RAISE(ABORT, 'fact writer touched user state'); END;").unwrap();
    db.upsert_file_facts(&[fact("a", r"d:\assets\a.png", 100, 10)]).unwrap();
    db.upsert_file_facts(&[fact("a", r"d:\assets\a.png", 200, 20)]).unwrap();
    assert_eq!(number(&conn, "SELECT count(*) FROM asset_user_state"), 0);
}

fn set_all_user_state(db: &Database, conn: &Connection, id: &str) {
    db.patch_user_state(&AssetUserPatch { asset_id: id.into(), rating: Some(5), favorite: Some(true),
        color: Some("red".into()), custom_name: Some("My artwork".into()), notes: Some("Keep this".into()) }).unwrap();
    conn.execute_batch("INSERT OR IGNORE INTO tags(id,name,color) VALUES ('tag','Important','red');
        INSERT OR IGNORE INTO collections(id,name) VALUES ('collection','Portfolio');").unwrap();
    db.sync_asset_tags(id, &["tag".into()]).unwrap();
    db.sync_asset_collections(id, &["collection".into()]).unwrap();
}

fn assert_all_user_state(db: &Database, conn: &Connection, id: &str) {
    let detail = db.get_asset_detail(id).unwrap().unwrap();
    assert_eq!(detail.rating, 5);
    assert!(detail.favorite);
    assert_eq!(detail.color.as_deref(), Some("red"));
    assert_eq!(detail.custom_name.as_deref(), Some("My artwork"));
    assert_eq!(detail.notes.as_deref(), Some("Keep this"));
    for table in ["asset_tags", "asset_collections"] {
        let count: i64 = conn.query_row(&format!("SELECT count(*) FROM {table} WHERE asset_id=?1"), [id], |r| r.get(0)).unwrap();
        assert_eq!(count, 1, "{table}");
    }
}

#[test]
fn all_scan_writers_preserve_every_user_field_and_relation() {
    let (dir, db) = test_db("scan-ownership");
    let conn = connection(&dir);
    let root = folder("root", "D:/Assets/");
    let mut asset = scan_asset("a", "root", "D:/Assets/A.PNG");
    db.batch_save_scan_results(&root, &[], &[asset.clone()]).unwrap();
    set_all_user_state(&db, &conn, "a");
    asset.size = 200;
    db.batch_save_scan_results(&root, &[], &[asset.clone()]).unwrap();
    assert_all_user_state(&db, &conn, "a");
    asset.size = 300;
    db.batch_save_assets(&[asset]).unwrap();
    assert_all_user_state(&db, &conn, "a");
    let mut refresh = fact("a", "D:/Assets/A.PNG", 400, 20);
    refresh.folder_id = Some("root".into());
    db.upsert_file_facts(&[refresh]).unwrap();
    assert_all_user_state(&db, &conn, "a");
    assert_eq!(db.get_asset_detail("a").unwrap().unwrap().size, 400);
}

#[test]
fn user_patch_rolls_back_when_revision_update_fails() {
    let (dir, db) = test_db("atomic-patch");
    db.upsert_file_facts(&[fact("a", r"d:\a.png", 100, 10)]).unwrap();
    db.patch_user_state(&AssetUserPatch::rating("a", 2)).unwrap();
    let conn = connection(&dir);
    let before = number(&conn, "SELECT CAST(value AS INTEGER) FROM app_meta WHERE key='revision'");
    conn.execute_batch("CREATE TRIGGER fail_revision BEFORE UPDATE ON app_meta WHEN old.key='revision' BEGIN SELECT RAISE(ABORT,'injected revision failure'); END;").unwrap();
    assert!(db.patch_user_state(&AssetUserPatch::rating("a", 5)).is_err());
    assert_eq!(db.get_asset_detail("a").unwrap().unwrap().rating, 2);
    assert_eq!(number(&conn, "SELECT CAST(value AS INTEGER) FROM app_meta WHERE key='revision'"), before);
}

#[test]
fn missing_user_patch_returns_current_revision_without_creating_state() {
    let (dir, db) = test_db("missing-patch");
    db.upsert_file_facts(&[fact("a", r"d:\a.png", 100, 10)]).unwrap();
    let changed = db.patch_user_state(&AssetUserPatch::rating("a", 3)).unwrap();
    let missing = db.patch_user_state(&AssetUserPatch::rating("missing", 4)).unwrap();
    assert_eq!(missing.affected, 0);
    assert_eq!(missing.revision, changed.revision);
    assert_eq!(number(&connection(&dir), "SELECT count(*) FROM asset_user_state WHERE asset_id='missing'"), 0);
}

#[test]
fn size_only_refresh_does_not_rewrite_fts() {
    let (dir, db) = test_db("fts-refresh");
    db.upsert_file_facts(&[fact("a", r"d:\assets\needle.png", 100, 10)]).unwrap();
    let conn = connection(&dir);
    assert_eq!(number(&conn, "SELECT count(*) FROM assets_fts WHERE assets_fts MATCH 'needle'"), 1);
    conn.execute_batch("CREATE TRIGGER detect_fts_insert BEFORE INSERT ON assets_fts_docsize BEGIN SELECT RAISE(ABORT,'unexpected FTS rewrite'); END;
        CREATE TRIGGER detect_fts_delete BEFORE DELETE ON assets_fts_docsize BEGIN SELECT RAISE(ABORT,'unexpected FTS rewrite'); END;").unwrap();
    db.upsert_file_facts(&[fact("a", r"d:\assets\needle.png", 200, 10)]).unwrap();
    assert_eq!(number(&conn, "SELECT count(*) FROM assets_fts WHERE assets_fts MATCH 'needle'"), 1);
    assert_eq!(number(&conn, "SELECT count(*) FROM assets_fts"), 1);
    assert_eq!(db.get_asset_detail("a").unwrap().unwrap().size, 200);
    conn.execute_batch("DROP TRIGGER detect_fts_insert; DROP TRIGGER detect_fts_delete;").unwrap();
    let mut renamed = fact("a", r"d:\assets\other.png", 200, 10);
    renamed.asset_type = "document".into();
    db.upsert_file_facts(&[renamed]).unwrap();
    assert_eq!(number(&conn, "SELECT count(*) FROM assets_fts WHERE assets_fts MATCH 'needle'"), 0);
    assert_eq!(number(&conn, "SELECT count(*) FROM assets_fts WHERE assets_fts MATCH 'other AND document'"), 1);
}

#[test]
fn associations_enforce_composite_uniqueness() {
    let (dir, db) = test_db("associations");
    db.upsert_file_facts(&[fact("a", r"d:\a.png", 100, 10)]).unwrap();
    let conn = connection(&dir);
    set_all_user_state(&db, &conn, "a");
    for (table, column, id) in [("asset_tags", "tag_id", "tag"), ("asset_collections", "collection_id", "collection")] {
        assert!(conn.execute(&format!("INSERT INTO {table}(asset_id,{column}) VALUES (?1,?2)"), params!["a", id]).is_err());
        assert_eq!(number(&conn, &format!("SELECT count(*) FROM {table}")), 1);
    }
}

#[test]
fn failed_scan_batch_rolls_back_folders_and_keeps_unseen_assets() {
    let (dir, db) = test_db("scan-rollback");
    db.upsert_file_facts(&[fact("unseen", r"d:\unseen.png", 100, 10)]).unwrap();
    let conn = connection(&dir);
    set_all_user_state(&db, &conn, "unseen");
    let root = folder("root", "D:/Assets");
    let good = scan_asset("good", "root", "D:/Assets/good.png");
    let mut bad = scan_asset("bad", "root", "D:/Assets/bad.png");
    bad.size = u64::MAX;
    assert!(db.batch_save_scan_results(&root, &[], &[good, bad]).is_err());
    assert_eq!(db.asset_count().unwrap(), 1);
    assert_eq!(number(&conn, "SELECT count(*) FROM folders"), 0);
    assert_all_user_state(&db, &conn, "unseen");
}

#[test]
fn full_and_incremental_scan_pipelines_write_v2() {
    let (dir, db) = test_db("scan-pipelines");
    let root = dir.join("input");
    std::fs::create_dir_all(root.join("child")).unwrap();
    std::fs::write(root.join("a.txt"), b"one").unwrap();
    std::fs::write(root.join("child/b.txt"), b"two").unwrap();
    let path = root.to_str().unwrap();
    let scan = crate::indexer::scan_local_directory(path).unwrap();
    db.batch_save_scan_results(&scan.root_folder, &scan.sub_folders, &scan.assets).unwrap();
    let incremental = crate::indexer::scan_local_directory_incremental(path,
        &mut |root, folders, _| db.batch_save_scan_results(root, folders, &[]),
        &mut |assets, _, _| db.batch_save_assets(assets)).unwrap();
    assert_eq!(incremental.total_files_scanned, 2);
    assert_eq!(db.asset_count().unwrap(), 2);
    let failed = crate::indexer::scan_local_directory_incremental(path,
        &mut |root, folders, _| db.batch_save_scan_results(root, folders, &[]),
        &mut |_, _, _| Err("injected scan failure".into()));
    assert!(failed.unwrap_err().contains("injected scan failure"));
    assert_eq!(db.asset_count().unwrap(), 2);
}

#[test]
fn normalized_and_cursor_lookups_use_indexes() {
    let (dir, _db) = test_db("query-plans");
    let conn = connection(&dir);
    let queries = [
        ("SELECT id FROM assets WHERE normalized_path='d:\\a.png'", "sqlite_autoindex_assets_2"),
        ("SELECT id FROM folders WHERE normalized_path='d:\\assets'", "sqlite_autoindex_folders_2"),
        ("SELECT id FROM folders WHERE parent_id='root' AND (name,id)>('a','a') ORDER BY name,id LIMIT 50", "idx_folders_parent_name"),
        ("SELECT id,name FROM assets WHERE folder_id='root' AND (name COLLATE NOCASE,id)>('a','a') ORDER BY name COLLATE NOCASE,id LIMIT 50", "idx_assets_folder_name"),
        ("SELECT id,mtime_ns FROM assets WHERE folder_id='root' AND mtime_ns<=100 ORDER BY mtime_ns DESC,id LIMIT 50", "idx_assets_folder_mtime"),
        ("SELECT id,size FROM assets WHERE folder_id='root' AND size<=100 ORDER BY size DESC,id LIMIT 50", "idx_assets_folder_size"),
        ("SELECT id FROM assets WHERE asset_type='image' AND mtime_ns<=100 ORDER BY mtime_ns DESC,id LIMIT 50", "idx_assets_type_mtime"),
    ];
    for (sql, index) in queries {
        let mut stmt = conn.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
        let plan = stmt.query_map([], |r| r.get::<_, String>(3)).unwrap().collect::<Result<Vec<_>,_>>().unwrap().join("; ");
        println!("{index}: {plan}");
        assert!(plan.contains("SEARCH") && plan.contains(index), "{plan}");
        assert!(!plan.contains("TEMP B-TREE"), "{plan}");
    }
}

#[test]
fn scan_signature_writer_uses_v2_facts_and_preserves_user_state() {
    let (dir, db) = test_db("signature-writer");
    db.upsert_file_facts(&[fact("a", r"d:\assets\a.png", 100, 10)]).unwrap();
    let conn = connection(&dir);
    set_all_user_state(&db, &conn, "a");
    db.update_asset_signature("a", "2026-09-09T00:00:00Z", 500, Some(20), Some(30), None).unwrap();
    assert_all_user_state(&db, &conn, "a");
    assert_eq!(db.get_asset_detail("a").unwrap().unwrap().size, 500);
}

#[test]
fn scan_consumers_read_v2_assets_with_user_state() {
    let (dir, db) = test_db("v2-reader");
    db.upsert_file_facts(&[fact("a", r"d:\assets\a.png", 100, 10)]).unwrap();
    set_all_user_state(&db, &connection(&dir), "a");
    let assets = db.get_all_assets().unwrap();
    assert_eq!(assets.len(), 1);
    assert_eq!(assets[0].rating, 5);
    assert!(assets[0].favorite);
    assert_eq!(assets[0].tags, ["tag"]);
    assert_eq!(assets[0].collections, ["collection"]);
}

#[test]
fn watcher_lookup_uses_normalized_v2_identity() {
    let (_dir, db) = test_db("v2-lookup");
    db.upsert_file_facts(&[fact("a", r"d:\assets\a.png", 100, 10)]).unwrap();
    assert_eq!(db.get_asset_by_path(" D:/ASSETS/A.PNG/ ").unwrap().unwrap().id, "a");
}

#[test]
fn reconciliation_signature_reader_uses_v2_timestamps() {
    let (_dir, db) = test_db("v2-signatures");
    db.upsert_file_facts(&[fact("a", r"d:\assets\a.png", 100, 10)]).unwrap();
    let signatures = db.get_asset_signatures_under("D:/ASSETS/").unwrap();
    assert_eq!(signatures.len(), 1);
    assert_eq!(signatures[0].2, "1970-01-01T00:00:00.000000010+00:00");
}

#[test]
fn fts_search_reads_v2_asset_projection() {
    let (_dir, db) = test_db("v2-search");
    db.upsert_file_facts(&[fact("a", r"d:\assets\needle.png", 100, 10)]).unwrap();
    assert_eq!(db.search_assets("needle", 10).unwrap().len(), 1);
}

#[test]
fn v2_initializer_rejects_other_filenames_before_touching_them() {
    let dir = TestDir::new("reject-filename");
    let path = dir.join("other.db");
    assert!(Database::init_v2_at(&path).is_err());
    assert!(!path.exists());
}

#[test]
fn canonical_windows_roots_preserve_absolute_identity() {
    use crate::database::normalize_windows_path;
    assert_eq!(normalize_windows_path(" C:/ "), "c:\\");
    assert_eq!(normalize_windows_path(r"C:\"), "c:\\");
    assert_ne!(normalize_windows_path("C:"), normalize_windows_path("C:/"));
    assert_eq!(normalize_windows_path(" //SERVER/Share/ "), r"\\server\share");
    assert_eq!(normalize_windows_path("/"), "\\");
    assert!(crate::sync::is_path_under("C:/assets/a.png", "c:/"));
    assert!(!crate::sync::is_path_under("C:/assets-other/a.png", "c:/assets"));
}

#[test]
fn fact_revision_failure_rolls_back_entire_scan_batch() {
    let (dir, db) = test_db("fact-revision");
    let conn = connection(&dir);
    conn.execute_batch("CREATE TRIGGER fail_revision BEFORE UPDATE ON app_meta WHEN old.key='revision' BEGIN SELECT RAISE(ABORT,'injected revision failure'); END;").unwrap();
    let root = folder("root", "D:/Assets");
    assert!(db.batch_save_scan_results(&root, &[], &[scan_asset("a", "root", "D:/Assets/a.png")]).is_err());
    assert_eq!(db.asset_count().unwrap(), 0);
    assert_eq!(number(&conn, "SELECT count(*) FROM folders"), 0);
    assert_eq!(number(&conn, "SELECT CAST(value AS INTEGER) FROM app_meta WHERE key='revision'"), 0);
}

#[test]
fn filesystem_removal_preserves_user_state_for_rediscovery() {
    let (dir, db) = test_db("filesystem-removal");
    let conn = connection(&dir);
    let original = fact("a", r"d:\assets\a.png", 100, 10);
    db.upsert_file_facts(&[original.clone()]).unwrap();
    set_all_user_state(&db, &conn, "a");
    assert_eq!(db.delete_assets_by_paths(&[" D:/ASSETS/A.PNG/ ".into()]).unwrap(), 1);
    assert_eq!(number(&conn, "SELECT count(*) FROM assets"), 1);
    assert_eq!(number(&conn, "SELECT count(*) FROM asset_user_state WHERE rating=5"), 1);
    assert!(db.get_asset_by_path(&original.path).unwrap().is_none());
    db.upsert_file_facts(&[original.clone()]).unwrap();
    assert_all_user_state(&db, &conn, "a");
    assert_eq!(db.delete_assets_by_ids(&["a".into()]).unwrap(), 1);
    assert_eq!(number(&conn, "SELECT count(*) FROM assets"), 1);
    db.upsert_file_facts(&[original]).unwrap();
    assert_all_user_state(&db, &conn, "a");
    // A sibling path must never match the removal prefix.
    db.upsert_file_facts(&[fact("sibling", r"d:\assets-other\a.png", 100, 10)]).unwrap();
    assert_eq!(db.delete_assets_by_prefix(" D:/ASSETS/ ").unwrap(), 1);
    assert_eq!(number(&conn, "SELECT count(*) FROM assets"), 2);
    assert!(db.get_asset_detail("sibling").unwrap().is_some());
    assert_eq!(number(&conn, "SELECT count(*) FROM asset_tags"), 1);
}

#[test]
fn startup_validation_does_not_prune_unseen_assets_without_a_completed_scan() {
    let (_dir, db) = test_db("validation");
    db.upsert_file_facts(&[fact("unseen", r"z:\offline-test-root\unseen.png", 100, 10)]).unwrap();
    assert_eq!(db.validate_assets().unwrap(), (1, 0));
    assert!(db.get_asset_detail("unseen").unwrap().is_some());
}

#[test]
fn disappearing_file_fails_incremental_scan_without_pruning_cached_rows() {
    let (dir, db) = test_db("disappearing-file");
    let root = dir.join("input");
    std::fs::create_dir_all(&root).unwrap();
    let path = root.join("disappearing.txt");
    std::fs::write(&path, b"fixture").unwrap();
    let root_str = root.to_str().unwrap();
    let scan = crate::indexer::scan_local_directory(root_str).unwrap();
    db.batch_save_scan_results(&scan.root_folder, &scan.sub_folders, &scan.assets).unwrap();
    let result = crate::indexer::scan_local_directory_incremental(root_str,
        &mut |_, _, _| { std::fs::remove_file(&path).unwrap(); Ok(()) },
        &mut |assets, _, _| db.batch_save_assets(assets));
    assert!(result.is_err(), "a missing discovered file must fail the scan");
    assert_eq!(db.get_all_assets().unwrap().len(), 1);
}

#[test]
fn thumbnail_command_does_not_write_removed_asset_columns() {
    assert!(!include_str!("database.rs").contains("UPDATE assets SET thumbnail_url"),
        "the V2 schema does not persist the old thumbnail URL column");
    assert!(!include_str!("commands.rs").contains("db.update_asset_thumbnail_url"));
}

#[test]
fn reconciliation_read_failure_preserves_unseen_rows() {
    let (dir, db) = test_db("reconcile-read-failure");
    let root = dir.join("input");
    std::fs::create_dir_all(&root).unwrap();
    let disappearing = root.join("disappearing.txt");
    std::fs::write(&disappearing, b"fixture").unwrap();
    let scan = crate::indexer::scan_local_directory(root.to_str().unwrap()).unwrap();
    db.batch_save_scan_results(&scan.root_folder, &scan.sub_folders, &scan.assets).unwrap();
    db.upsert_file_facts(&[fact("unseen", root.join("unseen.png").to_str().unwrap(), 100, 10)]).unwrap();
    connection(&dir).execute("UPDATE assets SET mtime_ns=0 WHERE id=?1", [&scan.assets[0].id]).unwrap();
    let result = crate::sync::reconcile_with_events(&db, &root, &|event, _| {
        // The directory event occurs after traversal and before file metadata refresh.
        if event == "folder:updated" {
            std::fs::remove_file(&disappearing).unwrap();
        }
    });
    assert!(result.is_err(), "a discovered file disappearing must fail reconciliation");
    assert!(db.get_asset_detail("unseen").unwrap().is_some());
    assert_eq!(db.asset_count().unwrap(), 2);
}

#[test]
fn reconciliation_cleanup_error_is_propagated() {
    let (dir, db) = test_db("reconcile-cleanup-error");
    let root = dir.join("input");
    std::fs::create_dir_all(&root).unwrap();
    db.upsert_file_facts(&[fact("unseen", root.join("unseen.png").to_str().unwrap(), 100, 10)]).unwrap();
    let conn = connection(&dir);
    conn.execute_batch("CREATE TRIGGER fail_cleanup BEFORE UPDATE OF deleted_at ON assets
        WHEN new.deleted_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'injected cleanup failure'); END;").unwrap();
    let events = std::cell::RefCell::new(Vec::new());
    let result = crate::sync::reconcile_with_events(&db, &root, &|event, _| events.borrow_mut().push(event.to_string()));
    assert!(result.unwrap_err().contains("injected cleanup failure"));
    assert!(db.get_asset_detail("unseen").unwrap().is_some());
    assert!(!events.borrow().iter().any(|event| event.ends_with(":removed")));
}

#[test]
fn reconciliation_cleanup_failure_rolls_back_folder_and_asset_removals() {
    let (dir, db) = test_db("reconcile-cleanup-rollback");
    let root = dir.join("input");
    std::fs::create_dir_all(&root).unwrap();
    let missing = root.join("missing");
    db.insert_folder(&folder("missing", missing.to_str().unwrap())).unwrap();
    let mut unseen = fact("unseen", missing.join("unseen.png").to_str().unwrap(), 100, 10);
    unseen.folder_id = Some("missing".into());
    db.upsert_file_facts(&[unseen]).unwrap();
    let conn = connection(&dir);
    set_all_user_state(&db, &conn, "unseen");
    conn.execute_batch("CREATE TRIGGER fail_cleanup BEFORE UPDATE OF deleted_at ON assets
        WHEN new.deleted_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'injected cleanup failure'); END;").unwrap();
    let result = crate::sync::reconcile_with_events(&db, &root, &|_, _| {});
    assert!(result.is_err());
    assert_eq!(number(&conn, "SELECT count(*) FROM folders WHERE id='missing'"), 1);
    assert_all_user_state(&db, &conn, "unseen");
    let folder_id: String = conn.query_row("SELECT folder_id FROM assets WHERE id='unseen'", [], |row| row.get(0)).unwrap();
    assert_eq!(folder_id, "missing");
}

#[test]
fn reconciliation_folder_read_errors_are_not_silently_skipped() {
    let (dir, db) = test_db("reconcile-folder-read");
    db.insert_folder(&folder("root", r"d:\assets")).unwrap();
    connection(&dir).execute("UPDATE folders SET mtime_ns='invalid'", []).unwrap();
    assert!(db.get_folders().is_err());
    assert!(db.get_monitored_folders().is_err());
}

#[test]
fn reconciliation_signature_read_errors_are_not_silently_skipped() {
    let (dir, db) = test_db("reconcile-signature-read");
    db.upsert_file_facts(&[fact("a", r"d:\assets\a.png", 100, 10)]).unwrap();
    connection(&dir).execute("UPDATE assets SET mtime_ns='invalid'", []).unwrap();
    assert!(db.get_asset_signatures_under(r"d:\assets").is_err());
}

#[test]
fn normal_startup_never_schedules_automatic_full_filesystem_work() {
    let startup = include_str!("main.rs");
    assert!(
        !startup.contains("Duration::from_secs(5)"),
        "startup must not schedule periodic whole-root reconciliation"
    );
    assert!(
        !startup.contains("validate_db.validate_assets()"),
        "startup must not validate every cached asset"
    );
    assert!(
        !startup.contains("WindowEvent::Focused(true)"),
        "window focus must not trigger filesystem reconciliation"
    );
}

#[test]
fn streaming_scan_emits_bounded_batches_without_returning_a_snapshot() {
    use crate::indexer::{scan_local_directory_streaming, ScanBatch, SCAN_BATCH_SIZE};
    use std::sync::atomic::AtomicBool;

    let dir = TestDir::new("streaming-scan");
    let root = dir.join("input");
    std::fs::create_dir_all(root.join("nested")).unwrap();
    for index in 0..(SCAN_BATCH_SIZE + 17) {
        std::fs::write(root.join("nested").join(format!("asset-{index}.txt")), b"x").unwrap();
    }

    let cancelled = AtomicBool::new(false);
    let mut asset_count = 0usize;
    let mut folder_count = 0usize;
    let summary = scan_local_directory_streaming(
        root.to_str().unwrap(),
        &cancelled,
        &mut |batch| {
            match batch {
                ScanBatch::Folders(items) => {
                    assert!(!items.is_empty());
                    assert!(items.len() <= SCAN_BATCH_SIZE);
                    folder_count += items.len();
                }
                ScanBatch::Assets(items) => {
                    assert!(!items.is_empty());
                    assert!(items.len() <= SCAN_BATCH_SIZE);
                    asset_count += items.len();
                }
                _ => {}
            }
            Ok(())
        },
    ).unwrap();

    assert_eq!(folder_count, 1);
    assert_eq!(asset_count, SCAN_BATCH_SIZE + 17);
    assert_eq!(summary.total_files_scanned, asset_count);
}

#[test]
fn streaming_scan_cancellation_stops_before_completion_event() {
    use crate::indexer::{scan_local_directory_streaming, ScanBatch};
    use std::sync::atomic::{AtomicBool, Ordering};

    let dir = TestDir::new("cancel-streaming-scan");
    let root = dir.join("input");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("asset.txt"), b"x").unwrap();

    let cancelled = AtomicBool::new(false);
    let mut completed = false;
    let error = scan_local_directory_streaming(
        root.to_str().unwrap(),
        &cancelled,
        &mut |batch| {
            if matches!(batch, ScanBatch::Started(_)) {
                cancelled.store(true, Ordering::Release);
            }
            if matches!(batch, ScanBatch::Finished(_)) {
                completed = true;
            }
            Ok(())
        },
    ).unwrap_err();

    assert!(error.contains("cancel"));
    assert!(!completed);
}

#[test]
fn background_scan_command_uses_compact_streaming_events() {
    let commands = include_str!("commands.rs");
    assert!(commands.contains("scan_local_directory_streaming"));
    let start = commands.find("pub async fn start_scan_directory").unwrap();
    let end = commands[start..].find("/// Explicit, cancellable full-root recovery.").unwrap() + start;
    let implementation = &commands[start..end];
    assert!(!implementation.contains("\"assets\":"), "scan events must invalidate queries instead of sending asset objects");
    assert!(!implementation.contains("sub_folders"), "scan events must not send the complete folder tree");
}

#[test]
fn index_coordinator_is_single_flight_per_root() {
    use crate::index_jobs::IndexCoordinator;
    use std::sync::mpsc::sync_channel;

    let coordinator = IndexCoordinator::new(1, 4);
    let (release_tx, release_rx) = sync_channel(0);
    let first = coordinator.start("root-a", move |_| {
        release_rx.recv().map_err(|error| error.to_string())?;
        Ok(())
    }).unwrap();
    let second = coordinator.start("root-a", |_| panic!("duplicate job must not run")).unwrap();

    assert_eq!(first, second);
    assert_eq!(coordinator.active_job_count(), 1);
    release_tx.send(()).unwrap();
    assert!(coordinator.wait(&first, Duration::from_secs(2)).unwrap().is_terminal());
}

#[test]
fn index_coordinator_cancels_a_running_job() {
    use crate::index_jobs::{IndexCoordinator, JobStatus};

    let coordinator = IndexCoordinator::new(1, 4);
    let job_id = coordinator.start("root-cancel", |cancelled| {
        while !cancelled.load(std::sync::atomic::Ordering::Acquire) {
            std::thread::yield_now();
        }
        Err("scan cancelled".to_string())
    }).unwrap();

    assert!(coordinator.cancel(&job_id));
    let snapshot = coordinator.wait(&job_id, Duration::from_secs(2)).unwrap();
    assert_eq!(snapshot.status, JobStatus::Cancelled);
    assert_eq!(coordinator.active_job_count(), 0);
}

#[test]
fn desktop_scan_commands_are_backed_by_the_shared_coordinator() {
    let commands = include_str!("commands.rs");
    let main = include_str!("main.rs");
    assert!(commands.contains("coordinator: State<'_, IndexCoordinator>"));
    assert!(commands.contains("pub fn cancel_job_v2"));
    assert!(commands.contains("pub fn get_job_status_v2"));
    assert!(main.contains("IndexCoordinator::new("));
    assert!(main.contains("manage(index_coordinator)"));
    assert!(main.contains("cancel_job_v2,"));
    assert!(main.contains("get_job_status_v2,"));
}

#[test]
fn file_event_coalescer_collapses_bursts_by_path() {
    use crate::event_coalescer::{ChangeKind, EventCoalescer, RawFsEvent};

    let now = Instant::now();
    let mut coalescer = EventCoalescer::new(16, Duration::from_millis(50));
    coalescer.push(RawFsEvent::file("root", r"D:\assets\a.png", ChangeKind::Create, now));
    coalescer.push(RawFsEvent::file("root", r"d:/assets/a.png", ChangeKind::Modify, now));
    coalescer.push(RawFsEvent::file("root", r"D:\assets\b.png", ChangeKind::Create, now));
    coalescer.push(RawFsEvent::file("root", r"D:\assets\b.png", ChangeKind::Remove, now));

    let changes = coalescer.drain_ready(now + Duration::from_millis(51));
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].kind, ChangeKind::Create);
    assert!(changes[0].normalized_path.ends_with(r"assets\a.png"));
}

#[test]
fn file_event_coalescer_handles_replacement_and_directory_dominance() {
    use crate::event_coalescer::{ChangeKind, EventCoalescer, RawFsEvent};

    let now = Instant::now();
    let mut coalescer = EventCoalescer::new(16, Duration::ZERO);
    coalescer.push(RawFsEvent::file("root", r"D:\assets\a.png", ChangeKind::Remove, now));
    coalescer.push(RawFsEvent::file("root", r"D:\assets\a.png", ChangeKind::Create, now));
    coalescer.push(RawFsEvent::file("root", r"D:\assets\folder\child.png", ChangeKind::Modify, now));
    coalescer.push(RawFsEvent::directory("root", r"D:\assets\folder", ChangeKind::Remove, now));

    let changes = coalescer.drain_ready(now);
    assert_eq!(changes.len(), 2);
    assert!(changes.iter().any(|change| change.kind == ChangeKind::Replace));
    let directory = changes.iter().find(|change| change.is_directory).unwrap();
    assert_eq!(directory.kind, ChangeKind::Remove);
    assert!(!changes.iter().any(|change| change.normalized_path.ends_with("child.png")));
}

#[test]
fn file_event_coalescer_marks_root_dirty_on_capacity_overflow() {
    use crate::event_coalescer::{ChangeKind, EventCoalescer, RawFsEvent};

    let now = Instant::now();
    let mut coalescer = EventCoalescer::new(1, Duration::ZERO);
    assert!(coalescer.push(RawFsEvent::file("root", "a", ChangeKind::Modify, now)));
    assert!(!coalescer.push(RawFsEvent::file("root", "b", ChangeKind::Modify, now)));
    assert!(coalescer.is_root_dirty("root"));
}

#[test]
fn watcher_uses_a_bounded_queue_and_never_reconciles_a_whole_root() {
    let watcher = include_str!("watcher.rs");
    assert!(watcher.contains("sync_channel::<Result<Event, notify::Error>>(8_192)"));
    assert!(watcher.contains("try_send"));
    assert!(watcher.contains("EventCoalescer"));
    assert!(!watcher.contains("reconcile_root"));
    assert!(!watcher.contains("trigger_reconcile"));
}

#[test]
fn watcher_folder_lookup_is_an_indexed_single_path_query() {
    let (dir, db) = test_db("watcher-folder-lookup");
    db.insert_folder(&folder("folder-a", r"D:\assets\nested")).unwrap();
    let found = db.get_folder_by_path(r"d:/ASSETS/nested/").unwrap().unwrap();
    assert_eq!(found.id, "folder-a");
    let plan = connection(&dir)
        .prepare("EXPLAIN QUERY PLAN SELECT id FROM folders WHERE normalized_path=?1")
        .unwrap()
        .query_row([crate::database::normalize_windows_path(r"D:\assets\nested")], |row| row.get::<_, String>(3))
        .unwrap();
    assert!(plan.contains("normalized_path"));

    let watcher = include_str!("watcher.rs");
    let start = watcher.find("fn flush_events").unwrap();
    let end = watcher[start..].find("fn remove_folder_tree").unwrap() + start;
    assert!(!watcher[start..end].contains("get_folders()"));
}

#[test]
fn watcher_directory_create_uses_bounded_subtree_scan() {
    let watcher = include_str!("watcher.rs");
    assert!(watcher.contains("IndexCoordinator"));
    assert!(watcher.contains("scan_local_subtree_streaming"));
    assert!(watcher.contains("coordinator.start("));
}

#[test]
fn subtree_scan_does_not_register_the_subdirectory_as_a_monitored_root() {
    use crate::indexer::{scan_local_subtree_streaming, ScanBatch};
    use std::sync::atomic::AtomicBool;

    let dir = TestDir::new("subtree-scan");
    let root = dir.join("subtree");
    std::fs::create_dir_all(&root).unwrap();
    let mut started = None;
    scan_local_subtree_streaming(root.to_str().unwrap(), &AtomicBool::new(false), &mut |batch| {
        if let ScanBatch::Started(folder) = batch {
            started = Some(folder);
        }
        Ok(())
    }).unwrap();
    let folder = started.unwrap();
    assert!(!folder.is_monitored);
    assert!(folder.id.starts_with("f_"));
    assert!(!folder.id.starts_with("f_root_"));
}

#[test]
fn generic_whole_file_base64_command_is_not_registered() {
    let main = include_str!("main.rs");
    assert!(!main.contains("read_file_base64,"));
}

#[test]
fn thumbnail_cache_key_changes_with_source_version() {
    let dir = TestDir::new("thumbnail-version");
    let source = dir.join("source.png");
    std::fs::write(&source, b"one").unwrap();
    let first = crate::thumbnail_cache::get_cache_file_path(&source, 256, &dir.0).unwrap();
    std::fs::write(&source, b"a longer source version").unwrap();
    let second = crate::thumbnail_cache::get_cache_file_path(&source, 256, &dir.0).unwrap();
    assert_ne!(first, second);
}

#[test]
fn thumbnail_decoder_rejects_excessive_declared_pixels() {
    assert!(crate::thumbnail_cache::validate_image_dimensions(10_000, 10_000).is_ok());
    assert!(crate::thumbnail_cache::validate_image_dimensions(10_001, 10_000).is_err());
}

#[test]
fn thumbnail_queue_refuses_work_above_its_hard_limit() {
    let coordinator = crate::thumbnail_jobs::ThumbnailCoordinator::new(2, 512);
    let reservations = (0..512)
        .map(|_| coordinator.reserve().expect("within thumbnail queue capacity"))
        .collect::<Vec<_>>();
    assert!(coordinator.reserve().is_err());
    assert_eq!(coordinator.queued(), 512);
    drop(reservations);
    assert_eq!(coordinator.queued(), 0);
}

#[test]
fn completed_scan_generation_prunes_only_unseen_file_facts_and_preserves_user_state() {
    let (dir, db) = test_db("scan-generation");
    let root = folder("root", r"D:\assets");
    let first = db.begin_root_scan(&root).unwrap();
    let a = fact("a", r"D:\assets\a.png", 100, 10);
    let b = fact("b", r"D:\assets\b.png", 100, 10);
    db.upsert_scan_file_facts(&root.id, first, &[a.clone(), b.clone()]).unwrap();
    db.complete_root_scan(&root.id, first).unwrap();
    db.patch_user_state(&AssetUserPatch::rating("a", 5)).unwrap();

    let second = db.begin_root_scan(&root).unwrap();
    db.upsert_scan_file_facts(&root.id, second, &[b]).unwrap();
    let removed = db.complete_root_scan(&root.id, second).unwrap();
    assert_eq!(removed, 1);
    assert!(db.get_asset_detail("a").unwrap().is_none());
    assert_eq!(number(&connection(&dir), "SELECT count(*) FROM asset_user_state WHERE asset_id='a' AND rating=5"), 1);
}

#[test]
fn unfinished_scan_generation_never_prunes_cached_rows() {
    let (_dir, db) = test_db("scan-generation-cancel");
    let root = folder("root", r"D:\assets");
    let first = db.begin_root_scan(&root).unwrap();
    db.upsert_scan_file_facts(&root.id, first, &[fact("a", r"D:\assets\a.png", 100, 10)]).unwrap();
    db.complete_root_scan(&root.id, first).unwrap();

    let _interrupted = db.begin_root_scan(&root).unwrap();
    assert!(db.get_asset_detail("a").unwrap().is_some());
}

#[test]
fn scan_generation_tracks_folder_batches_and_prunes_stale_folders_on_completion() {
    let (dir, db) = test_db("scan-folder-generation");
    let root = folder("root", r"D:\assets");
    let child = folder("child", r"D:\assets\child");
    let first = db.begin_root_scan(&root).unwrap();
    db.upsert_scan_folders(&root.id, first, &[child]).unwrap();
    db.complete_root_scan(&root.id, first).unwrap();
    assert_eq!(number(&connection(&dir), "SELECT count(*) FROM folders WHERE id='child'"), 1);

    let second = db.begin_root_scan(&root).unwrap();
    db.complete_root_scan(&root.id, second).unwrap();
    assert_eq!(number(&connection(&dir), "SELECT count(*) FROM folders WHERE id='child'"), 0);
}

#[test]
fn full_scan_command_uses_generation_aware_writes_exclusively() {
    let commands = include_str!("commands.rs");
    let start = commands.find("pub async fn start_scan_directory").unwrap();
    let end = commands[start..].find("pub fn cancel_job_v2").unwrap() + start;
    let implementation = &commands[start..end];
    assert!(implementation.contains("begin_root_scan"));
    assert!(implementation.contains("upsert_scan_folders"));
    assert!(implementation.contains("upsert_scan_assets"));
    assert!(implementation.contains("complete_root_scan"));
    assert!(!implementation.contains("batch_save_scan_results"));
    assert!(!implementation.contains("batch_save_assets"));
}

#[test]
fn pipeline_metrics_aggregate_and_reset_without_per_file_payloads() {
    let metrics = crate::metrics::PipelineMetrics::default();
    metrics.record_query(Duration::from_micros(100), true);
    metrics.record_query(Duration::from_micros(300), false);
    metrics.record_watcher_drop();
    let snapshot = metrics.snapshot(2, 3, 4, 5);
    assert_eq!(snapshot.query_count, 2);
    assert_eq!(snapshot.average_query_micros, 200);
    assert_eq!(snapshot.error_count, 1);
    assert_eq!(snapshot.watcher_dropped_events, 1);
    assert_eq!((snapshot.active_index_jobs, snapshot.database_writes, snapshot.thumbnail_requests, snapshot.asset_count), (2, 3, 4, 5));
    metrics.reset_counters();
    assert_eq!(metrics.snapshot(0, 0, 0, 0).query_count, 0);
}

#[test]
fn diagnostics_are_registered_and_scale_fixture_has_path_guards() {
    let main = include_str!("main.rs");
    let script = include_str!("../../scripts/generate-scale-fixture.ps1");
    assert!(main.contains("get_diagnostics_v2,"));
    assert!(script.contains("$target -eq $root"));
    assert!(script.contains("$target -eq $profile"));
    assert!(script.contains("-not $AllowNonEmpty"));
    assert!(script.contains("SetLength($SparseLargeFileBytes)"));
}

#[test]
fn legacy_full_snapshot_and_automatic_maintenance_commands_are_not_registered() {
    let main = include_str!("main.rs");
    for command in ["load_workspace,", "scan_directory,", "validate_assets,", "reconcile_monitored_folders,", "aggregate_data,", "filter_by_smart_folder,"] {
        assert!(!main.lines().any(|line| line.trim() == command), "legacy runtime command still registered: {command}");
    }
    assert!(!main.lines().any(|line| line.trim() == "search_assets,"));
}

#[test]
fn asset_mutations_are_idempotent_and_reject_stale_versions() {
    use crate::models::{AssetMutation, AssetMutationPatch};
    let (_dir, db) = test_db("mutation-idempotency");
    db.upsert_file_facts(&[fact("a", r"d:\assets\a.png", 100, 10)]).unwrap();
    let command = AssetMutation {
        operation_id: "operation-1".into(),
        ids: vec!["a".into()],
        selection: None,
        expected_version: Some(1),
        patch: AssetMutationPatch { rating: Some(4), favorite: Some(true), color: None },
    };
    let first = db.mutate_assets(&command).unwrap();
    let duplicate = db.mutate_assets(&command).unwrap();
    assert_eq!(first, duplicate);
    let detail = db.get_asset_detail("a").unwrap().unwrap();
    assert_eq!((detail.rating, detail.favorite, detail.record_version), (4, true, 2));

    let stale = AssetMutation { operation_id: "operation-2".into(), expected_version: Some(1), ..command };
    assert!(db.mutate_assets(&stale).unwrap_err().contains("conflict"));
}

#[test]
fn asset_mutation_rejects_unbounded_explicit_id_lists() {
    use crate::models::{AssetMutation, AssetMutationPatch};
    let (_dir, db) = test_db("mutation-limit");
    let command = AssetMutation {
        operation_id: "too-many".into(),
        ids: (0..1001).map(|value| value.to_string()).collect(),
        selection: None,
        expected_version: None,
        patch: AssetMutationPatch::default(),
    };
    assert!(db.mutate_assets(&command).is_err());
}

#[test]
fn v2_mutation_command_is_registered() {
    let main = include_str!("main.rs");
    let desktop = include_str!("../../src/services/api/providers/desktop.ts");
    assert!(main.contains("mutate_assets_v2,"));
    assert!(main.contains("start_integrity_job_v2,"));
    assert!(main.contains("read_asset_range_v2,"));
    assert!(desktop.contains("'mutate_assets_v2'"));
    assert!(!desktop.contains("'set_asset_rating'"));
    assert!(!desktop.contains("'set_asset_favorite'"));
}

#[test]
fn query_selection_mutates_matching_assets_without_materializing_ids_in_the_ui() {
    use crate::models::{AssetMutation, AssetMutationPatch, AssetQuery, SelectionExpression};
    let (_dir, db) = test_db("mutation-selection");
    let mut image_a = fact("a", r"d:\assets\a.png", 100, 10);
    image_a.asset_type = "image".into();
    let mut image_b = fact("b", r"d:\assets\b.png", 100, 10);
    image_b.asset_type = "image".into();
    let mut document = fact("c", r"d:\assets\c.pdf", 100, 10);
    document.asset_type = "document".into();
    db.upsert_file_facts(&[image_a, image_b, document]).unwrap();
    let mutation = AssetMutation {
        operation_id: "query-operation".into(),
        ids: vec![],
        selection: Some(SelectionExpression {
            query: AssetQuery { types: vec!["image".into()], ..AssetQuery::default() },
            excluded_ids: vec!["b".into()],
        }),
        expected_version: None,
        patch: AssetMutationPatch { rating: Some(5), ..AssetMutationPatch::default() },
    };
    assert_eq!(db.mutate_assets(&mutation).unwrap().affected, 1);
    assert_eq!(db.get_asset_detail("a").unwrap().unwrap().rating, 5);
    assert_eq!(db.get_asset_detail("b").unwrap().unwrap().rating, 0);
    assert_eq!(db.get_asset_detail("c").unwrap().unwrap().rating, 0);
}
