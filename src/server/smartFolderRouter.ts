import express from 'express';
import { db } from '../db/index.ts';
import { smartFolders } from '../db/schema.ts';
import { eq, and, asc } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { requireAuth, AuthRequest } from '../middleware/auth.ts';

export const smartFolderRouter = express.Router();

/** Express 5 路由参数提取辅助 */
function paramId(req: express.Request): string {
  return String(req.params.id);
}

/** 获取所有智能文件夹 */
smartFolderRouter.get("/smart-folders", requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.uid;
    const allSmartFolders = await db.select()
      .from(smartFolders)
      .where(eq(smartFolders.userId, userId))
      .orderBy(asc(smartFolders.name));
    res.json(allSmartFolders);
  } catch (error: any) {
    console.error("[API] 获取智能文件夹失败:", error);
    res.status(500).json({ error: error.message || "Failed to get smart folders" });
  }
});

/** 创建或更新智能文件夹 */
smartFolderRouter.post("/smart-folders", requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.uid;
    const { id, name, matchAll, rulesJson } = req.body;

    if (id) {
      // 更新已有智能文件夹
      const result = await db.update(smartFolders)
        .set({ name, matchAll, rulesJson })
        .where(and(eq(smartFolders.id, id), eq(smartFolders.userId, userId)))
        .returning();
      if (result.length === 0) {
        return res.status(404).json({ error: "Smart folder not found" });
      }
      return res.json(result[0]);
    }

    // 创建新智能文件夹
    const newSmartFolder = {
      id: randomUUID(),
      userId,
      name,
      matchAll: matchAll ?? true,
      rulesJson: rulesJson ?? '[]',
    };
    const result = await db.insert(smartFolders).values(newSmartFolder).returning();
    res.json(result[0]);
  } catch (error: any) {
    console.error("[API] 保存智能文件夹失败:", error);
    res.status(500).json({ error: error.message || "Failed to save smart folder" });
  }
});

/** 删除智能文件夹 */
smartFolderRouter.delete("/smart-folders/:id", requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.uid;
    const id = paramId(req);
    await db.delete(smartFolders)
      .where(and(eq(smartFolders.id, id), eq(smartFolders.userId, userId)));
    res.json({ success: true });
  } catch (error: any) {
    console.error("[API] 删除智能文件夹失败:", error);
    res.status(500).json({ error: error.message || "Failed to delete smart folder" });
  }
});
