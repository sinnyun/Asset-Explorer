import express from 'express';
import { and, asc, desc, eq, ilike, inArray, isNull, type SQL } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { assetCollections, assets, assetTags, collections, folders, smartFolders, tags } from '../db/schema.ts';
import { requireAuth, type AuthRequest } from '../middleware/auth.ts';
import { decodeOffsetCursor, encodeOffsetCursor, normalizeV2PageLimit } from './v2Contract.ts';

export const v2Router = express.Router();
v2Router.use(requireAuth);

function sendFailure(res: express.Response, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const status = message === 'Invalid V2 cursor' ? 400 : 500;
  res.status(status).json({ error: message });
}

function summary(row: typeof assets.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    type: row.type,
    size: row.size,
    folderId: row.folderId,
    mtimeNs: row.dateModified.getTime() * 1_000_000,
    rating: row.rating,
    favorite: row.favorite,
    color: row.color ?? undefined,
    width: row.width ?? undefined,
    height: row.height ?? undefined,
    recordVersion: row.recordVersion,
  };
}

v2Router.get('/v2/workspace-shell', async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.uid;
    const [rootRows, tagRows, collectionRows, smartRows] = await Promise.all([
      db.select().from(folders).where(and(eq(folders.userId, userId), isNull(folders.parentId))).orderBy(asc(folders.name)).limit(300),
      db.select().from(tags).where(eq(tags.userId, userId)).orderBy(asc(tags.name)).limit(300),
      db.select().from(collections).where(eq(collections.userId, userId)).orderBy(asc(collections.name)).limit(300),
      db.select().from(smartFolders).where(eq(smartFolders.userId, userId)).orderBy(asc(smartFolders.name)).limit(300),
    ]);
    res.json({
      roots: rootRows.map(folder => ({ ...folder, tags: [], collections: [] })),
      tags: tagRows,
      collections: collectionRows,
      smartFolders: smartRows.map(item => ({ id: item.id, name: item.name, icon: 'filter', rules: item.rulesJson, matchAll: item.matchAll })),
      revision: 0,
    });
  } catch (error) { sendFailure(res, error); }
});

v2Router.post('/v2/assets/query', async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.uid;
    const input = req.body ?? {};
    const limit = normalizeV2PageLimit(input.limit);
    const offset = decodeOffsetCursor(input.cursor);
    const conditions: SQL[] = [eq(assets.userId, userId)];
    if (input.folderId) {
      if (input.includeDescendants) {
        const [folder] = await db.select({ path: folders.path }).from(folders)
          .where(and(eq(folders.userId, userId), eq(folders.id, String(input.folderId)))).limit(1);
        if (!folder) return res.status(404).json({ error: 'Folder not found' });
        conditions.push(ilike(assets.path, `${folder.path.replace(/[\\/]$/, '')}/%`));
      } else {
        conditions.push(eq(assets.folderId, String(input.folderId)));
      }
    }
    if (typeof input.search === 'string' && input.search.trim()) conditions.push(ilike(assets.name, `%${input.search.trim()}%`));
    if (Array.isArray(input.types) && input.types.length > 0) conditions.push(inArray(assets.type, input.types.slice(0, 100).map(String)));
    if (typeof input.rating === 'number') conditions.push(eq(assets.rating, Math.max(0, Math.min(5, Math.floor(input.rating)))));
    if (typeof input.favorite === 'boolean') conditions.push(eq(assets.favorite, input.favorite));
    if (Array.isArray(input.tagIds) && input.tagIds.length > 0) {
      conditions.push(inArray(assets.id, db.select({ id: assetTags.assetId }).from(assetTags).where(inArray(assetTags.tagId, input.tagIds.slice(0, 100).map(String)))));
    }
    if (Array.isArray(input.collectionIds) && input.collectionIds.length > 0) {
      conditions.push(inArray(assets.id, db.select({ id: assetCollections.assetId }).from(assetCollections).where(inArray(assetCollections.collectionId, input.collectionIds.slice(0, 100).map(String)))));
    }

    const descending = input.sort === 'name_desc' || input.sort === 'modified_desc' || input.sort === 'size_desc';
    const sortColumn = input.sort?.startsWith('modified') ? assets.dateModified : input.sort?.startsWith('size') ? assets.size : assets.name;
    const direction = descending ? desc : asc;
    const rows = await db.select().from(assets).where(and(...conditions))
      .orderBy(direction(sortColumn), direction(assets.id)).limit(limit + 1).offset(offset);
    const hasMore = rows.length > limit;
    res.json({
      items: rows.slice(0, limit).map(summary),
      nextCursor: hasMore ? encodeOffsetCursor(offset + limit) : undefined,
      totalApprox: undefined,
      queryRevision: 0,
      limit,
    });
  } catch (error) { sendFailure(res, error); }
});

v2Router.post('/v2/folders/query', async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.uid;
    const input = req.body ?? {};
    const limit = normalizeV2PageLimit(input.limit);
    const offset = decodeOffsetCursor(input.cursor);
    const where = input.parentId
      ? and(eq(folders.userId, userId), eq(folders.parentId, String(input.parentId)))
      : and(eq(folders.userId, userId), isNull(folders.parentId));
    const rows = await db.select().from(folders).where(where).orderBy(asc(folders.name), asc(folders.id)).limit(limit + 1).offset(offset);
    const visible = rows.slice(0, limit);
    const ids = visible.map(folder => folder.id);
    const childRows = ids.length > 0
      ? await db.select({ parentId: folders.parentId }).from(folders).where(and(eq(folders.userId, userId), inArray(folders.parentId, ids)))
      : [];
    const parents = new Set(childRows.map(row => row.parentId));
    res.json({
      items: visible.map(folder => ({
        id: folder.id, name: folder.name, path: folder.path, parentId: folder.parentId ?? undefined,
        isMonitored: folder.isMonitored, assetCount: folder.assetCount ?? 0,
        hasChildren: parents.has(folder.id), recordVersion: folder.recordVersion,
      })),
      nextCursor: rows.length > limit ? encodeOffsetCursor(offset + limit) : undefined,
      limit,
    });
  } catch (error) { sendFailure(res, error); }
});

v2Router.post('/v2/assets/details', async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.uid;
    const ids: string[] = Array.isArray(req.body?.ids)
      ? Array.from(new Set<string>((req.body.ids as unknown[]).map(value => String(value))))
      : [];
    if (ids.length > 1_000) return res.status(400).json({ error: 'At most 1000 asset IDs are allowed' });
    if (ids.length === 0) return res.json([]);
    const rows = await db.select().from(assets).where(and(eq(assets.userId, userId), inArray(assets.id, ids)));
    const byId = new Map(rows.map(row => [row.id, row]));
    res.json(ids.flatMap(id => {
      const row = byId.get(id);
      return row ? [{ ...summary(row), normalizedPath: row.path.toLocaleLowerCase(), customName: row.customName ?? undefined, notes: row.notes ?? undefined }] : [];
    }));
  } catch (error) { sendFailure(res, error); }
});
