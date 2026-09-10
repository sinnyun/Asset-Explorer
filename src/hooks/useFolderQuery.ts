import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FolderPage, FolderQuery, FolderSummary } from '../types';
import { dataService } from '../services/dataService';

const PAGE_SIZE = 300;

export function useFolderQuery(input: FolderQuery) {
  const query = useMemo(() => ({ ...input, limit: Math.min(input.limit ?? PAGE_SIZE, PAGE_SIZE) }), [input.parentId, input.rootId, input.limit]);
  const key = JSON.stringify({ parentId: query.parentId ?? null, rootId: query.rootId ?? null, limit: query.limit });
  const [items, setItems] = useState<FolderSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const loadingMore = useRef(false);

  const refresh = useCallback(() => setRefreshVersion(version => version + 1), []);

  useEffect(() => {
    let disposed = false;
    setItems([]);
    setNextCursor(undefined);
    setLoading(true);
    setError(null);
    dataService.queryFolders({ ...query, cursor: undefined })
      .then((page: FolderPage) => {
        if (disposed) return;
        setItems(page.items);
        setNextCursor(page.nextCursor);
      })
      .catch(reason => { if (!disposed) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [key, refreshVersion]);

  const loadNextPage = useCallback(async () => {
    if (!nextCursor || loadingMore.current) return;
    loadingMore.current = true;
    setLoading(true);
    try {
      const page = await dataService.queryFolders({ ...query, cursor: nextCursor });
      setItems(previous => [...previous, ...page.items.filter(item => !previous.some(current => current.id === item.id))]);
      setNextCursor(page.nextCursor);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      loadingMore.current = false;
      setLoading(false);
    }
  }, [nextCursor, query]);

  useEffect(() => {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stop: (() => void) | undefined;
    import('@tauri-apps/api/event').then(async ({ listen }) => {
      const invalidate = () => {
        if (disposed) return;
        clearTimeout(timer);
        timer = setTimeout(refresh, 120);
      };
      const stops = await Promise.all([
        listen('scan:started', invalidate),
        listen('scan:finished', invalidate),
      ]);
      stop = () => stops.forEach(unlisten => unlisten());
      if (disposed) stop();
    }).catch(() => undefined);
    return () => {
      disposed = true;
      clearTimeout(timer);
      stop?.();
    };
  }, [refresh]);

  return { items, loading, error, hasNextPage: Boolean(nextCursor), loadNextPage, refresh };
}
