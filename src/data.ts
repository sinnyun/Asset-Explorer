import { Asset, Folder, Tag, Collection, SmartFolder } from './types';

// Generate 150 tags
export const mockTags: Tag[] = Array.from({ length: 150 }, (_, i) => ({
  id: `t_${i}`,
  name: `Tag ${i}`,
  color: `hsl(${(i * 137.5) % 360}, 70%, 50%)`
}));

// Generate 120 collections
export const mockCollections: Collection[] = Array.from({ length: 120 }, (_, i) => ({
  id: `c_${i}`,
  name: `Collection ${i}`
}));

export const mockFolders: Folder[] = [
  { id: 'workspace', name: 'Main Workspace', path: 'C:/Workspace', isMonitored: true, tags: [], collections: [] }
];

let folderIdCounter = 0;
// 100 root level folders
for (let i = 0; i < 100; i++) {
  const rootId = `f_${folderIdCounter++}`;
  mockFolders.push({
    id: rootId,
    name: `Project Asset ${i}`,
    path: `C:/Workspace/Project Asset ${i}`,
    isMonitored: false,
    parentId: 'workspace',
    tags: [mockTags[i % mockTags.length].id],
    collections: []
  });
  
  const subCount = Math.floor(Math.random() * 4); // 0 to 3 subfolders
  for (let j = 0; j < subCount; j++) {
    const subId = `f_${folderIdCounter++}`;
    mockFolders.push({
      id: subId,
      name: `Sub Level ${j}`,
      path: `C:/Workspace/Project Asset ${i}/Sub Level ${j}`,
      isMonitored: false,
      parentId: rootId,
      tags: [],
      collections: [mockCollections[j % mockCollections.length].id]
    });
    
    if (Math.random() > 0.5) {
       const deepId = `f_${folderIdCounter++}`;
       mockFolders.push({
         id: deepId,
         name: `Deep Level`,
         path: `C:/Workspace/Project Asset ${i}/Sub Level ${j}/Deep Level`,
         isMonitored: false,
         parentId: subId,
         tags: [],
         collections: []
       });
    }
  }
}

export const mockAssets: Asset[] = [];
// Generate around 2000 assets randomly distributed
for (let i = 0; i < 2000; i++) {
  const f = mockFolders[Math.floor(Math.random() * mockFolders.length)];
  const type = Math.random() > 0.6 ? 'image' : (Math.random() > 0.5 ? 'video' : 'model');
  const isImg = type === 'image';
  const isVid = type === 'video';
  mockAssets.push({
    id: `a_${i}`,
    name: isImg ? `Asset_File_${i}_image.png` : isVid ? `Asset_File_${i}_video.mp4` : `Asset_File_${i}_model.fbx`,
    type: type,
    size: Math.floor(Math.random() * 10000000),
    dateModified: new Date(Date.now() - Math.random() * 10000000000).toISOString(),
    dateAdded: new Date().toISOString(),
    path: isImg ? `${f.path}/Asset_File_${i}_image.png` : isVid ? `${f.path}/Asset_File_${i}_video.mp4` : `${f.path}/Asset_File_${i}_model.fbx`,
    folderId: f.id,
    tags: [mockTags[Math.floor(Math.random() * mockTags.length)].id],
    collections: Math.random() > 0.7 ? [mockCollections[Math.floor(Math.random() * mockCollections.length)].id] : [],
    thumbnailUrl: isImg ? `https://picsum.photos/seed/${i}/200/200` : undefined,
    width: isImg || isVid ? Math.floor(Math.random() * 1920) + 640 : undefined,
    height: isImg || isVid ? Math.floor(Math.random() * 1080) + 480 : undefined,
    fileHash: Math.random().toString(16).substring(2) + Math.random().toString(16).substring(2),
  });
}

export const smartFolders: SmartFolder[] = [
  { id: 'sf_all', name: 'All Assets', icon: 'LayoutGrid', filter: () => true },
  { id: 'sf_recent', name: 'Recently Added', icon: 'Clock', filter: (a) => new Date(a.dateAdded).getTime() > Date.now() - 30 * 24 * 60 * 60 * 1000 },
  { id: 'sf_untagged', name: 'Untagged', icon: 'Tag', filter: (a) => a.tags.length === 0 },
  { id: 'sf_images', name: 'Images', icon: 'Image', filter: (a) => a.type === 'image' },
  { id: 'sf_models', name: '3D Models', icon: 'Box', filter: (a) => a.type === 'model' },
];
