import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, stat, symlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { triangleGlb, fixtureAsset } from './fixtures.ts';

const temp = await mkdtemp(path.join(os.tmpdir(), 'asset-hub-archive-'));
process.env.ASSET_HUB_ROOT = path.join(temp, 'library');
const store = await import('../server/store.ts');
const blobs = await import('../server/blobs.ts');
const ops = await import('../server/operations.ts');
const { backupLibrary, verifyBackup, restoreBackup } = await import('../tools/backup.ts');
const { migrateStorage, doctor } = await import('../tools/maintenance.ts');
beforeEach(async () => {
  await rm(temp, { recursive: true, force: true });
  await mkdir(store.root, { recursive: true });
  delete process.env.ASSET_HUB_CACHE_MB;
});
after(() => rm(temp, { recursive: true, force: true }));

test('independent patches restore exact bytes, roll to a full base when ineffective, and protect dependencies', async () => {
  const original = randomBytes(1024 * 1024),
    v2 = Buffer.from(original),
    v3 = Buffer.from(original);
  v2.write('revision two', 1234);
  v3.write('revision three', 2345);
  const a = await blobs.putBlob(original);
  const b = await blobs.putBlob(v2, a);
  const c = await blobs.putBlob(v3, b);
  assert.equal((await blobs.getBlobRecord(b)).base, a);
  assert.equal((await blobs.getBlobRecord(c)).base, a);
  assert.ok((await blobs.getBlobRecord(c)).encodedBytes < original.length / 100);
  assert.deepEqual(await blobs.readBlob(b), v2);
  assert.deepEqual(await blobs.readBlob(c), v3);
  const unrelated = await blobs.putBlob(randomBytes(original.length), c);
  assert.equal((await blobs.getBlobRecord(unrelated)).base, undefined);
  const full = await blobs.getBlobRecord(a);
  await store.atomicJson(blobs.manifestPath(a), { ...full, base: unrelated });
  await assert.rejects(() => blobs.readBlob(c), /差分の連鎖/);
  await store.atomicJson(blobs.manifestPath(a), full);
  await writeFile(blobs.encodedPath(a), 'corrupt base');
  await assert.rejects(() => blobs.readBlob(c), /SHA-256/); // Even a warm cache cannot hide damage.
  assert.equal((await doctor()).ok, false);
});

test('bounded cache evicts without invalidating active readers; corrupt cache is rebuilt and oversized reads are temporary', async () => {
  process.env.ASSET_HUB_CACHE_MB = String(0.75);
  const a = randomBytes(512 * 1024),
    b = randomBytes(512 * 1024);
  const hashA = await blobs.putBlob(a),
    hashB = await blobs.putBlob(b);
  await blobs.withBlob(hashA, async (leased) => {
    assert.deepEqual(await blobs.readBlob(hashB), b);
    assert.deepEqual(await readFile(leased), a);
  });
  const cached = await readdir(blobs.cacheDir);
  assert.equal(cached.length, 1);
  await writeFile(path.join(blobs.cacheDir, cached[0]), 'broken cache');
  assert.deepEqual(await blobs.readBlob(hashB), b);
  process.env.ASSET_HUB_CACHE_MB = '0';
  assert.deepEqual(await blobs.readBlob(hashA), a);
  assert.deepEqual(await readdir(blobs.cacheDir), []);
  assert.deepEqual(await readdir(path.join(store.root, '.cache/work')), []);
  await blobs.verifyBlob(hashA);
});

test('same-byte discoveries are recorded without changing fixed fields; unknown data and mismatched hashes cannot be overwritten', async () => {
  const bytes = triangleGlb();
  const asset = await ops.importGlb(bytes, 'first.glb', { id: 'test.same' });
  const snapshot = await readFile(
    path.join(store.root, 'catalog/revisions', asset.id, asset.revision + '.json'),
    'utf8',
  );
  const download = { repository: 'example/models', commit: 'a'.repeat(40), path: 'different.glb' };
  const second = await ops.importGlb(
    bytes,
    'different.glb',
    { id: asset.id, download },
    asset.updatedAt,
  );
  assert.deepEqual(second.file, asset.file);
  assert.deepEqual(second.source, asset.source);
  assert.deepEqual(await ops.revisionDownloads(asset.id, asset.revision), [download]);
  assert.equal(
    await readFile(
      path.join(store.root, 'catalog/revisions', asset.id, asset.revision + '.json'),
      'utf8',
    ),
    snapshot,
  );
  await assert.rejects(
    () => store.registerAsset({ ...asset, id: 'test.bad', revision: 'b'.repeat(64) }),
    /ハッシュ/,
  );
  assert.equal(await store.exists(store.assetPath('test.bad')), false);
  const future = JSON.stringify({ ...second, futureField: 'preserve' });
  await writeFile(store.assetPath(asset.id), future);
  await assert.rejects(
    () => ops.editAsset(asset.id, { name: 'edit' }, second.updatedAt),
    /futureField/,
  );
  assert.equal(await readFile(store.assetPath(asset.id), 'utf8'), future);
});

test('backup and restore include sources, snapshots, notes and delta bases; corruption and unsafe destinations fail closed', async () => {
  const a = await ops.importGlb(triangleGlb(), 'a.glb', { id: 'test.backup' });
  await ops.addNote(a.id, { revision: a.revision, text: 'keep' });
  await ops.importGlb(triangleGlb(false, 2), 'b.glb', { id: a.id }, a.updatedAt);
  await mkdir(path.join(store.root, 'catalog/sources'), { recursive: true });
  const external = path.join(temp, 'source.blend');
  await writeFile(external, 'binary source');
  await symlink(external, path.join(store.root, 'catalog/sources/original.blend'));
  const backup = path.join(temp, 'backup');
  const saved = await backupLibrary(backup);
  const verified = await verifyBackup(backup);
  assert.equal(saved.files, verified.files.length);
  assert.ok(verified.files.some((f) => f.path === 'catalog/sources/original.blend'));
  await assert.rejects(() => backupLibrary(backup), /未作成/);
  await symlink(store.root, path.join(temp, 'alias'), 'dir');
  await assert.rejects(() => backupLibrary(path.join(temp, 'alias/new')), /重ねる/);
  const restored = path.join(temp, 'restored');
  await restoreBackup(backup, restored);
  assert.equal(
    await readFile(path.join(restored, 'catalog/sources/original.blend'), 'utf8'),
    'binary source',
  );
  const check = await promisify(execFile)(
    process.execPath,
    ['--import', 'tsx', 'tools/assetctl.ts', 'doctor'],
    { env: { ...process.env, ASSET_HUB_ROOT: restored } },
  );
  assert.equal(JSON.parse(check.stdout).ok, true);
  await assert.rejects(() => restoreBackup(backup, restored), /未作成/);
  await writeFile(path.join(backup, verified.files[0].path), 'tampered');
  await assert.rejects(() => verifyBackup(backup), /一致しません/);
  await assert.rejects(() => restoreBackup(backup, path.join(temp, 'bad-restore')), /一致しません/);
  assert.equal(await store.exists(path.join(temp, 'bad-restore')), false);
  await writeFile(
    path.join(backup, 'manifest.json'),
    JSON.stringify({
      ...verified,
      files: [{ path: 'catalog/../../escape', bytes: 0, sha256: 'a'.repeat(64) }],
    }),
  );
  await assert.rejects(() => verifyBackup(backup), /Invalid/);
});

test('migration backs up originals, verifies all versions before removing raw copies, and is repeatable', async () => {
  const bytes = triangleGlb(),
    asset = await fixtureAsset(bytes, 'test.migrate');
  await mkdir(store.storeDir, { recursive: true });
  await store.registerAsset(asset);
  const raw = path.join(store.storeDir, asset.revision + '.glb');
  await writeFile(raw, bytes);
  await assert.rejects(() => blobs.assertStorageReady(), /旧保存形式/);
  const backup = path.join(temp, 'pre-migration');
  const result = await migrateStorage(backup);
  assert.equal(result.migrated, 1);
  assert.deepEqual(await readFile(path.join(backup, '.store', asset.revision + '.glb')), bytes);
  assert.deepEqual(await blobs.readBlob(asset.revision), bytes);
  assert.equal(await store.exists(raw), false);
  assert.equal((await migrateStorage(path.join(temp, 'unused'))).migrated, 0);
  assert.equal((await doctor()).ok, true);
});

test('a failed migration keeps raw originals and the verified backup', async () => {
  const bytes = triangleGlb(),
    asset = await fixtureAsset(bytes);
  await mkdir(store.storeDir, { recursive: true });
  await store.registerAsset(asset);
  const raw = path.join(store.storeDir, asset.revision + '.glb');
  await writeFile(raw, 'damaged');
  const backup = path.join(temp, 'pre-migration');
  await assert.rejects(() => migrateStorage(backup), /元GLBのSHA-256/);
  assert.equal(await readFile(raw, 'utf8'), 'damaged');
  assert.ok((await verifyBackup(backup)).files.length);
});

test('restoring a blob cannot overwrite or remove an existing destination', async () => {
  const hash = await blobs.putBlob(triangleGlb());
  const destination = path.join(temp, 'keep.glb');
  await writeFile(destination, 'keep me');
  await assert.rejects(() => blobs.restoreBlob(hash, destination), /EEXIST/);
  assert.equal(await readFile(destination, 'utf8'), 'keep me');
});

test('backup waits for the same write transaction used by independent CLI processes', async () => {
  const asset = await ops.importGlb(triangleGlb(), 'a.glb', { id: 'test.locked' });
  const backup = path.join(temp, 'consistent-backup');
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const writer = store.withLibraryLock(async () => {
    started();
    await wait;
    await ops.editAsset(asset.id, { name: 'after transaction' }, asset.updatedAt);
  });
  await ready;
  const child = promisify(execFile)(
    process.execPath,
    ['--import', 'tsx', 'tools/assetctl.ts', 'backup', '--out', backup],
    { env: process.env },
  );
  release();
  await writer;
  await child;
  assert.equal(
    JSON.parse(await readFile(path.join(backup, 'catalog/assets', asset.id + '.json'), 'utf8'))
      .name,
    'after transaction',
  );
  await verifyBackup(backup);
});
