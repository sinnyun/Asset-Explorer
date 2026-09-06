import express from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth.ts';
import { getOrCreateUser } from '../db/users.ts';

export const authRouter = express.Router();

/** 认证同步用户信息 */
authRouter.post("/sync", requireAuth, async (req: AuthRequest, res) => {
  try {
    const user = req.user!;
    const dbUser = await getOrCreateUser(user.uid, user.email || '');
    res.json(dbUser);
  } catch (error: any) {
    console.error("[API] 同步用户失败:", error);
    res.status(500).json({ error: error.message || "Failed to sync user" });
  }
});
