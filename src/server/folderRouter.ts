import express from 'express';
import { db } from '../db/index.ts';
import { folders } from '../db/schema.ts';
import { eq, and, asc, sql } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { requireAuth, AuthRequest } from '../middleware/auth.ts';

export const folderRouter = express.Router();

/** Express 5 路由参数提取辅助 */
function paramId(req: express.Request): string {
  return String(req.params.id);
}

/** 获取所有文件夹 */
folderRouter.get("/folders", requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.uid;
    const allFolders = await db.select()
      .from(folders)
      .where(eq(folders.userId, userId))
      .orderBy(asc(folders.name));
    res.json(allFolders);
  } catch (error: any) {
    console.error("[API] 获取文件夹失败:", error);
    res.status(500).json({ error: error.message || "Failed to get folders" });
  }
});

/** 创建文件夹 */
folderRouter.post("/folders", requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.uid;
    const { name, parentId, path: folderPath } = req.body;
    const newFolder = {
      id: randomUUID(),
      userId,
      name,
      parentId: parentId || null,
      path: folderPath || '',
      assetCount: 0,
      createdAt: new Date(),
    };
    const result = await db.insert(folders).values(newFolder).returning();
    res.json(result[0]);
  } catch (error: any) {
    console.error("[API] 创建文件夹失败:", error);
    res.status(500).json({ error: error.message || "Failed to create folder" });
  }
});

/** 更新文件夹 */
folderRouter.patch("/folders/:id", requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.uid;
    const id = paramId(req);
    const { name } = req.body;
    const result = await db.update(folders)
      .set({ name })
      .where(and(eq(folders.id, id), eq(folders.userId, userId)))
      .returning();
    if (result.length === 0) {
      return res.status(404).json({ error: "Folder not found" });
    }
    res.json(result[0]);
  } catch (error: any) {
    console.error("[API] 更新文件夹失败:", error);
    res.status(500).json({ error: error.message || "Failed to update folder" });
  }
});

/** 删除文件夹 */
folderRouter.delete("/folders/:id", requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.uid;
    const id = paramId(req);
    await db.transaction(async (tx) => {
      const subtree = sql`WITH RECURSIVE descendants(id) AS (
        SELECT id FROM folders WHERE id = ${id} AND user_id = ${userId}
        UNION ALL
        SELECT f.id FROM folders f JOIN descendants d ON f.parent_id = d.id
        WHERE f.user_id = ${userId}
      ) SELECT id FROM descendants`;
      // Explicitly remove relation rows first because the web schema does not
      // rely on cascading foreign keys for asset-folder deletion.
      await tx.execute(sql`DELETE FROM asset_tags
        WHERE asset_id IN (SELECT id FROM assets WHERE user_id = ${userId} AND folder_id IN (${subtree}))`);
      await tx.execute(sql`DELETE FROM asset_collections
        WHERE asset_id IN (SELECT id FROM assets WHERE user_id = ${userId} AND folder_id IN (${subtree}))`);
      await tx.execute(sql`DELETE FROM assets
        WHERE user_id = ${userId} AND folder_id IN (${subtree})`);
      await tx.execute(sql`DELETE FROM folders
        WHERE user_id = ${userId} AND id IN (${subtree})`);
    });
    res.json({ success: true });
  } catch (error: any) {
    console.error("[API] 删除文件夹失败:", error);
    res.status(500).json({ error: error.message || "Failed to delete folder" });
  }
});
