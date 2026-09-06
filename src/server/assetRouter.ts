import express from 'express';
import { db } from '../db/index.ts';
import { assets, assetTags, assetCollections } from '../db/schema.ts';
import { eq, and, desc } from 'drizzle-orm';
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
