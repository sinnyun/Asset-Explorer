use crate::database::{Database, V2_DATABASE_FILE};
use crate::models::{Asset, AssetUserPatch, FileFact, Folder};
use rusqlite::{params, Connection};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

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
