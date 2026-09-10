import express from 'express';
import { and, asc, desc, eq, ilike, inArray, isNull, notInArray, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { assetCollections, assets, assetTags, collections, folders, mutationOperations, smartFolders, tags } from '../db/schema.ts';
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

v2Router.post('/v2/assets/mutate', async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.uid;
    const operationId = typeof req.body?.operationId === 'string' ? req.body.operationId.trim() : '';
    const ids: string[] = Array.isArray(req.body?.ids)
      ? Array.from(new Set<string>((req.body.ids as unknown[]).map(value => String(value))))
      : [];
    const selection = req.body?.selection;
    if (!operationId) return res.status(400).json({ error: 'operationId is required' });
    if ((ids.length === 0) === !selection || ids.length > 1_000) return res.status(400).json({ error: 'provide ids or selection, but not both' });
    const excludedIds: string[] = selection && Array.isArray(selection.excludedIds)
      ? Array.from(new Set<string>((selection.excludedIds as unknown[]).map(value => String(value))))
      : [];
    if (excludedIds.length > 400) return res.status(400).json({ error: 'at most 400 exclusions are allowed' });
    const patch = req.body?.patch ?? {};
    if (patch.rating !== undefined && (!Number.isInteger(patch.rating) || patch.rating < 0 || patch.rating > 5)) {
      return res.status(400).json({ error: 'rating must be an integer from 0 to 5' });
    }
    if (patch.favorite !== undefined && typeof patch.favorite !== 'boolean') return res.status(400).json({ error: 'favorite must be boolean' });

    const result = await db.transaction(async tx => {
      const [existing] = await tx.select().from(mutationOperations)
        .where(and(eq(mutationOperations.userId, userId), eq(mutationOperations.operationId, operationId))).limit(1);
      if (existing) return { affected: existing.affected, revision: existing.revision };

      const targetConditions: SQL[] = [eq(assets.userId, userId)];
      if (selection) {
        const query = selection.query ?? {};
        if (query.folderId) {
          if (query.includeDescendants) {
            const [folder] = await tx.select({ path: folders.path }).from(folders)
              .where(and(eq(folders.userId, userId), eq(folders.id, String(query.folderId)))).limit(1);
            if (!folder) throw new Error('mutation conflict');
            targetConditions.push(ilike(assets.path, `${folder.path.replace(/[\\/]$/, '')}/%`));
          } else targetConditions.push(eq(assets.folderId, String(query.folderId)));
        }
        if (typeof query.search === 'string' && query.search.trim()) targetConditions.push(ilike(assets.name, `%${query.search.trim()}%`));
        if (Array.isArray(query.types) && query.types.length) targetConditions.push(inArray(assets.type, query.types.slice(0, 100).map(String)));
        if (typeof query.rating === 'number') targetConditions.push(eq(assets.rating, query.rating));
        if (typeof query.favorite === 'boolean') targetConditions.push(eq(assets.favorite, query.favorite));
        if (Array.isArray(query.tagIds) && query.tagIds.length) targetConditions.push(inArray(assets.id, tx.select({ id: assetTags.assetId }).from(assetTags).where(inArray(assetTags.tagId, query.tagIds.slice(0, 100).map(String)))));
        if (Array.isArray(query.collectionIds) && query.collectionIds.length) targetConditions.push(inArray(assets.id, tx.select({ id: assetCollections.assetId }).from(assetCollections).where(inArray(assetCollections.collectionId, query.collectionIds.slice(0, 100).map(String)))));
        if (excludedIds.length) targetConditions.push(notInArray(assets.id, excludedIds));
      } else {
        targetConditions.push(inArray(assets.id, ids));
      }
      await tx.execute(sql`CREATE TEMP TABLE mutation_targets ON COMMIT DROP AS SELECT ${assets.id} AS id FROM ${assets} WHERE ${and(...targetConditions)}`);
      const countResult: any = await tx.execute(sql`SELECT COUNT(*)::int AS count FROM mutation_targets`);
      const affected = Number(countResult.rows?.[0]?.count ?? countResult[0]?.count ?? 0);
      const expectedVersion = req.body?.expectedVersion;
      if ((!selection && affected !== ids.length)) {
        throw new Error('mutation conflict');
      }
      if (expectedVersion !== undefined) {
        const conflictResult: any = await tx.execute(sql`SELECT COUNT(*)::int AS count FROM ${assets} a JOIN mutation_targets t ON t.id=a.id WHERE a.record_version<>${expectedVersion}`);
        const conflicts = Number(conflictResult.rows?.[0]?.count ?? conflictResult[0]?.count ?? 0);
        if (conflicts > 0) throw new Error('mutation conflict');
      }
      const values: Record<string, unknown> = { recordVersion: sql`${assets.recordVersion} + 1` };
      if (patch.rating !== undefined) values.rating = patch.rating;
      if (patch.favorite !== undefined) values.favorite = patch.favorite;
      if (patch.color !== undefined) values.color = String(patch.color);
      await tx.update(assets).set(values).where(and(eq(assets.userId, userId), inArray(assets.id, sql`SELECT id FROM mutation_targets`)));
      const revision = Date.now();
      await tx.insert(mutationOperations).values({ userId, operationId, affected, revision });
      return { affected, revision };
    });
    res.json(result);
  } catch (error) {
    if (error instanceof Error && error.message === 'mutation conflict') return res.status(409).json({ error: error.message });
    sendFailure(res, error);
  }
});
