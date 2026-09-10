const DEFAULT_PAGE_LIMIT = 100;
export const MAX_V2_PAGE_LIMIT = 300;

export function normalizeV2PageLimit(value: unknown): number {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : DEFAULT_PAGE_LIMIT;
  return Math.max(1, Math.min(MAX_V2_PAGE_LIMIT, parsed));
}

export function encodeOffsetCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ v: 1, offset }), 'utf8').toString('base64url');
}

export function decodeOffsetCursor(cursor?: string): number {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { v?: unknown; offset?: unknown };
    if (parsed.v !== 1 || typeof parsed.offset !== 'number' || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0) {
      throw new Error('invalid cursor payload');
    }
    return parsed.offset;
  } catch {
    throw new Error('Invalid V2 cursor');
  }
}
