import express from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth.ts';
import { db } from '../db/index.ts';
import { folders, tags, collections, assets, smartFolders } from '../db/schema.ts';
import { eq, asc, desc } from 'drizzle-orm';

export const workspaceRouter = express.Router();

/** 获取完整工作区数据（文件夹、标签、集合、资产、智能文件夹） */
workspaceRouter.get("/workspace", requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.uid;

    const [allFolders, allTags, allCollections, allAssets, allSmartFolders] = await Promise.all([
      db.select().from(folders).where(eq(folders.userId, userId)).orderBy(asc(folders.name)),
      db.select().from(tags).where(eq(tags.userId, userId)).orderBy(asc(tags.name)),
      db.select().from(collections).where(eq(collections.userId, userId)).orderBy(asc(collections.name)),
      db.select().from(assets).where(eq(assets.userId, userId)).orderBy(desc(assets.dateModified)),
      db.select().from(smartFolders).where(eq(smartFolders.userId, userId)).orderBy(asc(smartFolders.name)),
    ]);

    const serializedAssets = allAssets.map(a => ({
      ...a,
      dateModified: a.dateModified?.toISOString?.() ?? a.dateModified,
      dateAdded: a.dateAdded?.toISOString?.() ?? a.dateAdded,
    }));

    res.json({
      folders: allFolders,
      tags: allTags,
      collections: allCollections,
      assets: serializedAssets,
      smartFolders: allSmartFolders,
    });
  } catch (error: any) {
    console.error("[API] 加载工作区失败:", error);
    res.status(500).json({ error: error.message || "Failed to load workspace" });
  }
});
