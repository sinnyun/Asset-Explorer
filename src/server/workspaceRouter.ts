import express from 'express';
import { requireAuth, AuthRequest } from '../middleware/auth.ts';
import { db } from '../db/index.ts';
import { folders, tags, collections, assets, smartFolders, assetTags, assetCollections } from '../db/schema.ts';
import { eq, asc, desc, inArray } from 'drizzle-orm';

export const workspaceRouter = express.Router();

/** 获取完整工作区数据（文件夹、标签、集合、资产、智能文件夹） */
workspaceRouter.get("/workspace", requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.uid;

    const [allFolders, allTags, allCollections, allAssets, allSmartFolders] = await Promise.all([
      db.select().from(folders).where(eq(folders.userId, userId)).orderBy(asc(folders.name)),
      db.select().from(tags).where(eq(tags.userId, userId)).orderBy(asc(tags.name)),
      db.select().from(collections).where(eq(collections.userId, userId)).orderBy(asc(collections.name)),
      db.select().from(assets).where(eq(assets.userId, userId)).orderBy(desc(assets.dateModified)),
      db.select().from(smartFolders).where(eq(smartFolders.userId, userId)).orderBy(asc(smartFolders.name)),
    ]);

    // 加载资产与标签/集合的关联关系
    const assetIds = allAssets.map(a => a.id);

    let assetTagRows: { assetId: string; tagId: string }[] = [];
    let assetColRows: { assetId: string; collectionId: string }[] = [];
    if (assetIds.length > 0) {
      [assetTagRows, assetColRows] = await Promise.all([
        db.select().from(assetTags).where(inArray(assetTags.assetId, assetIds)),
        db.select().from(assetCollections).where(inArray(assetCollections.assetId, assetIds)),
      ]);
    }

    // 构建 asset_id → tag_ids 映射
    const tagsByAsset = new Map<string, string[]>();
    const colsByAsset = new Map<string, string[]>();
    for (const row of assetTagRows) {
      const arr = tagsByAsset.get(row.assetId) || [];
      arr.push(row.tagId);
      tagsByAsset.set(row.assetId, arr);
    }
    for (const row of assetColRows) {
      const arr = colsByAsset.get(row.assetId) || [];
      arr.push(row.collectionId);
      colsByAsset.set(row.assetId, arr);
    }

    const serializedAssets = allAssets.map(a => ({
      ...a,
      dateModified: a.dateModified?.toISOString?.() ?? a.dateModified,
      dateAdded: a.dateAdded?.toISOString?.() ?? a.dateAdded,
      tags: tagsByAsset.get(a.id) || [],
      collections: colsByAsset.get(a.id) || [],
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

/** 一键初始化示例工作区数据（首次登录云端使用） */
workspaceRouter.post("/workspace/seed", requireAuth, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.uid;
    const existingFolders = await db.select().from(folders).where(eq(folders.userId, userId)).limit(1);
    if (existingFolders.length > 0) {
      return res.json({ success: true, message: "Workspace already has content" });
    }

    const shortId = userId.slice(0, 8);
    const folderData = [
      { id: `f_3d_${shortId}`, userId, name: "3D 模型与工程资产", path: "/Workspace/3D Models", assetCount: 2 },
      { id: `f_concept_${shortId}`, userId, name: "概念设定与场景原画", path: "/Workspace/Concept Art", assetCount: 1 },
      { id: `f_textures_${shortId}`, userId, name: "材质贴图与 PBR 贴图", path: "/Workspace/Textures", assetCount: 1 },
    ];
    await db.insert(folders).values(folderData);

    const tagData = [
      { id: `t_scifi_${shortId}`, userId, name: "科幻风格", color: "#3B82F6", usageCount: 3 },
      { id: `t_char_${shortId}`, userId, name: "角色设计", color: "#10B981", usageCount: 1 },
      { id: `t_pbr_${shortId}`, userId, name: "PBR材质", color: "#F59E0B", usageCount: 1 },
      { id: `t_fav_${shortId}`, userId, name: "精选收藏", color: "#EF4444", usageCount: 2 },
    ];
    await db.insert(tags).values(tagData);

    const colData = [
      { id: `c_orion_${shortId}`, userId, name: "猎户座主线项目", assetCount: 3 },
      { id: `c_showcase_${shortId}`, userId, name: "作品集精选", assetCount: 2 },
    ];
    await db.insert(collections).values(colData);

    const now = new Date();
    const assetData = [
      {
        id: `a_cyber_${shortId}`,
        userId,
        name: "Cyber_Warrior_Rigged.fbx",
        type: "model",
        size: 24500000,
        folderId: folderData[0].id,
        path: `${folderData[0].path}/Cyber_Warrior_Rigged.fbx`,
        thumbnailUrl: "https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=400&q=80",
        dateModified: now,
        dateAdded: now,
      },
      {
        id: `a_space_${shortId}`,
        userId,
        name: "Space_Station_Concept_4K.png",
        type: "image",
        size: 12400000,
        folderId: folderData[1].id,
        path: `${folderData[1].path}/Space_Station_Concept_4K.png`,
        thumbnailUrl: "https://images.unsplash.com/photo-1506703719100-a0f3a48c0f86?w=400&q=80",
        dateModified: now,
        dateAdded: now,
      },
      {
        id: `a_texture_${shortId}`,
        userId,
        name: "Titanium_Plate_Roughness_4K.png",
        type: "image",
        size: 18200000,
        folderId: folderData[2].id,
        path: `${folderData[2].path}/Titanium_Plate_Roughness_4K.png`,
        thumbnailUrl: "https://images.unsplash.com/photo-1607604276583-eef5d076aa5f?w=400&q=80",
        dateModified: now,
        dateAdded: now,
      },
      {
        id: `a_drone_${shortId}`,
        userId,
        name: "Recon_Scout_Drone.blend",
        type: "model",
        size: 45800000,
        folderId: folderData[0].id,
        path: `${folderData[0].path}/Recon_Scout_Drone.blend`,
        thumbnailUrl: "https://images.unsplash.com/photo-1527443224154-c4a3942d3acf?w=400&q=80",
        dateModified: now,
        dateAdded: now,
      },
    ];
    await db.insert(assets).values(assetData);

    await db.insert(assetTags).values([
      { assetId: assetData[0].id, tagId: tagData[0].id },
      { assetId: assetData[0].id, tagId: tagData[1].id },
      { assetId: assetData[1].id, tagId: tagData[0].id },
      { assetId: assetData[2].id, tagId: tagData[2].id },
      { assetId: assetData[3].id, tagId: tagData[0].id },
      { assetId: assetData[3].id, tagId: tagData[3].id },
    ]);

    await db.insert(assetCollections).values([
      { assetId: assetData[0].id, collectionId: colData[0].id },
      { assetId: assetData[1].id, collectionId: colData[0].id },
      { assetId: assetData[0].id, collectionId: colData[1].id },
    ]);

    res.json({ success: true, seeded: true });
  } catch (err: any) {
    console.error("[API] 初始化示例数据失败:", err);
    res.status(500).json({ error: err.message || "Failed to seed workspace" });
  }
});
