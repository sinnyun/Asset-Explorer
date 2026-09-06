import express from 'express';
import { db } from '../db/index.ts';
import { assets, assetTags, assetCollections } from '../db/schema.ts';
import { eq, and, desc, inArray } from 'drizzle-orm';
import { requireAuth, AuthRequest } from '../middleware/auth.ts';

export const assetRouter = express.Router();

/** Express 5 路由参数提取辅助 */
function paramId(req: express.Request): string {
  return String(req.params.id);
}

/** 获取所有资产 */
assetRouter.get("/assets", requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.uid;
    const allAssets = await db.select()
      .from(assets)
      .where(eq(assets.userId, userId))
      .orderBy(desc(assets.dateModified));

    const serialized = allAssets.map(a => ({
      ...a,
      dateModified: a.dateModified?.toISOString?.() ?? a.dateModified,
      dateAdded: a.dateAdded?.toISOString?.() ?? a.dateAdded,
    }));

    res.json(serialized);
  } catch (error: any) {
    console.error("[API] 获取资产失败:", error);
    res.status(500).json({ error: error.message || "Failed to get assets" });
  }
});

/** 更新资产评分 */
assetRouter.patch("/assets/:id/rating", requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.uid;
    const id = paramId(req);
    const { rating } = req.body;
    // 注意：assets 表 schema 中没有 rating 字段，此处保留 API 以便后续扩展
    res.json({ success: true, id, rating });
  } catch (error: any) {
    console.error("[API] 更新资产评分失败:", error);
    res.status(500).json({ error: error.message || "Failed to update asset rating" });
  }
});

/** 批量删除资产 */
assetRouter.post("/assets/batch-delete", requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.uid;
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "ids must be a non-empty array" });
    }

    // 逐条删除（同时清理关联表）
    for (const assetId of ids) {
      await db.delete(assetTags).where(eq(assetTags.assetId, assetId));
      await db.delete(assetCollections).where(eq(assetCollections.assetId, assetId));
      await db.delete(assets).where(and(eq(assets.id, assetId), eq(assets.userId, userId)));
    }

    res.json({ success: true, deletedCount: ids.length });
  } catch (error: any) {
    console.error("[API] 批量删除资产失败:", error);
    res.status(500).json({ error: error.message || "Failed to delete assets" });
  }
});

/** 同步设置单个资产的标签关联（全量替换） */
assetRouter.put("/assets/:id/tags", requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.uid;
    const id = paramId(req);
    const { tagIds } = req.body;
    if (!Array.isArray(tagIds)) {
      return res.status(400).json({ error: "tagIds must be an array" });
    }

    // Verify asset belongs to user
    const assetRows = await db.select().from(assets)
      .where(and(eq(assets.id, id), eq(assets.userId, userId)));
    if (assetRows.length === 0) {
      return res.status(404).json({ error: "Asset not found" });
    }

    // Delete all existing associations then insert new ones
    await db.delete(assetTags).where(eq(assetTags.assetId, id));
    for (const tagId of tagIds) {
      await db.insert(assetTags).values({ assetId: id, tagId }).onConflictDoNothing();
    }
    res.json({ success: true });
  } catch (error: any) {
    console.error("[API] 同步资产标签失败:", error);
    res.status(500).json({ error: error.message || "Failed to sync asset tags" });
  }
});

/** 同步设置单个资产的集合关联（全量替换） */
assetRouter.put("/assets/:id/collections", requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.uid;
    const id = paramId(req);
    const { collectionIds } = req.body;
    if (!Array.isArray(collectionIds)) {
      return res.status(400).json({ error: "collectionIds must be an array" });
    }

    const assetRows = await db.select().from(assets)
      .where(and(eq(assets.id, id), eq(assets.userId, userId)));
    if (assetRows.length === 0) {
      return res.status(404).json({ error: "Asset not found" });
    }

    await db.delete(assetCollections).where(eq(assetCollections.assetId, id));
    for (const colId of collectionIds) {
      await db.insert(assetCollections).values({ assetId: id, collectionId: colId }).onConflictDoNothing();
    }
    res.json({ success: true });
  } catch (error: any) {
    console.error("[API] 同步资产集合失败:", error);
    res.status(500).json({ error: error.message || "Failed to sync asset collections" });
  }
});

/** 批量添加标签到多个资产 */
assetRouter.post("/assets/batch-tags", requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.uid;
    const { assetIds, tagIds } = req.body;
    if (!Array.isArray(assetIds) || !Array.isArray(tagIds) || assetIds.length === 0) {
      return res.status(400).json({ error: "assetIds and tagIds must be non-empty arrays" });
    }

    for (const assetId of assetIds) {
      for (const tagId of tagIds) {
        await db.insert(assetTags).values({ assetId, tagId }).onConflictDoNothing();
      }
    }
    res.json({ success: true, added: assetIds.length * tagIds.length });
  } catch (error: any) {
    console.error("[API] 批量添加资产标签失败:", error);
    res.status(500).json({ error: error.message || "Failed to batch add asset tags" });
  }
});

/** 批量添加集合到多个资产 */
assetRouter.post("/assets/batch-collections", requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.uid;
    const { assetIds, collectionIds } = req.body;
    if (!Array.isArray(assetIds) || !Array.isArray(collectionIds) || assetIds.length === 0) {
      return res.status(400).json({ error: "assetIds and collectionIds must be non-empty arrays" });
    }

    for (const assetId of assetIds) {
      for (const colId of collectionIds) {
        await db.insert(assetCollections).values({ assetId, collectionId: colId }).onConflictDoNothing();
      }
    }
    res.json({ success: true, added: assetIds.length * collectionIds.length });
  } catch (error: any) {
    console.error("[API] 批量添加资产集合失败:", error);
    res.status(500).json({ error: error.message || "Failed to batch add asset collections" });
  }
});

/** 从资产移除标签 */
assetRouter.delete("/assets/:id/tags", requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.uid;
    const id = paramId(req);
    const { tagIds } = req.body;
    if (!Array.isArray(tagIds)) {
      return res.status(400).json({ error: "tagIds must be an array" });
    }

    for (const tagId of tagIds) {
      await db.delete(assetTags).where(and(eq(assetTags.assetId, id), eq(assetTags.tagId, tagId)));
    }
    res.json({ success: true });
  } catch (error: any) {
    console.error("[API] 移除资产标签失败:", error);
    res.status(500).json({ error: error.message || "Failed to remove asset tags" });
  }
});

/** 从资产移除集合 */
assetRouter.delete("/assets/:id/collections", requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.uid;
    const id = paramId(req);
    const { collectionIds } = req.body;
    if (!Array.isArray(collectionIds)) {
      return res.status(400).json({ error: "collectionIds must be an array" });
    }

    for (const colId of collectionIds) {
      await db.delete(assetCollections).where(and(eq(assetCollections.assetId, id), eq(assetCollections.collectionId, colId)));
    }
    res.json({ success: true });
  } catch (error: any) {
    console.error("[API] 移除资产集合失败:", error);
    res.status(500).json({ error: error.message || "Failed to remove asset collections" });
  }
});
