import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AssetPage, AssetQuery, AssetSummary } from '../types';
import { dataService } from '../services/dataService';
import { AssetPageCache } from '../services/api/assetQueryCache';
import { normalizeAssetQuery, stableAssetQueryKey } from '../services/api/query';

const cache = new AssetPageCache(20);

export function useAssetQuery(input: AssetQuery) {
  const query = useMemo(() => normalizeAssetQuery(input), [stableAssetQueryKey(input)]);
  const queryKey = useMemo(() => stableAssetQueryKey(query), [query]);
  const [items, setItems] = useState<AssetSummary[]>(() => cache.items(queryKey));
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const loadingMore = useRef(false);

  const refresh = useCallback(() => {
    cache.invalidate(queryKey);
    setRefreshVersion(version => version + 1);
  }, [queryKey]);

  useEffect(() => {
    let disposed = false;
    const token = cache.begin(queryKey);
    setLoading(true);
    setError(null);
    dataService.queryAssets({ ...query, cursor: undefined })
      .then((page: AssetPage) => {
        if (disposed || !cache.commit(token, null, page.items)) return;
        setItems(cache.items(queryKey));
        setNextCursor(page.nextCursor);
      })
      .catch(reason => {
        if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => { disposed = true; };
  }, [queryKey, refreshVersion]);

  const loadNextPage = useCallback(async () => {
    if (!nextCursor || loadingMore.current) return;
    loadingMore.current = true;
    setLoading(true);
    setError(null);
    const cursor = nextCursor;
    const token = cache.begin(queryKey);
    try {
      const page = await dataService.queryAssets({ ...query, cursor });
      if (cache.commit(token, cursor, page.items)) {
        setItems(cache.items(queryKey));
        setNextCursor(page.nextCursor);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      loadingMore.current = false;
      setLoading(false);
    }
  }, [nextCursor, query, queryKey]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unlisten: Array<() => void> = [];
    const invalidate = () => {
      if (disposed) return;
      // Throttle invalidations during scans. File events can arrive many times
      // per second; one bounded refresh window keeps the UI live without
      // turning every event into another SQLite/HTTP page query.
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        refresh();
      }, 500);
    };
    import('@tauri-apps/api/event').then(async ({ listen }) => {
      unlisten = await Promise.all([
        listen('folder:removed', invalidate),
        listen('query:invalidated', invalidate),
        listen('scan:finished', invalidate),
        listen('asset:added', invalidate),
        listen('asset:modified', invalidate),
        listen('asset:removed', invalidate),
      ]);
    }).catch(() => undefined);
    window.addEventListener('folder:removed', invalidate);
    return () => {
      disposed = true;
      clearTimeout(timer);
      unlisten.forEach(stop => stop());
      window.removeEventListener('folder:removed', invalidate);
    };
  }, [refresh]);

  return {
    items,
    loading,
    error,
    hasNextPage: Boolean(nextCursor),
    loadNextPage,
    refresh,
  };
}
