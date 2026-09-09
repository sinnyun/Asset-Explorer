import test from 'node:test';
import assert from 'node:assert/strict';
import { assetDisplayGroupKey, normalizeAssetQuery, stableAssetQueryKey } from '../src/services/api/query';
import { AssetPageCache } from '../src/services/api/assetQueryCache';
import type { AssetSummary } from '../src/types';
import { readFileSync } from 'node:fs';
import { ThumbnailMemoryCache } from '../src/services/thumbnailMemoryCache';

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
    mtimeNs: 1, rating: 0, favorite: false,
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
