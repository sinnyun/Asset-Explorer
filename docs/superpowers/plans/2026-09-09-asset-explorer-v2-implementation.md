# Asset Explorer V2 Clean-Slate Scalability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the full-snapshot desktop architecture with a clean V2 SQLite database, paged queries, bounded indexing/monitoring/thumbnail work, and viewport-sized React rendering that remains stable at one million files and 50GB individual files.

**Architecture:** The Rust backend owns an empty-on-first-run `assethub-v2.db`, exposes cursor-based query and explicit mutation commands, and processes filesystem work through bounded single-flight coordinators. React keeps only workspace summaries and bounded query pages, while virtualized views request thumbnails and details only for visible assets.

**Tech Stack:** Rust 2021, Tauri 2, rusqlite/SQLite WAL, parking_lot, notify, ignore, React 19, TypeScript 5.8, Vite 6, Node built-in test runner with tsx.

## Global Constraints

- V2 starts from a new `assethub-v2.db`; do not migrate or delete `assethub.db`.
- Do not keep the old full-workspace asset API as a runtime compatibility path.
- The frontend must never retain the complete asset table.
- No queue, worker pool, thumbnail cache, IPC page, or file read may be unbounded.
- No indexing path may read a complete large file unless the user explicitly starts a full-hash operation.
- Filesystem refreshes must never overwrite rating, favorite, color, tags, collections, notes, or custom names.
- One monitored root may have at most one active scan/reconcile job.
- Root deletion cleanup runs only after a successful online scan generation.
- Target platform is Windows 10/11, 4–8 CPU cores, 16GB RAM, SSD.
- Target scale is 1,000,000 assets, 100,000 folders, and 50GB individual files.

---

## File Structure

### Rust backend

- `src-tauri/src/database.rs`: V2 database facade, schema creation, read pool, write actor, existing entity persistence during transition.
- `src-tauri/src/models.rs`: query, page, mutation, job, invalidation, and compact asset DTO types.
- `src-tauri/src/asset_query.rs`: cursor encoding/decoding, SQL filter builder, paged asset/folder/detail reads.
- `src-tauri/src/index_jobs.rs`: bounded scan coordinator, job state, cancellation, scan generation, streaming batches.
- `src-tauri/src/watcher.rs`: event-only collector and root registry; delegates coalesced work to coordinator.
- `src-tauri/src/sync.rs`: targeted path reconciliation and explicit recovery scan; no automatic whole-root loop.
- `src-tauri/src/thumbnail_cache.rs`: versioned keys, bounded generation coordinator, image safety limits.
- `src-tauri/src/commands.rs`: V2 Tauri query/mutation/job/preview commands.
- `src-tauri/src/main.rs`: startup wiring without validation or periodic Deep reconciliation.

### React frontend

- `src/types.ts`: V2 query/page/job/selection types.
- `src/services/api/types.ts`: provider contract for shell, pages, details, mutations, jobs.
- `src/services/api/providers/desktop.ts`: Tauri V2 command adapter.
- `src/services/api/providers/web.ts`: REST V2 contract adapter.
- `src/services/dataService.ts`: unified V2 service without empty-data fallbacks.
- `src/hooks/useAssetQuery.ts`: bounded page cache, request cancellation, invalidation.
- `src/hooks/useAppState.ts`: workspace summaries and UI preferences only.
- `src/hooks/useFileMonitoring.ts`: compact invalidation and job event handling.
- `src/hooks/useEntityActions.ts`: command-based mutations with rollback.
- `src/hooks/useMiscActions.ts`: query-selection batch mutations.
- `src/components/MainArea.tsx`: query-driven virtual grid/list and explicit loading/error/empty states.
- `src/components/MonitoredSplitView.tsx`: independent paged query per column.
- `src/components/ThumbnailImage.tsx`: viewport request/cancel and bounded object URL cache.
- `src/utils/assetPreviewSource.ts`: streaming URL only; no generic Base64 asset reads.

### Tests and benchmarks

- `src-tauri/src/database_v2_tests.rs`: schema, user-state preservation, paging, scan-generation tests.
- `src-tauri/src/event_coalescer.rs`: pure event merge logic plus unit tests.
- `tests/asset-query.test.ts`: frontend cursor/cache/selection tests using Node test runner.
- `scripts/generate-scale-fixture.ps1`: optional sparse and metadata fixture generator with explicit destination.

---

### Task 1: Establish V2 test harness and database identity

**Files:**
- Modify: `package.json`
- Modify: `src-tauri/src/main.rs`
- Modify: `src-tauri/src/database.rs`
- Create: `src-tauri/src/database_v2_tests.rs`

**Interfaces:**
- Produces: `Database::init_v2() -> Result<Database, String>`
- Produces: `Database::init_v2_at(path: &Path) -> Result<Database, String>` for isolated tests.
- Produces: database filename constant `V2_DATABASE_FILE: &str = "assethub-v2.db"`.

- [ ] **Step 1: Add deterministic test commands**

Add scripts:

```json
"test:ts": "node --import tsx --test tests/**/*.test.ts",
"test:rust": "cargo test --manifest-path src-tauri/Cargo.toml"
```

- [ ] **Step 2: Write failing V2 filename and empty-schema test**

```rust
#[test]
fn v2_database_uses_distinct_file_and_starts_empty() {
    let dir = temp_test_dir("empty");
    let db = Database::init_v2_at(&dir.join(V2_DATABASE_FILE)).unwrap();
    assert_eq!(db.asset_count().unwrap(), 0);
    assert!(!dir.join("assethub.db").exists());
}
```

- [ ] **Step 3: Run the focused test and confirm it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml v2_database_uses_distinct_file_and_starts_empty`

Expected: failure because `init_v2_at` and `V2_DATABASE_FILE` do not exist.

- [ ] **Step 4: Implement the V2 initializer**

Use `%LOCALAPPDATA%/AssetHub/assethub-v2.db`, create its parent directory, and never inspect, rename, or delete `assethub.db`. `main.rs` must call `Database::init_v2()` directly; on failure show an initialization error rather than silently switching to an in-memory database.

- [ ] **Step 5: Run Rust tests and commit**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`

Expected: all tests pass.

Commit: `test: establish clean v2 database harness`

### Task 2: Create the final V2 schema and enforce field ownership

**Files:**
- Modify: `src-tauri/src/database.rs`
- Modify: `src-tauri/src/models.rs`
- Modify: `src-tauri/src/database_v2_tests.rs`

**Interfaces:**
- Produces: `Database::upsert_file_facts(batch: &[FileFact]) -> Result<usize, String>`.
- Produces: `Database::patch_user_state(command: &AssetUserPatch) -> Result<MutationSummary, String>`.
- Produces: `FileFact`, `AssetUserPatch`, `MutationSummary`.

- [ ] **Step 1: Write schema and preservation tests**

Test these invariants:

```rust
#[test]
fn rescanning_file_facts_preserves_user_state() {
    let db = test_db("preserve-user-state");
    db.upsert_file_facts(&[fact("a", 10, 100)]).unwrap();
    db.patch_user_state(&AssetUserPatch::rating("a", 5)).unwrap();
    db.upsert_file_facts(&[fact("a", 20, 200)]).unwrap();
    let detail = db.get_asset_detail("a").unwrap().unwrap();
    assert_eq!(detail.rating, 5);
    assert_eq!(detail.size, 200);
}
```

Also assert uniqueness of `normalized_path`, composite uniqueness of association tables, and that scan failure does not delete unseen rows.

- [ ] **Step 2: Verify tests fail against the current schema**

Run: `cargo test --manifest-path src-tauri/Cargo.toml database_v2_tests`

Expected: missing V2 models/methods or failed preservation assertion.

- [ ] **Step 3: Create schema in one transaction**

Create `roots`, `folders`, `assets`, `asset_user_state`, `tags`, `collections`, `asset_tags`, `asset_collections`, `smart_folders`, `scan_jobs`, `file_event_journal`, `asset_errors`, and `app_meta`. Add the indexes specified by the design, including `UNIQUE(normalized_path)` and cursor covering indexes.

- [ ] **Step 4: Split filesystem UPSERT from user mutations**

Filesystem SQL may update only:

```text
folder_id, path, normalized_path, name, extension, type, mime,
size, mtime_ns, volume_id, file_id, width, height,
metadata_status, last_seen_generation, record_version
```

It must not reference user-state columns or association tables.

- [ ] **Step 5: Run tests, inspect query plans, and commit**

Run: `cargo test --manifest-path src-tauri/Cargo.toml database_v2_tests`

Expected: all schema and preservation tests pass.

Commit: `feat: add v2 schema with protected user state`

### Task 3: Add bounded SQLite read pool and write actor

**Files:**
- Modify: `src-tauri/src/database.rs`
- Modify: `src-tauri/src/database_v2_tests.rs`

**Interfaces:**
- Produces: `Database::read<T>(&self, f: impl FnOnce(&Connection) -> DbResult<T>)`.
- Produces: `Database::write<T>(&self, f: impl FnOnce(&mut Connection) -> DbResult<T> + Send + 'static)`.
- Constraint: read pool maximum 4 connections; write queue capacity 256.

- [ ] **Step 1: Write concurrency and backpressure tests**

Tests must prove two reads can overlap while a write transaction is waiting, the write queue refuses or blocks producers at capacity, and a write closure can call no public method that reacquires the writer.

- [ ] **Step 2: Run tests and confirm the single mutex implementation fails the overlap assertion**

Run: `cargo test --manifest-path src-tauri/Cargo.toml database_concurrency`

- [ ] **Step 3: Implement `ReadPool`**

Use a `Mutex<ReadPoolState>` plus `Condvar`; state contains `idle: Vec<Connection>` and `open: usize`. Open at most four read-only connections and return each connection to the pool after the closure.

- [ ] **Step 4: Implement the bounded write actor**

Use `std::sync::mpsc::sync_channel(256)` and a dedicated named thread. A generic call wraps its typed result in a one-shot response channel. Transactions are created inside the actor and never include file I/O or event emission.

- [ ] **Step 5: Run tests and commit**

Commit: `refactor: isolate sqlite reads and bounded writes`

### Task 4: Implement cursor-based asset, folder, and detail queries

**Files:**
- Create: `src-tauri/src/asset_query.rs`
- Modify: `src-tauri/src/models.rs`
- Modify: `src-tauri/src/database.rs`
- Modify: `src-tauri/src/main.rs`
- Modify: `src-tauri/src/database_v2_tests.rs`

**Interfaces:**
- Produces: `Database::query_assets(&AssetQuery) -> Result<AssetPage, String>`.
- Produces: `Database::query_folders(&FolderQuery) -> Result<FolderPage, String>`.
- Produces: `Database::get_asset_details(&[String]) -> Result<Vec<AssetDetail>, String>`.
- Cursor: URL-safe encoding of `(sort_value, id)`, maximum page size 300.

- [ ] **Step 1: Write paging stability tests**

Seed duplicate names and duplicate mtimes. Assert page 1 and page 2 contain no duplicate IDs, order is deterministic, page size is clamped to 300, and an invalid cursor returns a typed error.

- [ ] **Step 2: Run focused tests and confirm failure**

- [ ] **Step 3: Implement a parameterized SQL builder**

Whitelist sort keys and filter operators. Search uses FTS5; folder descendants use normalized path bounds or a folder hierarchy query. Never concatenate user values into SQL.

- [ ] **Step 4: Verify indexes with `EXPLAIN QUERY PLAN` assertions**

At least name, mtime, size, favorite, tag, collection, and folder queries must report indexed search rather than full table scans for seeded data.

- [ ] **Step 5: Run tests and commit**

Commit: `feat: add indexed cursor asset queries`

### Task 5: Replace workspace and asset IPC with V2 contracts

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/main.rs`
- Modify: `src-tauri/src/models.rs`

**Interfaces:**
- Produces Tauri commands: `get_workspace_shell_v2`, `query_assets_v2`, `query_folders_v2`, `get_asset_details_v2`, `mutate_assets_v2`.
- Removes runtime use of: `load_workspace`, `aggregate_data`, `filter_by_smart_folder`, generic `read_file_base64`.

- [ ] **Step 1: Add serialization round-trip tests for every request and response DTO**

- [ ] **Step 2: Implement commands as thin adapters**

Each command validates maximum IDs/page size, delegates to `Database`, and returns typed `Result`. Commands must not swallow an error or convert it to empty data.

- [ ] **Step 3: Register only the new workspace/query commands needed by the migrated frontend**

- [ ] **Step 4: Run `cargo test` and `cargo check`**

Expected: no unused old command remains registered; all DTO tests pass.

- [ ] **Step 5: Commit**

Commit: `feat: expose v2 paged desktop api`

### Task 6: Build the bounded streaming scan coordinator

**Files:**
- Create: `src-tauri/src/index_jobs.rs`
- Modify: `src-tauri/src/indexer.rs`
- Modify: `src-tauri/src/database.rs`
- Modify: `src-tauri/src/models.rs`
- Modify: `src-tauri/src/main.rs`

**Interfaces:**
- Produces: `IndexCoordinator::start(root: RootId) -> Result<JobId, StartJobError>`.
- Produces: `IndexCoordinator::cancel(job: JobId)`.
- Produces: `IndexCoordinator::status(job: JobId) -> JobSnapshot`.
- Produces: `scan_stream(root, cancellation, sender)` with sender capacity 4,096.

- [ ] **Step 1: Write tests for single-flight, cancellation, and bounded batches**

Create a temporary tree, start the same root twice, and assert both calls return one active job. Assert cancellation leaves existing rows and does not execute generation cleanup.

- [ ] **Step 2: Verify tests fail**

- [ ] **Step 3: Implement discovery without collecting all paths**

Replace `Vec<PathBuf>` collection with a producer that sends `DiscoveredEntry` through a bounded channel. Metadata workers receive batches and the writer commits 200–1,000 rows or every 50ms.

- [ ] **Step 4: Implement scan generations**

Only a successful online scan sets `completed_at` and deletes rows not seen in the current generation. Permission failures become `asset_errors`; root offline aborts cleanup.

- [ ] **Step 5: Emit compact job progress at no more than 5Hz**

Do not emit an event per file.

- [ ] **Step 6: Run tests and commit**

Commit: `feat: add resumable bounded index jobs`

### Task 7: Replace watcher amplification with coalesced targeted work

**Files:**
- Create: `src-tauri/src/event_coalescer.rs`
- Modify: `src-tauri/src/watcher.rs`
- Modify: `src-tauri/src/sync.rs`
- Modify: `src-tauri/src/main.rs`

**Interfaces:**
- Produces: `EventCoalescer::push(RawFsEvent)` and `drain_ready(now) -> Vec<TargetedFsChange>`.
- Produces: `IndexCoordinator::apply_changes(root_id, changes)`.
- Removes: 5-second Deep loop, automatic focus reconciliation, per-event reconcile threads.

- [ ] **Step 1: Write pure event state-machine tests**

Cover Create+Modify, repeated Modify, Create+Remove, Remove+Create with same file ID, directory dominance, and queue overflow marking a root dirty.

- [ ] **Step 2: Run tests and confirm failure**

- [ ] **Step 3: Implement bounded watcher channel**

Capacity is 8,192. The callback only normalizes and enqueues. Overflow records `dirty=true` for the root and increments a metric.

- [ ] **Step 4: Implement targeted handlers**

File events stat and update one path. Directory create scans only that subtree. Directory delete uses one prefix SQL transaction. Rename preserves the asset ID and user relations when stable identity matches.

- [ ] **Step 5: Remove every automatic whole-root trigger**

Search for `reconcile_root`, `Duration::from_secs(5)`, and focus listeners; only explicit recovery/manual scan paths may remain.

- [ ] **Step 6: Run watcher tests and commit**

Commit: `refactor: coalesce watcher events into targeted updates`

### Task 8: Remove startup validation and expose explicit maintenance jobs

**Files:**
- Modify: `src-tauri/src/main.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/index_jobs.rs`

**Interfaces:**
- Produces commands: `start_integrity_job_v2`, `cancel_job_v2`, `get_job_status_v2`.
- Startup does only database open, watcher registration, interrupted job recovery, and root online checks.

- [ ] **Step 1: Write startup policy test around extracted `StartupPlan`**

Assert a normal clean shutdown schedules no validation or full scan; interrupted/dirty roots schedule recovery only.

- [ ] **Step 2: Implement explicit integrity job**

It is cancellable, lower priority than visible queries and watcher events, and reports progress. It does not run automatically.

- [ ] **Step 3: Delete automatic `validate_assets` and focus-trigger paths**

- [ ] **Step 4: Run tests and commit**

Commit: `perf: make integrity scans explicit and cancellable`

### Task 9: Add frontend V2 types and provider contract

**Files:**
- Modify: `src/types.ts`
- Modify: `src/services/api/types.ts`
- Modify: `src/services/api/providers/desktop.ts`
- Modify: `src/services/api/providers/web.ts`
- Modify: `src/services/dataService.ts`
- Create: `tests/asset-query.test.ts`

**Interfaces:**
- Produces TypeScript `WorkspaceShell`, `AssetQuery`, `AssetPage`, `AssetSummary`, `AssetDetail`, `SelectionExpression`, `AssetMutation`.
- Produces `dataService.getWorkspaceShell()`, `queryAssets()`, `queryFolders()`, `getAssetDetails()`, `mutateAssets()`.

- [ ] **Step 1: Add Node test runner script and DTO tests**

Use `node:test` and `node:assert/strict`. Test page limit normalization, stable query-key serialization, invalid cursor errors, and provider error propagation.

- [ ] **Step 2: Verify tests fail with missing V2 provider methods**

- [ ] **Step 3: Implement desktop and web adapters**

Desktop invokes the exact V2 Tauri command names. Web calls `/api/v2/...`. Neither adapter may return mock or empty arrays after transport failure.

- [ ] **Step 4: Run `npm run test:ts` and `npm run lint`**

- [ ] **Step 5: Commit**

Commit: `feat: add frontend v2 data contract`

### Task 10: Replace global asset state with bounded query cache

**Files:**
- Create: `src/hooks/useAssetQuery.ts`
- Modify: `src/hooks/useAppState.ts`
- Modify: `src/hooks/useFileMonitoring.ts`
- Modify: `src/App.tsx`
- Modify: `tests/asset-query.test.ts`

**Interfaces:**
- Produces: `useAssetQuery(query)` returning `{items, loading, error, hasNextPage, loadNextPage, refresh}`.
- Cache bounds: maximum 20 query pages and 300 assets per page.
- Invalidation input: `QueryInvalidation`.

- [ ] **Step 1: Write reducer/cache tests**

Assert LRU eviction at 20 pages, duplicate IDs are replaced by newer `recordVersion`, stale async responses cannot overwrite a newer query, and invalidation refreshes only affected active queries.

- [ ] **Step 2: Verify tests fail**

- [ ] **Step 3: Implement query cache and AbortController lifecycle**

- [ ] **Step 4: Rewrite `useAppState`**

Store shell summaries and UI state only. Remove initial full asset load and full-array deduplication.

- [ ] **Step 5: Connect compact invalidation events**

Batch invalidations for 50ms and refresh the active page; never append arbitrary filesystem event payloads directly to a global asset array.

- [ ] **Step 6: Run tests/lint and commit**

Commit: `refactor: use bounded paged asset state`

### Task 11: Implement virtualized main grid and list

**Files:**
- Create: `src/components/VirtualAssetGrid.tsx`
- Create: `src/components/VirtualAssetList.tsx`
- Modify: `src/components/MainArea.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: current `AssetSummary[]`, load-next-page callback, `Set<string>` selection.
- Produces: visible asset IDs for thumbnail prioritization.

- [ ] **Step 1: Extract pure virtual-range calculation and test it**

Given viewport height, scroll offset, row height, column count, and overscan, assert the returned start/end rows are clamped and contain only viewport plus overscan.

- [ ] **Step 2: Implement grid and list virtualization**

Use top/bottom spacers or absolute row placement. Render at most visible rows plus four overscan rows. Trigger `loadNextPage` near the final rendered row.

- [ ] **Step 3: Remove full-array grouping and sorting**

Grouped queries use backend-provided folder sections/counts. Selection uses `Set.has`.

- [ ] **Step 4: Add explicit loading/error/empty/offline states**

- [ ] **Step 5: Run `npm run test:ts`, `npm run lint`, and `npm run build`; commit**

Commit: `feat: virtualize asset grid and list`

### Task 12: Make split view independently paged and virtualized

**Files:**
- Modify: `src/components/MonitoredSplitView.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Each column consumes an independent `AssetQuery` and `useAssetQuery` result.
- No prop may contain the full asset table.

- [ ] **Step 1: Write a component-state reducer test for independent cursors**

- [ ] **Step 2: Replace folder-subtree array traversal with backend folder query**

- [ ] **Step 3: Render each side through `VirtualAssetGrid`/`VirtualAssetList`**

- [ ] **Step 4: Run frontend checks and commit**

Commit: `refactor: page and virtualize split workspace view`

### Task 13: Add safe bounded thumbnail pipeline

**Files:**
- Modify: `src-tauri/src/thumbnail_cache.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src/components/ThumbnailImage.tsx`
- Create: `src-tauri/src/thumbnail_cache_tests.rs`

**Interfaces:**
- Produces: `ThumbnailCoordinator::request(ThumbnailRequest) -> ThumbnailTicket`.
- Queue capacity 512; workers 2 by default; request includes source version and priority.
- JS memory cache maximum 256 entries and revokes object URLs on eviction.

- [ ] **Step 1: Write cache-key, queue-bound, and image-limit tests**

Assert mtime/size changes alter the key; more than 512 background requests do not grow the queue; declared pixel count over 100MP fails before decode.

- [ ] **Step 2: Implement versioned disk key and coordinator**

- [ ] **Step 3: Add safe header checks and remove unbounded decode fallback**

- [ ] **Step 4: Implement viewport priority and cancellation in React**

Use `IntersectionObserver`; do not call `file_exists` per render. Evict and revoke URLs at 256 entries.

- [ ] **Step 5: Run Rust/frontend checks and commit**

Commit: `perf: bound and version thumbnail generation`

### Task 14: Remove Base64 previews and add bounded streaming access

**Files:**
- Modify: `src-tauri/src/commands.rs`
- Modify: `src/utils/assetPreviewSource.ts`
- Modify: `src/components/PreviewModal.tsx`
- Create: `src-tauri/src/preview_stream.rs`

**Interfaces:**
- Produces: `read_asset_range_v2(path, offset, length)` with maximum length 4MB.
- Produces: safe asset URL for media/PDF and fixed-size text sample command.
- Removes frontend/backend use of `read_file_base64`.

- [ ] **Step 1: Write range validation tests**

Reject negative/overflowing ranges, requests over 4MB, directories, and paths outside registered roots. Verify a sparse 50GB fixture reads only requested bytes.

- [ ] **Step 2: Implement canonical path authorization and bounded reads**

- [ ] **Step 3: Switch preview source to protocol/range/text sample**

- [ ] **Step 4: Search for and remove generic Base64 asset paths**

Run: `rg "read_file_base64|data:.*base64" src src-tauri/src`

Expected: only bounded thumbnail-specific encoding may remain.

- [ ] **Step 5: Run checks and commit**

Commit: `security: stream previews with bounded reads`

### Task 15: Unify mutation, selection, rollback, and batch semantics

**Files:**
- Modify: `src/hooks/useEntityActions.ts`
- Modify: `src/hooks/useMiscActions.ts`
- Modify: `src/App.tsx`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/database.rs`
- Modify: `tests/asset-query.test.ts`

**Interfaces:**
- Produces mutation commands with `operationId`, `expectedVersion`, and either explicit IDs capped at 1,000 or `SelectionExpression { query, excludedIds }`.

- [ ] **Step 1: Write mutation idempotency and rollback tests**

Assert duplicate operation IDs apply once, query-selection updates all matching rows except exclusions, stale version returns conflict, and a failed request restores optimistic cache state.

- [ ] **Step 2: Implement backend mutation transaction and operation journal**

- [ ] **Step 3: Replace side effects inside React state updater functions**

Build the optimistic patch first, update cache once, await backend outside the updater, then commit revision or rollback.

- [ ] **Step 4: Implement selection expression**

“Select all” stores the current query plus exclusions, not all asset objects or IDs.

- [ ] **Step 5: Run checks and commit**

Commit: `feat: add reliable query-based asset mutations`

### Task 16: Align Web V2 endpoints and PostgreSQL constraints

**Files:**
- Modify: `server.ts`
- Modify: `src/db/schema.ts`
- Modify: `src/services/api/providers/web.ts`
- Create: `tests/web-contract.test.ts`

**Interfaces:**
- Produces `/api/v2/workspace-shell`, `/api/v2/assets/query`, `/api/v2/folders/query`, `/api/v2/assets/details`, `/api/v2/assets/mutate`.
- Response DTOs exactly match desktop V2.

- [ ] **Step 1: Write provider contract tests using an in-process Express server**

- [ ] **Step 2: Add indexes and composite uniqueness constraints**

- [ ] **Step 3: Implement paged SQL and transactional batch mutations**

No endpoint returns all workspace assets; no association batch constructs an unbounded Cartesian product.

- [ ] **Step 4: Remove rating no-op and mock fallback behavior**

- [ ] **Step 5: Run tests/lint/build and commit**

Commit: `feat: align web api with v2 query contract`

### Task 17: Add observability, diagnostics, and scale fixture

**Files:**
- Create: `src-tauri/src/metrics.rs`
- Create: `scripts/generate-scale-fixture.ps1`
- Modify: `src-tauri/src/index_jobs.rs`
- Modify: `src-tauri/src/watcher.rs`
- Modify: `src-tauri/src/database.rs`
- Modify: `src-tauri/src/thumbnail_cache.rs`

**Interfaces:**
- Produces one aggregated metrics snapshot with queue depths, rates, query latency, cache hit rate, thread/job counts, and error counts.

- [ ] **Step 1: Write aggregation/reset tests**

- [ ] **Step 2: Instrument component boundaries without per-file success logging**

- [ ] **Step 3: Add explicit fixture generator**

Parameters: destination, file count, folder count, optional sparse large-file size. Refuse root drives, home directories, or existing non-empty destinations unless explicitly confirmed by the caller.

- [ ] **Step 4: Add a diagnostic command returning metrics and active jobs**

- [ ] **Step 5: Run checks and commit**

Commit: `chore: add scalable pipeline diagnostics`

### Task 18: Remove legacy full-snapshot code and complete regression verification

**Files:**
- Delete or reduce obsolete paths in: `src-tauri/src/aggregator.rs`, `src-tauri/src/sync.rs`, `src/hooks/useAssetFiltering.ts`.
- Modify: `ARCHITECTURE.md`
- Modify: `DATABASE_DESIGN.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- No runtime reference to `get_all_assets`, full `ScanResult.assets`, automatic `validate_assets`, periodic Deep reconcile, or generic Base64 previews.

- [ ] **Step 1: Run legacy-pattern audit**

```powershell
rg "get_all_assets|load_workspace|validate_assets|Duration::from_secs\(5\)|ReconcileMode::Deep|read_file_base64|assets: Asset\[\]" src src-tauri/src
```

Each remaining occurrence must be a test asserting absence/deprecation or intentionally bounded page DTO.

- [ ] **Step 2: Remove dead modules, commands, types, and dependencies**

- [ ] **Step 3: Update project documentation to describe actual V2 behavior**

- [ ] **Step 4: Run complete verification**

```powershell
npm run test:ts
npm run lint
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

Expected: all commands exit 0.

- [ ] **Step 5: Run desktop smoke test**

Verify empty V2 startup, add monitor root, progressive results, restart persistence, file create/modify/delete, directory rename, search/sort/filter, rating/favorite/tag/collection, split view, thumbnail scroll, preview, cancellation, offline root, and recovery.

- [ ] **Step 6: Record measured results against the acceptance table**

Document dataset size, hardware, cold start, page latency, event latency, peak RSS, thread count, scan throughput, and thumbnail cache behavior.

- [ ] **Step 7: Commit**

Commit: `refactor: complete asset explorer v2 architecture`

---

## Execution Order and Checkpoints

- Checkpoint A after Tasks 1–5: V2 empty database and cursor API compile and pass tests.
- Checkpoint B after Tasks 6–8: scanning, monitoring, recovery, and startup are bounded.
- Checkpoint C after Tasks 9–12: the UI no longer loads or renders the complete asset table.
- Checkpoint D after Tasks 13–15: thumbnails, previews, and user mutations have resource and correctness guarantees.
- Checkpoint E after Tasks 16–18: Web parity, observability, legacy removal, documentation, and complete verification.

Because the user explicitly requested uninterrupted completion in the current task, execution proceeds inline with `executing-plans`; checkpoint failures are debugged and repaired before moving to the next checkpoint.
