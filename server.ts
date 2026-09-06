/**
 * ============================================================================
 * 模块：Express API 服务主入口 (server.ts)
 * 职责：
 * 1. 提供 RESTful API 端点，供前端 Web 模式调用进行数据操作。
 * 2. 远程 Web 环境时，前端通过此 API 连接 PostgreSQL 数据库。
 * 3. 本地开发时，前端通过此 API 进行开发调试。
 * 4. 桌面 Tauri 环境时，前端直接通过 Rust IPC 操作 SQLite，此服务不启动。
 * ============================================================================
 */

import 'dotenv/config';
import express from "express";
import path from "path";
import cors from "cors";
import { createServer as createViteServer } from "vite";
import { requireAuth, AuthRequest } from './src/middleware/auth.ts';
import { getOrCreateUser } from './src/db/users.ts';
import { db } from './src/db/index.ts';
import {
  users, folders, tags, collections, assets,
  assetTags, assetCollections, smartFolders
} from './src/db/schema.ts';
import { eq, and, asc, desc, count } from 'drizzle-orm';
import { randomUUID } from 'crypto';

/** Express 5 路由参数提取辅助 */
function paramId(req: express.Request): string {
  return String(paramId(req));
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(express.json({ limit: '10mb' }));

  // ==========================================================================
  // 公开 API 路由（无需认证）
  // ==========================================================================

  /**
   * 健康检查端点
   */
  app.get("/api/health", (req, res) => {
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      environment: process.env.APP_ENV || 'local-web',
      appUrl: process.env.APP_URL || 'http://localhost:3000',
    });
  });

  /**
   * 获取环境配置信息（前端用于检测运行环境）
   */
  app.get("/api/environment", (req, res) => {
    res.type('application/json').json({
      appEnv: process.env.APP_ENV || 'local-web',
      appUrl: process.env.APP_URL || 'http://localhost:3000',
      hasGeminiKey: !!process.env.GEMINI_API_KEY,
      serverTime: new Date().toISOString(),
    });
  });

  // ==========================================================================
  // 认证相关 API 路由
  // ==========================================================================

  /**
   * 认证同步用户信息
   */
  app.post("/api/auth/sync", requireAuth, async (req: AuthRequest, res) => {
    try {
      const user = req.user!;
      const dbUser = await getOrCreateUser(user.uid, user.email || '');
      res.json(dbUser);
    } catch (error: any) {
      console.error("[API] 同步用户失败:", error);
      res.status(500).json({ error: error.message || "Failed to sync user" });
    }
  });

  // ==========================================================================
  // 工作区 API（聚合数据加载）
  // ==========================================================================

  /**
   * 获取完整工作区数据（文件夹、标签、集合、资产、智能文件夹）
   * 用于前端首次加载时一次性获取所有数据
   */
  app.get("/api/workspace", requireAuth, async (req: AuthRequest, res) => {
    try {
      const userId = req.user!.uid;

      const [allFolders, allTags, allCollections, allAssets, allSmartFolders] = await Promise.all([
        db.select().from(folders).where(eq(folders.userId, userId)).orderBy(asc(folders.name)),
        db.select().from(tags).where(eq(tags.userId, userId)).orderBy(asc(tags.name)),
        db.select().from(collections).where(eq(collections.userId, userId)).orderBy(asc(collections.name)),
        db.select().from(assets).where(eq(assets.userId, userId)).orderBy(desc(assets.dateModified)),
        db.select().from(smartFolders).where(eq(smartFolders.userId, userId)).orderBy(asc(smartFolders.name)),
      ]);

      // 处理日期字段序列化（Drizzle 返回 Date 对象，需转为字符串）
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

  // ==========================================================================
  // 文件夹 API
  // ==========================================================================

  /**
   * 获取所有文件夹
   */
  app.get("/api/folders", requireAuth, async (req: AuthRequest, res) => {
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

  /**
   * 创建文件夹
   */
  app.post("/api/folders", requireAuth, async (req: AuthRequest, res) => {
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

  /**
   * 重命名文件夹
   */
  app.patch("/api/folders/:id", requireAuth, async (req: AuthRequest, res) => {
    try {
      const userId = req.user!.uid;
      const id = paramId(req)
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

  /**
   * 删除文件夹
   */
  app.delete("/api/folders/:id", requireAuth, async (req: AuthRequest, res) => {
    try {
      const userId = req.user!.uid;
      const id = paramId(req)
      await db.delete(folders)
        .where(and(eq(folders.id, id), eq(folders.userId, userId)));
      res.json({ success: true });
    } catch (error: any) {
      console.error("[API] 删除文件夹失败:", error);
      res.status(500).json({ error: error.message || "Failed to delete folder" });
    }
  });

  // ==========================================================================
  // 标签 API
  // ==========================================================================

  /**
   * 获取所有标签
   */
  app.get("/api/tags", requireAuth, async (req: AuthRequest, res) => {
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

  /**
   * 创建标签
   */
  app.post("/api/tags", requireAuth, async (req: AuthRequest, res) => {
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

  /**
   * 更新标签
   */
  app.patch("/api/tags/:id", requireAuth, async (req: AuthRequest, res) => {
    try {
      const userId = req.user!.uid;
      const id = paramId(req)
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

  /**
   * 删除标签
   */
  app.delete("/api/tags/:id", requireAuth, async (req: AuthRequest, res) => {
    try {
      const userId = req.user!.uid;
      const id = paramId(req)
      // 同时删除关联表中的记录
      await db.delete(assetTags).where(eq(assetTags.tagId, id));
      await db.delete(tags).where(and(eq(tags.id, id), eq(tags.userId, userId)));
      res.json({ success: true });
    } catch (error: any) {
      console.error("[API] 删除标签失败:", error);
      res.status(500).json({ error: error.message || "Failed to delete tag" });
    }
  });

  // ==========================================================================
  // 集合 API
  // ==========================================================================

  /**
   * 获取所有集合
   */
  app.get("/api/collections", requireAuth, async (req: AuthRequest, res) => {
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

  /**
   * 创建集合
   */
  app.post("/api/collections", requireAuth, async (req: AuthRequest, res) => {
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

  /**
   * 更新集合
   */
  app.patch("/api/collections/:id", requireAuth, async (req: AuthRequest, res) => {
    try {
      const userId = req.user!.uid;
      const id = paramId(req)
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

  /**
   * 删除集合
   */
  app.delete("/api/collections/:id", requireAuth, async (req: AuthRequest, res) => {
    try {
      const userId = req.user!.uid;
      const id = paramId(req)
      // 同时删除关联表中的记录
      await db.delete(assetCollections).where(eq(assetCollections.collectionId, id));
      await db.delete(collections).where(and(eq(collections.id, id), eq(collections.userId, userId)));
      res.json({ success: true });
    } catch (error: any) {
      console.error("[API] 删除集合失败:", error);
      res.status(500).json({ error: error.message || "Failed to delete collection" });
    }
  });

  // ==========================================================================
  // 资产 API
  // ==========================================================================

  /**
   * 获取所有资产
   */
  app.get("/api/assets", requireAuth, async (req: AuthRequest, res) => {
    try {
      const userId = req.user!.uid;
      const allAssets = await db.select()
        .from(assets)
        .where(eq(assets.userId, userId))
        .orderBy(desc(assets.dateModified));

      // 序列化日期字段
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

  /**
   * 更新资产评分
   */
  app.patch("/api/assets/:id/rating", requireAuth, async (req: AuthRequest, res) => {
    try {
      const userId = req.user!.uid;
      const id = paramId(req)
      const { rating } = req.body;
      // 注意：assets 表 schema 中没有 rating 字段，此处保留 API 以便后续扩展
      res.json({ success: true, id, rating });
    } catch (error: any) {
      console.error("[API] 更新资产评分失败:", error);
      res.status(500).json({ error: error.message || "Failed to update asset rating" });
    }
  });

  /**
   * 批量删除资产
   */
  app.post("/api/assets/batch-delete", requireAuth, async (req: AuthRequest, res) => {
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

  // ==========================================================================
  // 智能文件夹 API
  // ==========================================================================

  /**
   * 获取所有智能文件夹
   */
  app.get("/api/smart-folders", requireAuth, async (req: AuthRequest, res) => {
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

  /**
   * 创建或更新智能文件夹
   */
  app.post("/api/smart-folders", requireAuth, async (req: AuthRequest, res) => {
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

  /**
   * 删除智能文件夹
   */
  app.delete("/api/smart-folders/:id", requireAuth, async (req: AuthRequest, res) => {
    try {
      const userId = req.user!.uid;
      const id = paramId(req)
      await db.delete(smartFolders)
        .where(and(eq(smartFolders.id, id), eq(smartFolders.userId, userId)));
      res.json({ success: true });
    } catch (error: any) {
      console.error("[API] 删除智能文件夹失败:", error);
      res.status(500).json({ error: error.message || "Failed to delete smart folder" });
    }
  });

  // ==========================================================================
  // 存储统计 API
  // ==========================================================================

  /**
   * 获取存储统计信息
   */
  app.get("/api/storage/stats", requireAuth, async (req: AuthRequest, res) => {
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

  // ==========================================================================
  // Vite 开发/生产中间件
  // ==========================================================================

  if (process.env.NODE_ENV !== "production") {
    // 开发模式：使用 Vite 中间件提供前端热更新
    // 显式指定 HMR 端口为 3001，避免与默认端口 24678 冲突
    // （之前进程退出后端口 24678 可能残留占用，导致 HMR WebSocket 无法启动）
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: { port: 3001 },
      },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // 生产模式：提供静态文件
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[API] 服务运行在 http://0.0.0.0:${PORT}`);
    console.log(`[API] 环境模式: ${process.env.APP_ENV || 'local-web'}`);
    console.log(`[API] 应用地址: ${process.env.APP_URL || 'http://localhost:3000'}`);
  });
}

startServer();