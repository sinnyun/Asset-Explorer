import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeOffsetCursor, encodeOffsetCursor, normalizeV2PageLimit } from '../src/server/v2Contract';
import { readFileSync } from 'node:fs';

test('web v2 contract clamps every page to the desktop maximum', () => {
  assert.equal(normalizeV2PageLimit(undefined), 100);
  assert.equal(normalizeV2PageLimit(0), 1);
  assert.equal(normalizeV2PageLimit(50_000), 300);
});

test('web v2 offset cursor is opaque and rejects malformed values', () => {
  const cursor = encodeOffsetCursor(300);
  assert.notEqual(cursor, '300');
  assert.equal(decodeOffsetCursor(cursor), 300);
  assert.throws(() => decodeOffsetCursor('not-a-cursor'));
});

test('web server mounts bounded v2 endpoints and favorite is persisted', () => {
  const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
  const router = readFileSync(new URL('../src/server/v2Router.ts', import.meta.url), 'utf8');
  const provider = readFileSync(new URL('../src/services/api/providers/web.ts', import.meta.url), 'utf8');
  assert.match(server, /v2Router/);
  assert.match(router, /\/v2\/assets\/query/);
  assert.match(router, /normalizeV2PageLimit/);
  assert.match(router, /\/v2\/assets\/mutate/);
  assert.match(router, /mutation conflict/);
  assert.match(provider, /\/api\/v2\/assets\/mutate/);
  assert.match(provider, /operationId: crypto\.randomUUID\(\)/);
  assert.doesNotMatch(provider, /schema 暂无收藏字段/);
});
