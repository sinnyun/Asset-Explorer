import { relations } from 'drizzle-orm';
import { pgTable, text, varchar, integer, bigint, timestamp, boolean, jsonb, index, primaryKey, uniqueIndex } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: varchar('id').primaryKey(),
  email: text('email').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
});

export const folders = pgTable('folders', {
  id: varchar('id').primaryKey(),
  userId: varchar('user_id').references(() => users.id).notNull(),
  name: varchar('name').notNull(),
  parentId: varchar('parent_id'),
  path: text('path').notNull(),
  assetCount: integer('asset_count').default(0),
  isMonitored: boolean('is_monitored').notNull().default(false),
  recordVersion: integer('record_version').notNull().default(1),
  createdAt: timestamp('created_at').defaultNow(),
}, table => [
  uniqueIndex('folders_user_path_unique').on(table.userId, table.path),
  index('folders_user_parent_name_idx').on(table.userId, table.parentId, table.name, table.id),
]);

export const tags = pgTable('tags', {
  id: varchar('id').primaryKey(),
  userId: varchar('user_id').references(() => users.id).notNull(),
  name: varchar('name').notNull(),
  color: varchar('color').notNull(),
  usageCount: integer('usage_count').default(0),
});

export const collections = pgTable('collections', {
  id: varchar('id').primaryKey(),
  userId: varchar('user_id').references(() => users.id).notNull(),
  name: varchar('name').notNull(),
  assetCount: integer('asset_count').default(0),
});

export const assets = pgTable('assets', {
  id: varchar('id').primaryKey(),
  userId: varchar('user_id').references(() => users.id).notNull(),
  name: varchar('name').notNull(),
  type: varchar('type').notNull(),
  size: bigint('size', { mode: 'number' }).notNull(),
  folderId: varchar('folder_id').references(() => folders.id).notNull(),
  path: text('path').notNull(),
  thumbnailUrl: text('thumbnail_url'),
  rating: integer('rating').notNull().default(0),
  favorite: boolean('favorite').notNull().default(false),
  color: varchar('color'),
  customName: text('custom_name'),
  notes: text('notes'),
  width: integer('width'),
  height: integer('height'),
  recordVersion: integer('record_version').notNull().default(1),
  dateModified: timestamp('date_modified').notNull(),
  dateAdded: timestamp('date_added').defaultNow().notNull(),
}, table => [
  uniqueIndex('assets_user_path_unique').on(table.userId, table.path),
  index('assets_user_folder_name_idx').on(table.userId, table.folderId, table.name, table.id),
  index('assets_user_modified_idx').on(table.userId, table.dateModified, table.id),
  index('assets_user_size_idx').on(table.userId, table.size, table.id),
  index('assets_user_favorite_rating_idx').on(table.userId, table.favorite, table.rating, table.id),
]);

export const assetTags = pgTable('asset_tags', {
  assetId: varchar('asset_id').references(() => assets.id).notNull(),
  tagId: varchar('tag_id').references(() => tags.id).notNull(),
}, table => [primaryKey({ columns: [table.assetId, table.tagId] })]);

export const assetCollections = pgTable('asset_collections', {
  assetId: varchar('asset_id').references(() => assets.id).notNull(),
  collectionId: varchar('collection_id').references(() => collections.id).notNull(),
}, table => [primaryKey({ columns: [table.assetId, table.collectionId] })]);

export const smartFolders = pgTable('smart_folders', {
  id: varchar('id').primaryKey(),
  userId: varchar('user_id').references(() => users.id).notNull(),
  name: varchar('name').notNull(),
  matchAll: boolean('match_all').notNull().default(true),
  rulesJson: jsonb('rules_json').notNull(),
});

export const mutationOperations = pgTable('mutation_operations', {
  userId: varchar('user_id').references(() => users.id).notNull(),
  operationId: varchar('operation_id').notNull(),
  affected: integer('affected').notNull(),
  revision: bigint('revision', { mode: 'number' }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, table => [primaryKey({ columns: [table.userId, table.operationId] })]);

export const usersRelations = relations(users, ({ many }) => ({
  folders: many(folders),
  assets: many(assets),
  tags: many(tags),
  collections: many(collections),
  smartFolders: many(smartFolders),
}));

export const foldersRelations = relations(folders, ({ one, many }) => ({
  user: one(users, { fields: [folders.userId], references: [users.id] }),
  assets: many(assets),
}));

export const assetsRelations = relations(assets, ({ one, many }) => ({
  user: one(users, { fields: [assets.userId], references: [users.id] }),
  folder: one(folders, { fields: [assets.folderId], references: [folders.id] }),
  tags: many(assetTags),
  collections: many(assetCollections),
}));
