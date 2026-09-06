import express from 'express';

export const publicRouter = express.Router();

/** 健康检查端点 */
publicRouter.get("/health", (req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    environment: process.env.APP_ENV || 'local-web',
    appUrl: process.env.APP_URL || 'http://localhost:3000',
  });
});

/** 获取环境配置信息 */
publicRouter.get("/environment", (req, res) => {
  res.type('application/json').json({
    appEnv: process.env.APP_ENV || 'local-web',
    appUrl: process.env.APP_URL || 'http://localhost:3000',
    hasGeminiKey: !!process.env.GEMINI_API_KEY,
    serverTime: new Date().toISOString(),
  });
});
