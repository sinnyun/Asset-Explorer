# Asset Explorer - Database & Backend Architecture Design

## 1. Overview
This document details the backend architecture for the Asset Explorer, designed to handle 100,000+ assets with instant search, complex filtering (Smart Folders), and seamless performance. To achieve extreme performance and full UI-Backend decoupling, we are transitioning from in-memory mock data to a robust multi-database/persistence architecture.

## 2. Infrastructure Architecture
To achieve 100k+ scale with zero UI lag, the backend employs a multi-tiered data strategy:

1. **Primary Relational Database (Cloud SQL / PostgreSQL)**:
   - Serves as the single source of truth (SSOT).
   - Manages ACID transactions, strict relational integrity (Assets to Folders, Tags, Collections).
   - Pre-calculates and stores aggregate counts (e.g., how many items in a folder, how many items tagged 'UI') via database triggers or application-level hooks.

2. **Caching & Aggregation Layer (Redis - Conceptual)**:
   - Stores pre-calculated UI states (e.g., folder trees, tag lists, collection lists).
   - Caches complex Smart Folder query results.
   - Offloads read-heavy operations from PostgreSQL.
   - *Note: In the current AI Studio preview, PostgreSQL will handle these duties via materialized views and denormalized counting columns to emulate Redis-like read speeds.*

3. **Backend Service (Node.js / Express)**:
   - Exposes RESTful APIs for the React frontend.
   - Handles pagination (cursor-based), sorting, and search logic.
   - Sanitizes and optimizes payloads before sending them to the client.

## 3. Database Schema (PostgreSQL via Drizzle ORM)

The relational schema heavily utilizes **denormalization** to avoid expensive `COUNT()` and `JOIN` operations during real-time UI rendering.

### `folders` Table
| Column | Type | Description |
| :--- | :--- | :--- |
| `id` | VARCHAR (PK) | Unique folder identifier |
| `name` | VARCHAR | Folder name |
| `parent_id` | VARCHAR (FK) | Reference to parent folder (self-referencing) |
| `path` | TEXT | Full materialized path (e.g., `workspace/proj1/assets`) for fast subfolder querying (Path Enumeration) |
| `asset_count` | INTEGER | **[DENORMALIZED]** Pre-calculated total direct assets |
| `created_at` | TIMESTAMP | Creation date |

### `assets` Table
| Column | Type | Description |
| :--- | :--- | :--- |
| `id` | VARCHAR (PK) | Unique asset identifier |
| `name` | VARCHAR | File name |
| `type` | VARCHAR | Asset type (image, video, model, etc.) |
| `size` | BIGINT | File size in bytes |
| `folder_id` | VARCHAR (FK) | Reference to `folders.id` |
| `path` | TEXT | Absolute file path |
| `thumbnail_url` | TEXT | URL to cached thumbnail |
| `date_modified` | TIMESTAMP | Last modification date |
| `date_added` | TIMESTAMP | Date imported |

### `tags` Table
| Column | Type | Description |
| :--- | :--- | :--- |
| `id` | VARCHAR (PK) | Unique tag identifier |
| `name` | VARCHAR | Tag name |
| `color` | VARCHAR | Hex/HSL color code |
| `usage_count` | INTEGER | **[DENORMALIZED]** Pre-calculated number of assets using this tag |

### `collections` Table
| Column | Type | Description |
| :--- | :--- | :--- |
| `id` | VARCHAR (PK) | Unique collection identifier |
| `name` | VARCHAR | Collection name |
| `asset_count` | INTEGER | **[DENORMALIZED]** Pre-calculated number of assets in collection |

### `asset_tags` (Many-to-Many)
| Column | Type | Description |
| :--- | :--- | :--- |
| `asset_id` | VARCHAR (FK) | Reference to `assets.id` |
| `tag_id` | VARCHAR (FK) | Reference to `tags.id` |

### `asset_collections` (Many-to-Many)
| Column | Type | Description |
| :--- | :--- | :--- |
| `asset_id` | VARCHAR (FK) | Reference to `assets.id` |
| `collection_id` | VARCHAR (FK)| Reference to `collections.id` |

### `smart_folders` Table
Stores user-defined custom smart folders and their rules.
| Column | Type | Description |
| :--- | :--- | :--- |
| `id` | VARCHAR (PK) | Unique smart folder identifier |
| `name` | VARCHAR | Smart folder name |
| `match_all` | BOOLEAN | AND vs OR logic |
| `rules_json` | JSONB | Stored JSON of rules (type, operator, value) for dynamic query building |

## 4. Performance Optimization Strategies

1. **Denormalized Counters (Avoid `COUNT()`)**
   Every time an asset is added/removed from a folder, tag, or collection, the backend will increment/decrement the `asset_count` / `usage_count` columns. The UI never runs a `SELECT COUNT(*)`.
2. **Materialized Paths for Folders**
   The `path` column on folders uses the Materialized Path pattern (`workspace/proj1/assets`). To get all items including subfolders, the backend queries `WHERE path LIKE 'workspace/proj1/%'`, which is extremely fast and indexed, entirely avoiding recursive CTEs.
3. **Cursor-Based Pagination**
   Instead of `OFFSET 50000 LIMIT 100` (which scans and discards 50k rows), the UI uses cursors: `WHERE date_modified < last_seen_date LIMIT 100`. This provides constant `O(1)` time complexity for scrolling through 100k items.
4. **JSONB Rule Engine**
   Smart folder rules are stored as JSONB. For massive databases, frequent/popular smart folders can be backed by actual Materialized Views in PostgreSQL, updating asynchronously.

## 5. Next Steps
Once the database is provisioned, we will:
1. Initialize the **Express.js backend API** with Drizzle ORM.
2. Build data seeding scripts for the 100k scale test.
3. Replace the React frontend's local state management with React Query / SWR for fast, cached API fetching.
