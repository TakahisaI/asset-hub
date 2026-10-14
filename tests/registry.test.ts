import { triangleGlb, fixtureAsset } from './fixtures.ts';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, rename, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
const temp = await mkdtemp(path.join(os.tmpdir(), 'asset-hub-test-'));
process.env.ASSET_HUB_ROOT = temp;
const store = await import('../server/store.ts');
const { inspectGlb } = await import('../tools/inspect.ts');
const { createApp, apiErrors } = await import('../server/app.ts');
const { syncLock } = await import('../tools/assetctl.ts');
const bytes = triangleGlb();
const asset = await fixtureAsset(bytes);
const hash = await store.putBlob(bytes);
const inspection = await inspectGlb(bytes);
await store.registerAsset(asset);
const app = createApp();
app.use(apiErrors);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;
after(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  await rm(temp, { recursive: true, force: true });
});
const json = (method: string, body: unknown, headers: Record<string, string> = {}) => ({
  method,
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
test('valid GLB is measured, malformed and externally referenced inputs are rejected', async () => {
  assert.equal(inspection.metrics.triangles, 1);
  assert.equal(inspection.metrics.vertices, 3);
  assert.equal(inspection.qa.errors, 0);
  await assert.rejects(() => inspectGlb(triangleGlb(true)), /外部ファイル/);
  const bad = Buffer.from(bytes);
  bad.writeUInt32LE(999999, 8);
  await assert.rejects(() => inspectGlb(bad), /有効なGLB/);
});
test('reimport refuses corrupt stored bytes before registering a new asset', async () => {
  const { importGlb } = await import('../server/operations.ts');
  await writeFile(store.blobPath(hash), 'corrupt');
  try {
    await assert.rejects(() => importGlb(bytes, 'model.glb', { id: 'test.corrupt' }), /SHA-256/);
    assert.equal(await store.exists(store.assetPath('test.corrupt')), false);
    assert.equal(await readFile(store.blobPath(hash), 'utf8'), 'corrupt');
  } finally {
    await writeFile(store.blobPath(hash), bytes);
  }
});
test('catalog and binary download serve actual bytes from the hidden store', async () => {
  const r = await fetch(base + '/api/catalog?q=試験');
  const list = await r.json();
  assert.equal(list.assets.length, 1);
  assert.equal(list.assets[0].available, true);
  assert.equal('status' in list.assets[0], false);
  const binary = await fetch(base + '/api/files/' + hash);
  assert.equal(binary.status, 200);
  assert.equal(store.digest(new Uint8Array(await binary.arrayBuffer())), hash);
  const download = await fetch(base + '/api/assets/test.triangle/download');
  assert.equal(download.status, 200);
  assert.match(download.headers.get('Content-Disposition') ?? '', /test.triangle.glb/);
  const target = path.join(temp, 'external.glb');
  await rename(store.blobPath(hash), target);
  await symlink(target, store.blobPath(hash));
  try {
    const linkedCatalog = await (await fetch(base + '/api/catalog')).json();
    assert.equal(linkedCatalog.assets[0].available, true);
    const linkedDownload = await fetch(base + '/api/assets/test.triangle/download');
    assert.equal(linkedDownload.status, 200);
    assert.equal(store.digest(new Uint8Array(await linkedDownload.arrayBuffer())), hash);
  } finally {
    await rm(store.blobPath(hash));
    await rename(target, store.blobPath(hash));
  }
});
test('metadata survives reimport and stale edits cannot overwrite newer data', async () => {
  const response = await fetch(
    base + '/api/assets/test.triangle',
    json(
      'PATCH',
      { name: '自分の名前', tags: [], collections: ['custom'] },
      { 'If-Match': asset.updatedAt },
    ),
  );
  assert.equal(response.status, 200);
  const stale = await fetch(
    base + '/api/assets/test.triangle',
    json('PATCH', { name: '古い画面' }, { 'If-Match': asset.updatedAt }),
  );
  assert.equal(stale.status, 409);
  await store.registerAsset({ ...asset, updatedAt: new Date().toISOString() });
  const saved = await store.getAsset(asset.id);
  assert.equal(saved.name, '自分の名前');
  assert.ok(saved.collections.includes('custom'));
  assert.deepEqual(saved.tags, []);
  assert.deepEqual(saved.collections, ['custom']);
  assert.equal(saved.revision, hash);
});
test('concurrent notes persist, bind to a revision and can be resolved', async () => {
  const responses = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      fetch(
        base + '/api/assets/test.triangle/notes',
        json('POST', {
          text: 'メモ ' + i,
          revision: hash,
          camera: { position: [2, 2, 2], target: [0, 0, 0] },
        }),
      ),
    ),
  );
  assert.ok(responses.every((r) => r.status === 201));
  const notes = await store.getNotes(asset.id);
  assert.equal(notes.length, 8);
  assert.ok(notes.every((n) => n.revision === hash));
  const resolved = await fetch(
    base + `/api/assets/test.triangle/notes/${notes[0].id}`,
    json('PATCH', { resolved: true }),
  );
  assert.equal(resolved.status, 200);
  assert.equal((await store.getNotes(asset.id))[0].resolved, true);
  const invalid = await fetch(
    base + '/api/assets/test.triangle/notes',
    json('POST', { text: 'bad', revision: 'f'.repeat(64) }),
  );
  assert.equal(invalid.status, 400);
});
test('local API rejects foreign writes, invalid IDs and status fields', async () => {
  assert.equal(
    (
      await fetch(
        base + '/api/assets/test.triangle',
        json('PATCH', { name: 'hijack' }, { Origin: 'https://example.com' }),
      )
    ).status,
    403,
  );
  assert.equal(
    (await fetch(base + '/api/assets/test.triangle', json('PATCH', { status: 'approved' }))).status,
    400,
  );
  assert.throws(() => store.assetPath('../escape'));
  assert.throws(() => store.blobPath('../escape'));
  assert.equal((await fetch(base + '/api/files/not-a-hash')).status, 400);
});
test('sync verifies pinned bytes and refuses tampering or overwrites', async () => {
  const lock = {
    schema: 1,
    assets: [{ id: asset.id, revision: hash, sha256: hash, variant: 'glb' }],
  };
  const out = path.join(temp, 'runtime');
  const result = await syncLock(lock, out);
  const target = path.join(out, result[0].file);
  assert.equal(store.digest(await readFile(target)), hash);
  await writeFile(target, 'tampered destination');
  await assert.rejects(() => syncLock(lock, out), /異なる内容/);
  await syncLock(lock, out, true);
  assert.equal(store.digest(await readFile(target)), hash);
  await writeFile(store.blobPath(hash), 'tampered source');
  await assert.rejects(() => syncLock(lock, path.join(temp, 'runtime2')), /SHA-256/);
  await assert.rejects(() =>
    syncLock(
      { schema: 1, assets: [{ id: '../escape', revision: hash, sha256: hash, variant: 'glb' }] },
      out,
    ),
  );
});
