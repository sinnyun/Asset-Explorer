import type { AssetSummary } from '../../types';

export interface QueryRequestToken {
  queryKey: string;
  generation: number;
}

interface CachedPage {
  queryKey: string;
  cursor: string | null;
  items: AssetSummary[];
}

export class AssetPageCache {
  private readonly pages = new Map<string, CachedPage>();
  private readonly generations = new Map<string, number>();

  constructor(private readonly maxPages = 20) {}

  get pageCount(): number {
    return this.pages.size;
  }

  begin(queryKey: string): QueryRequestToken {
    const generation = (this.generations.get(queryKey) ?? 0) + 1;
    this.generations.set(queryKey, generation);
    return { queryKey, generation };
  }

  commit(token: QueryRequestToken, cursor: string | null, items: AssetSummary[]): boolean {
    if (this.generations.get(token.queryKey) !== token.generation) return false;
    this.put(token.queryKey, cursor, items);
    return true;
  }

  put(queryKey: string, cursor: string | null, items: AssetSummary[]): void {
    const key = pageKey(queryKey, cursor);
    this.pages.delete(key);
    this.pages.set(key, { queryKey, cursor, items: items.slice(0, 300) });
    while (this.pages.size > Math.max(1, this.maxPages)) {
      const oldest = this.pages.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.pages.delete(oldest);
    }
  }

  items(queryKey: string): AssetSummary[] {
    const merged = new Map<string, AssetSummary>();
    for (const page of this.pages.values()) {
      if (page.queryKey !== queryKey) continue;
      for (const item of page.items) {
        const existing = merged.get(item.id);
        if (!existing || item.recordVersion > existing.recordVersion) {
          merged.set(item.id, item);
        }
      }
    }
    return [...merged.values()];
  }

  invalidate(queryKey: string): void {
    this.generations.set(queryKey, (this.generations.get(queryKey) ?? 0) + 1);
    for (const [key, page] of this.pages) {
      if (page.queryKey === queryKey) this.pages.delete(key);
    }
  }
}

function pageKey(queryKey: string, cursor: string | null): string {
  return `${queryKey}\u0000${cursor ?? ''}`;
}
