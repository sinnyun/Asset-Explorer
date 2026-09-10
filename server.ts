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
import { publicRouter } from './src/server/publicRouter';
import { authRouter } from './src/server/authRouter';
import { workspaceRouter } from './src/server/workspaceRouter';
import { folderRouter } from './src/server/folderRouter';
import { tagRouter } from './src/server/tagRouter';
import { collectionRouter } from './src/server/collectionRouter';
import { assetRouter } from './src/server/assetRouter';
import { smartFolderRouter } from './src/server/smartFolderRouter';
import { storageRouter } from './src/server/storageRouter';
import { v2Router } from './src/server/v2Router';

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(cors());
  app.use(express.json({ limit: '10mb' }));

  // ==========================================================================
  // 挂载所有 API 路由
  // ==========================================================================
  app.use('/api', publicRouter);
  app.use('/api/auth', authRouter);
  app.use('/api', workspaceRouter);
  app.use('/api', folderRouter);
  app.use('/api', tagRouter);
  app.use('/api', collectionRouter);
  app.use('/api', assetRouter);
  app.use('/api', smartFolderRouter);
  app.use('/api', storageRouter);
  app.use('/api', v2Router);

  // ==========================================================================
  // Vite 开发/生产中间件
  // ==========================================================================

  if (process.env.NODE_ENV !== "production") {
    // 开发模式：使用 Vite 中间件
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
      },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // 生产模式：提供静态文件
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*all', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[API] 服务运行在 http://0.0.0.0:${PORT}`);
    console.log(`[API] 环境模式: ${process.env.APP_ENV || 'local-web'}`);
    console.log(`[API] 应用地址: ${process.env.APP_URL || 'http://localhost:3000'}`);
  });
}

startServer().catch(err => {
  console.error('[Server] Failed to start dev server:', err);
});

