import test from 'node:test';
import assert from 'node:assert/strict';
import { assetDisplayGroupKey, normalizeAssetQuery, stableAssetQueryKey } from '../src/services/api/query';
import { AssetPageCache } from '../src/services/api/assetQueryCache';
import type { AssetSummary } from '../src/types';
import { readFileSync } from 'node:fs';
import { ThumbnailMemoryCache } from '../src/services/thumbnailMemoryCache';
import { calculateVirtualRange } from '../src/components/virtualRange';
import { initialSplitState, splitViewReducer } from '../src/components/splitViewState';
import { captureScrollPosition } from '../src/components/scrollPosition';
import { buildGroupedAssetItems } from '../src/components/groupedAssetModel';
import type { Asset, Folder } from '../src/types';
import { collectFolderSubtreeIds, folderSummaryToFolder, mergeFolderSummaries } from '../src/services/folderTree';
import { clampPanelWidth, readPanelLayout, writePanelLayout } from '../src/services/panelLayout';
import { calculateResizeWidth } from '../src/hooks/useResizablePanel';

test('panel widths are clamped and persisted safely', () => {
  assert.equal(clampPanelWidth(100, 240, 520), 240);
  assert.equal(clampPanelWidth(700, 240, 520), 520);
  assert.equal(clampPanelWidth(360, 240, 520), 360);

  const storage = new Map<string, string>();
  const store = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  };
  assert.deepEqual(readPanelLayout(store), {});
  writePanelLayout(store, { leftWidth: 360, rightWidth: 420 });
  assert.deepEqual(readPanelLayout(store), { leftWidth: 360, rightWidth: 420 });
  storage.set('assethub.panel-layout', '{"leftWidth":-1,"rightWidth":"wide"}');
  assert.deepEqual(readPanelLayout(store), {});
});

test('resize width follows pointer movement for both panel directions', () => {
  assert.equal(calculateResizeWidth('left', 300, 100, 140, 240, 520), 340);
  assert.equal(calculateResizeWidth('right', 400, 900, 840, 280, 560), 460);
  assert.equal(calculateResizeWidth('left', 300, 0, -100, 240, 520), 240);
  assert.equal(calculateResizeWidth('right', 400, 1000, 0, 280, 560), 560);
});

test('all properties panel variants fill the resized right panel', () => {
  for (const name of ['FolderProperties', 'TagProperties', 'CollectionProperties', 'SmartFolderProperties']) {
    const source = readFileSync(new URL(`../src/components/properties/${name}.tsx`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /className="w-80\b/);
    assert.match(source, /className="w-full\b/);
  }
});

test('asset query clamps page size and removes empty optional values', () => {
  const query = normalizeAssetQuery({
    search: '   ',
    tagIds: ['tag-b', 'tag-a'],
    collectionIds: [],
    types: ['video', 'image'],
    limit: 50_000,
  });
  assert.equal(query.limit, 300);
  assert.equal(query.search, undefined);
  assert.deepEqual(query.tagIds, ['tag-a', 'tag-b']);
  assert.deepEqual(query.types, ['image', 'video']);
});

test('asset query key is stable for equivalent filter ordering', () => {
  const first = stableAssetQueryKey({ tagIds: ['b', 'a'], types: ['video', 'image'] });
  const second = stableAssetQueryKey({ types: ['image', 'video'], tagIds: ['a', 'b'] });
  assert.equal(first, second);
});

function asset(id: string, recordVersion: number): AssetSummary {
  return {
    id, recordVersion, name: id, path: `D:/${id}`, type: 'image', size: 1,
    mtimeNs: 1, rating: 0, favorite: false, tagIds: [], collectionIds: [],
  };
}

test('query cache replaces duplicate ids only with newer records', () => {
  const cache = new AssetPageCache(20);
  cache.put('query', null, [asset('a', 2), asset('b', 1)]);
  cache.put('query', 'cursor-2', [asset('a', 1), asset('c', 1)]);
  assert.deepEqual(cache.items('query').map(item => [item.id, item.recordVersion]), [
    ['a', 2], ['b', 1], ['c', 1],
  ]);
});

test('query cache evicts least recently used pages at its hard limit', () => {
  const cache = new AssetPageCache(20);
  for (let page = 0; page < 21; page += 1) {
    cache.put('query', `cursor-${page}`, [asset(String(page), 1)]);
  }
  assert.equal(cache.pageCount, 20);
  assert.equal(cache.items('query').some(item => item.id === '0'), false);
});

test('stale request generation cannot overwrite a newer query result', () => {
  const cache = new AssetPageCache(20);
  const stale = cache.begin('query');
  const current = cache.begin('query');
  assert.equal(cache.commit(stale, null, [asset('stale', 1)]), false);
  assert.equal(cache.commit(current, null, [asset('current', 1)]), true);
  assert.deepEqual(cache.items('query').map(item => item.id), ['current']);
});

test('scan monitor consumes compact progress events without asset snapshots', () => {
  const source = readFileSync(new URL('../src/hooks/useScanMonitor.ts', import.meta.url), 'utf8');
  assert.match(source, /listen[^\n]*\('scan:progress'/);
  assert.match(source, /totalFilesScanned/);
  assert.doesNotMatch(source, /scan:chunk/);
  assert.doesNotMatch(source, /normalizeAssets/);
});

test('main workspace distinguishes loading, error, empty, and more-page states', () => {
  const source = readFileSync(new URL('../src/components/MainArea.tsx', import.meta.url), 'utf8');
  assert.match(source, /queryLoading/);
  assert.match(source, /queryError/);
  assert.match(source, /hasNextPage/);
  assert.match(source, /onLoadNextPage/);
});

test('assets without a loaded folder share one stable display group', () => {
  const first = assetDisplayGroupKey({ folderId: undefined, path: 'D:/assets/a.png' });
  const second = assetDisplayGroupKey({ folderId: undefined, path: 'D:/assets/b.png' });
  assert.equal(first, second);
});

test('asset preview never requests a whole-file base64 payload', () => {
  const source = readFileSync(new URL('../src/components/preview/assetPreviewSource.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /read_file_base64/);
  assert.doesNotMatch(source, /readLocalFileAsDataUrl/);
  assert.match(source, /convertFileSrc/);
});

test('thumbnail memory cache is LRU bounded and releases evicted urls', () => {
  const released: string[] = [];
  const cache = new ThumbnailMemoryCache(2, url => released.push(url));
  cache.set('a', 'blob:a');
  cache.set('b', 'blob:b');
  assert.equal(cache.get('a'), 'blob:a');
  cache.set('c', 'blob:c');
  assert.equal(cache.size, 2);
  assert.equal(cache.get('b'), undefined);
  assert.deepEqual(released, ['blob:b']);
});

test('thumbnail component requests work only near the viewport', () => {
  const source = readFileSync(new URL('../src/components/ThumbnailImage.tsx', import.meta.url), 'utf8');
  assert.match(source, /IntersectionObserver/);
  assert.match(source, /rootMargin/);
});

test('virtual range is clamped and renders only viewport plus overscan', () => {
  assert.deepEqual(calculateVirtualRange({
    itemCount: 10_000,
    columnCount: 5,
    rowHeight: 200,
    viewportHeight: 600,
    scrollOffset: 10_000,
    overscanRows: 2,
  }), {
    startRow: 48,
    endRow: 55,
    startIndex: 240,
    endIndex: 275,
    totalRows: 2_000,
  });

  const end = calculateVirtualRange({
    itemCount: 12,
    columnCount: 4,
    rowHeight: 100,
    viewportHeight: 250,
    scrollOffset: 99_999,
    overscanRows: 4,
  });
  assert.equal(end.endIndex, 12);
  assert.ok(end.startIndex >= 0);
});

test('split workspace keeps independent query state per column', () => {
  const initial = initialSplitState('left-root', 'right-root');
  const leftChanged = splitViewReducer(initial, { type: 'search', column: 'left', value: 'photo' });
  assert.equal(leftChanged.left.search, 'photo');
  assert.equal(leftChanged.right.search, '');
  assert.equal(leftChanged.right.folderId, 'right-root');

  const rightChanged = splitViewReducer(leftChanged, { type: 'folder', column: 'right', value: 'right-child' });
  assert.equal(rightChanged.left.folderId, 'left-root');
  assert.equal(rightChanged.right.folderId, 'right-child');
});

test('scroll handlers capture currentTarget before React releases the event', () => {
  let update: ((state: { scrollTop: number }) => { scrollTop: number }) | undefined;
  const event: { currentTarget: { scrollTop: number } | null } = { currentTarget: { scrollTop: 240 } };
  captureScrollPosition(next => { update = next; }, event);
  event.currentTarget = null;
  assert.deepEqual(update?.({ scrollTop: 0 }), { scrollTop: 240 });
});

test('folder summaries are converted into and merged with the sidebar folder cache', () => {
  const existing = folderSummaryToFolder({
    id: 'root', name: 'Root', path: 'D:/Root', isMonitored: true,
    assetCount: 2, hasChildren: true, recordVersion: 1,
  });
  const merged = mergeFolderSummaries([existing], [
    { id: 'root', name: 'Root renamed', path: 'D:/Root', isMonitored: true, assetCount: 4, hasChildren: true, recordVersion: 2 },
    { id: 'child', name: 'Child', path: 'D:/Root/Child', parentId: 'root', isMonitored: false, assetCount: 1, hasChildren: false, recordVersion: 1 },
  ]);
  assert.deepEqual(merged.map(folder => folder.id), ['root', 'child']);
  assert.equal(merged[0].name, 'Root renamed');
  assert.deepEqual(merged[0].tags, []);
});

test('removing a folder also removes its loaded descendant state', () => {
  const folders = [
    groupedFolder('root', 'D:/Root'),
    { ...groupedFolder('child', 'D:/Root/Child'), parentId: 'root' },
    { ...groupedFolder('grandchild', 'D:/Root/Child/Grandchild'), parentId: 'child' },
    groupedFolder('sibling', 'D:/Sibling'),
  ];
  assert.deepEqual([...collectFolderSubtreeIds(folders, 'root')].sort(), ['child', 'grandchild', 'root']);
});

test('main workspace wires folder results into the folder view', () => {
  const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const mainSource = readFileSync(new URL('../src/components/MainArea.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(appSource, /const filteredFolders: import\('\.\/types'\)\.Folder\[\] = \[\];/);
  assert.match(mainSource, /filteredFolders/);
  assert.match(mainSource, /onContextMenuFolder/);
});

test('asset query contract carries tag and collection ids for cards', () => {
  const typesSource = readFileSync(new URL('../src/types.ts', import.meta.url), 'utf8');
  const routerSource = readFileSync(new URL('../src/server/v2Router.ts', import.meta.url), 'utf8');
  assert.match(typesSource, /interface AssetSummary[\s\S]*tagIds: string\[\]/);
  assert.match(typesSource, /interface AssetSummary[\s\S]*collectionIds: string\[\]/);
  assert.match(routerSource, /assetTags/);
  assert.match(routerSource, /assetCollections/);
});

test('folder and split views preserve compact metadata', () => {
  const treeSource = readFileSync(new URL('../src/components/sidebar/FolderRender.tsx', import.meta.url), 'utf8');
  const splitSource = readFileSync(new URL('../src/components/MonitoredSplitView.tsx', import.meta.url), 'utf8');
  const querySource = readFileSync(new URL('../src/hooks/useAssetQuery.ts', import.meta.url), 'utf8');
  assert.match(treeSource, /folder\.hasChildren/);
  assert.match(splitSource, /item\.tagIds/);
  assert.match(splitSource, /tagLabels/);
  assert.doesNotMatch(querySource, /listen\('scan:progress', invalidate\)/);
});

test('folder removal invalidates both the folder and asset query caches', () => {
  const dataServiceSource = readFileSync(new URL('../src/services/dataService.ts', import.meta.url), 'utf8');
  const assetQuerySource = readFileSync(new URL('../src/hooks/useAssetQuery.ts', import.meta.url), 'utf8');
  const folderQuerySource = readFileSync(new URL('../src/hooks/useFolderQuery.ts', import.meta.url), 'utf8');
  assert.match(dataServiceSource, /await apiClient\.deleteFolder\(id\)/);
  assert.match(assetQuerySource, /folder:removed/);
  assert.match(folderQuerySource, /folder:removed/);
});

function groupedAsset(id: string, folderId: string): Asset {
  return {
    id, name: id, path: `D:/${id}`, type: 'image', size: 1, folderId,
    dateModified: '2026-01-01T00:00:00.000Z', dateAdded: '2026-01-01T00:00:00.000Z',
    tags: [], collections: [],
  };
}

function groupedFolder(id: string, path: string): Folder {
  return { id, name: id, path, isMonitored: false, tags: [], collections: [] };
}

test('grouped asset model keeps headers, groups assets, and hides collapsed assets', () => {
  const items = buildGroupedAssetItems(
    [groupedAsset('b', 'folder-b'), groupedAsset('a', 'folder-a'), groupedAsset('deep', 'folder-deep'), groupedAsset('unknown', '')],
    [groupedFolder('folder-b', 'D:/B'), groupedFolder('folder-a', 'D:/A')],
    ['folder-a'],
  );
  assert.deepEqual(items.map(item => item.kind === 'header' ? `${item.kind}:${item.groupId}:${item.assetCount}` : `${item.kind}:${item.asset.id}`), [
    'header:folder-deep:1', 'asset:deep',
    'header:folder-a:1',
    'header:folder-b:1', 'asset:b',
    'header:__unassigned__:1', 'asset:unknown',
  ]);
});

test('main area routes standard assets through the grouped virtual view', () => {
  const source = readFileSync(new URL('../src/components/MainArea.tsx', import.meta.url), 'utf8');
  assert.match(source, /VirtualGroupedAssetView/);
  assert.match(source, /collapsedGroupIds/);
  assert.match(source, /onToggleGroupCollapse/);
});

test('grouped virtual view captures scroll position before React releases the event', () => {
  const source = readFileSync(new URL('../src/components/VirtualGroupedAssetView.tsx', import.meta.url), 'utf8');
  assert.match(source, /captureScrollPosition/);
});

test('grouped cards keep the legacy tag and collection badge treatment', () => {
  const source = readFileSync(new URL('../src/components/VirtualGroupedAssetView.tsx', import.meta.url), 'utf8');
  assert.match(source, /AdaptiveTagRow/);
  assert.match(source, /bg-amber-500\/10/);
  assert.match(source, /asset\.collections\.length - 1/);
  assert.match(source, /无标签/);
});
