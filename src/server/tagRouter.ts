import express from 'express';
import { db } from '../db/index.ts';
import { tags, assetTags } from '../db/schema.ts';
import { eq, and, asc } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { requireAuth, AuthRequest } from '../middleware/auth.ts';

export const tagRouter = express.Router();

/** Express 5 路由参数提取辅助 */
function paramId(req: express.Request): string {
  return String(req.params.id);
}

/** 获取所有标签 */
tagRouter.get("/tags", requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.uid;
    const allTags = await db.select()
      .from(tags)
      .where(eq(tags.userId, userId))
      .orderBy(asc(tags.name));
    res.json(allTags);
  } catch (error: any) {
    console.error("[API] 获取标签失败:", error);
    res.status(500).json({ error: error.message || "Failed to get tags" });
  }
});

/** 创建标签 */
tagRouter.post("/tags", requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.uid;
    const { name, color } = req.body;
    const newTag = {
      id: randomUUID(),
      userId,
      name,
      color: color || '#6366f1',
      usageCount: 0,
    };
    const result = await db.insert(tags).values(newTag).returning();
    res.json(result[0]);
  } catch (error: any) {
    console.error("[API] 创建标签失败:", error);
    res.status(500).json({ error: error.message || "Failed to create tag" });
  }
});

/** 更新标签 */
tagRouter.patch("/tags/:id", requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.uid;
    const id = paramId(req);
    const updates = req.body;
    const result = await db.update(tags)
      .set(updates)
      .where(and(eq(tags.id, id), eq(tags.userId, userId)))
      .returning();
    if (result.length === 0) {
      return res.status(404).json({ error: "Tag not found" });
    }
    res.json(result[0]);
  } catch (error: any) {
    console.error("[API] 更新标签失败:", error);
    res.status(500).json({ error: error.message || "Failed to update tag" });
  }
});

/** 删除标签 */
tagRouter.delete("/tags/:id", requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.uid;
    const id = paramId(req);
    // 同时删除关联表中的记录
    await db.delete(assetTags).where(eq(assetTags.tagId, id));
    await db.delete(tags).where(and(eq(tags.id, id), eq(tags.userId, userId)));
    res.json({ success: true });
  } catch (error: any) {
    console.error("[API] 删除标签失败:", error);
    res.status(500).json({ error: error.message || "Failed to delete tag" });
  }
});
