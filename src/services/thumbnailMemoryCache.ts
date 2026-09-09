export class ThumbnailMemoryCache {
  private readonly entries = new Map<string, string>();

  constructor(
    private readonly capacity = 256,
    private readonly release: (url: string) => void = releaseObjectUrl,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  get(key: string): string | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, value: string): void {
    const previous = this.entries.get(key);
    this.entries.delete(key);
    if (previous && previous !== value) this.release(previous);
    this.entries.set(key, value);
    while (this.entries.size > Math.max(1, this.capacity)) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const evicted = this.entries.get(oldest);
      this.entries.delete(oldest);
      if (evicted) this.release(evicted);
    }
  }

  delete(key: string): void {
    const value = this.entries.get(key);
    this.entries.delete(key);
    if (value) this.release(value);
  }
}

function releaseObjectUrl(url: string): void {
  if (url.startsWith('blob:') && typeof URL !== 'undefined') URL.revokeObjectURL(url);
}
