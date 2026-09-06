import express from 'express';
import { db } from '../db/index.ts';
import { collections, assetCollections } from '../db/schema.ts';
import { eq, and, asc } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { requireAuth, AuthRequest } from '../middleware/auth.ts';

export const collectionRouter = express.Router();

/** Express 5 路由参数提取辅助 */
function paramId(req: express.Request): string {
  return String(req.params.id);
}

/** 获取所有集合 */
collectionRouter.get("/collections", requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.uid;
    const allCollections = await db.select()
      .from(collections)
      .where(eq(collections.userId, userId))
      .orderBy(asc(collections.name));
    res.json(allCollections);
  } catch (error: any) {
    console.error("[API] 获取集合失败:", error);
    res.status(500).json({ error: error.message || "Failed to get collections" });
  }
});

/** 创建集合 */
collectionRouter.post("/collections", requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.uid;
    const { name } = req.body;
    const newCollection = {
      id: randomUUID(),
      userId,
      name,
      assetCount: 0,
    };
    const result = await db.insert(collections).values(newCollection).returning();
    res.json(result[0]);
  } catch (error: any) {
    console.error("[API] 创建集合失败:", error);
    res.status(500).json({ error: error.message || "Failed to create collection" });
  }
});

/** 更新集合 */
collectionRouter.patch("/collections/:id", requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.uid;
    const id = paramId(req);
    const { name } = req.body;
    const result = await db.update(collections)
      .set({ name })
      .where(and(eq(collections.id, id), eq(collections.userId, userId)))
      .returning();
    if (result.length === 0) {
      return res.status(404).json({ error: "Collection not found" });
    }
    res.json(result[0]);
  } catch (error: any) {
    console.error("[API] 更新集合失败:", error);
    res.status(500).json({ error: error.message || "Failed to update collection" });
  }
});

/** 删除集合 */
collectionRouter.delete("/collections/:id", requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.uid;
    const id = paramId(req);
    // 同时删除关联表中的记录
    await db.delete(assetCollections).where(eq(assetCollections.collectionId, id));
    await db.delete(collections).where(and(eq(collections.id, id), eq(collections.userId, userId)));
    res.json({ success: true });
  } catch (error: any) {
    console.error("[API] 删除集合失败:", error);
    res.status(500).json({ error: error.message || "Failed to delete collection" });
  }
});
