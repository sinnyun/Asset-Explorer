import express from 'express';
import { db } from '../db/index.ts';
import { assets } from '../db/schema.ts';
import { eq, count } from 'drizzle-orm';
import { requireAuth, AuthRequest } from '../middleware/auth.ts';

export const storageRouter = express.Router();

/** 获取存储统计信息 */
storageRouter.get("/storage/stats", requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.uid;
    const assetCount = await db.select({ count: count() })
      .from(assets)
      .where(eq(assets.userId, userId));

    res.json({
      data_dir: 'PostgreSQL (Cloud)',
      db_size_bytes: 0,
      thumbnails_size_bytes: 0,
      total_size_bytes: 0,
      asset_count: assetCount[0]?.count ?? 0,
    });
  } catch (error: any) {
    console.error("[API] 获取存储统计失败:", error);
    res.status(500).json({ error: error.message || "Failed to get storage stats" });
  }
});
