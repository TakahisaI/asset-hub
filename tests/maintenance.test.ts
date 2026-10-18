import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  readdir,
  stat,
  symlink,
  rename,
} from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { fixtureAsset, triangleGlb } from './fixtures.ts';

const temp = await mkdtemp(path.join(os.tmpdir(), 'asset-hub-maintenance-'));
process.env.ASSET_HUB_ROOT = temp;
const store = { ...(await import('../server/store.ts')), ...(await import('../server/blobs.ts')) };
const { getCatalog } = await import('../server/catalog.ts');
const { saveProfiles, profilePath } = await import('../server/profiles.ts');
const { profileGlb } = await import('../tools/profile.ts');
const { validateAssets } = await import('../tools/validate.ts');
const { inspectStorage } = await import('../tools/storage.ts');
const { syncLock } = await import('../tools/assetctl.ts');
assert.equal(store.root, temp);
beforeEach(async () => {
  await rm(temp, { recursive: true, force: true });
  await mkdir(temp, { recursive: true });
});
after(() => rm(temp, { recursive: true, force: true }));

async function register(id: string, scale = 1) {
  const bytes = triangleGlb(false, scale);
  const asset = await fixtureAsset(bytes, id);
  await store.putBlob(bytes);
  await store.registerAsset(asset);
  return asset;
}
async function snapshot() {
  const files = new Map<string, { bytes: string; modified: bigint }>();
  for (const directory of ['catalog', '.store']) {
    const base = path.join(temp, directory);
    for (const entry of await readdir(base, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = path.join(entry.parentPath, entry.name);
      files.set(file, {
        bytes: (await readFile(file)).toString('base64'),
        modified: (await stat(file, { bigint: true })).mtimeNs,
      });
    }
  }
  return files;
}

test('validation continues through missing, tampered and malformed records without writing catalog or snapshots', async () => {
  const missing = await register('a.missing');
  await rm(store.encodedPath(missing.file.hash));
  const tampered = await register('b.tampered', 2);
  await writeFile(store.encodedPath(tampered.file.hash), 'tampered');
  const good = await register('z.good', 3);
  await writeFile(path.join(store.assetDir, 'broken.json'), '{broken');
  const before = await snapshot();
  const result = await validateAssets();
  assert.equal(result.summary.failed, 3);
  assert.equal(result.problems.length, 1);
  assert.match(result.results.find((r) => r.id === missing.id)!.problem!, /見つかりません/);
  assert.match(result.results.find((r) => r.id === tampered.id)!.problem!, /SHA-256/);
  assert.equal(result.results.find((r) => r.id === good.id)!.inspection!.qa.errors, 0);
  const report = path.join(temp, '.cache/validation.json');
  await assert.rejects(
    promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', 'tools/validate.ts', '--json', '--report', report],
      { env: process.env },
    ),
    (error: unknown) => {
      const failure = error as Error & { code: number; stdout: string };
      assert.equal(failure.code, 1);
      assert.equal(JSON.parse(failure.stdout).summary.failed, 3);
      return true;
    },
  );
  assert.equal(JSON.parse(await readFile(report, 'utf8')).summary.assets, 3);
  assert.deepEqual(await snapshot(), before);
});

test('catalog profiles preserve measured zeros, reflect refreshes and isolate corrupt measurements', async () => {
  const asset = await register('test.profile');
  assert.equal((await getCatalog()).assets[0].profile, null);
  const profile = profileGlb(triangleGlb(false, 1));
  await saveProfiles([profile]);
  let catalog = await getCatalog();
  assert.equal(catalog.assets[0].profile?.textures.decodedBytes, 0);
  assert.equal(catalog.assets[0].profile?.glb.hash, asset.revision);
  profile.scene.drawCalls = 7;
  await saveProfiles([profile]);
  catalog = await getCatalog();
  assert.equal(catalog.assets[0].profile?.scene.drawCalls, 7);
  await writeFile(profilePath(asset.revision), '{broken');
  catalog = await getCatalog();
  assert.equal(catalog.assets.length, 1);
  assert.equal(catalog.assets[0].profile, null);
  assert.ok(catalog.assets[0].profileError);
  assert.equal(catalog.problems[0].file, `catalog/profiles/${asset.revision}.json`);
  assert.equal((await store.getAsset(asset.id)).revision, asset.revision);
});

test('report paths protect catalog and blobs through case variants and file/directory aliases', async () => {
  const asset = await register('test.model');
  const reports = path.join(temp, 'reports');
  await mkdir(reports);
  await symlink(path.join(temp, 'catalog'), path.join(reports, 'catalog-link'), 'dir');
  await symlink(store.storeDir, path.join(reports, 'store-link'), 'dir');
  await symlink(store.assetPath(asset.id), path.join(reports, 'asset-link.json'));
  await symlink(store.encodedPath(asset.revision), path.join(reports, 'blob-link.json'));
  const before = await snapshot();
  for (const target of [
    `catalog/assets/${asset.id}.json`,
    `CATALOG/assets/${asset.id}.json`,
    `.STORE/${asset.revision}.glb`,
    `reports/catalog-link/assets/${asset.id}.json`,
    `reports/store-link/${asset.revision}.glb`,
    'reports/asset-link.json',
    'reports/blob-link.json',
    'reports/catalog-link/new/nested/report.json',
    'CATALOG/new/nested/report.json',
  ]) {
    await assert.rejects(
      promisify(execFile)(
        process.execPath,
        ['--import', 'tsx', 'tools/validate.ts', '--report', path.join(temp, target)],
        { env: process.env },
      ),
      /検証レポートは catalog\/ と \.store\/ の外に保存してください/,
      target,
    );
  }
  assert.deepEqual(await snapshot(), before);
  assert.equal(await store.exists(path.join(temp, 'catalog/new')), false);

  // Protected roots can themselves be links to directories outside their logical location.
  for (const dir of ['catalog', '.store']) {
    const original = path.join(temp, dir);
    const physical = path.join(temp, dir + '-physical');
    await rename(original, physical);
    await symlink(physical, original, 'dir');
    const target =
      dir === 'catalog'
        ? path.join(physical, 'assets', asset.id + '.json')
        : path.join(physical, asset.revision + '.glb');
    await assert.rejects(
      promisify(execFile)(
        process.execPath,
        ['--import', 'tsx', 'tools/validate.ts', '--report', target],
        { env: process.env },
      ),
      /検証レポートは catalog\/ と \.store\/ の外に保存してください/,
    );
  }
  assert.deepEqual(await snapshot(), before);

  await symlink(reports, path.join(temp, 'reports-link'), 'dir');
  const output = path.join(temp, 'reports-link/new/nested/validation.json');
  for (let i = 0; i < 2; i++) {
    await promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', 'tools/validate.ts', '--report', output],
      { env: process.env },
    );
    assert.equal(JSON.parse(await readFile(output, 'utf8')).summary.assets, 1);
  }
  assert.deepEqual(await snapshot(), before);
});

test('catalog and storage follow file symlinks but exclude broken links and directory targets', async () => {
  const asset = await register('test.linked');
  const broken = await register('test.broken', 2);
  const directory = await register('test.directory', 3);
  const external = path.join(temp, 'external.glb');
  await rename(store.encodedPath(asset.revision), external);
  await symlink(external, store.encodedPath(asset.revision));
  const image = path.join(temp, 'external.png');
  await writeFile(image, 'thumbnail fixture');
  await symlink(image, path.join(store.storeDir, asset.revision + '.png'));
  await rm(store.encodedPath(broken.revision));
  await symlink(path.join(temp, 'missing.glb'), store.encodedPath(broken.revision));
  await rm(store.encodedPath(directory.revision));
  await symlink(temp, store.encodedPath(directory.revision), 'dir');

  const catalog = await getCatalog();
  assert.deepEqual(catalog.problems, []);
  assert.equal(catalog.assets.find((a) => a.id === asset.id)!.available, true);
  assert.equal(catalog.assets.find((a) => a.id === asset.id)!.thumbnail, true);
  for (const id of [broken.id, directory.id])
    assert.equal(catalog.assets.find((a) => a.id === id)!.available, false);
  const inventory = await inspectStorage();
  assert.equal(inventory.complete, true);
  assert.equal(inventory.summary.glbFiles, 1);
  assert.equal(
    inventory.summary.currentBytes,
    (await store.getBlobRecord(asset.revision)).encodedBytes,
  );
  assert.equal(inventory.summary.thumbnailBytes, (await stat(image)).size);
  assert.deepEqual(
    new Set(inventory.missing.map((file) => file.hash)),
    new Set([broken.revision, directory.revision]),
  );
  assert.deepEqual(inventory.candidates, []);

  await assert.rejects(
    promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', 'tools/validate.ts', '--report', store.encodedPath(asset.revision)],
      { env: process.env },
    ),
    /検証レポートは catalog\/ と \.store\/ の外に保存してください/,
  );
  assert.equal(
    store.digest(await readFile(external)),
    (await store.getBlobRecord(asset.revision)).encodedHash,
  );
});

test('storage inventory retains historical/shared/note-only hashes and fails closed on damaged references', async () => {
  const old = await register('test.model', 1);
  const current = await register('test.model', 2);
  await store.registerAsset({ ...current, id: 'test.shared' });
  const noteBytes = triangleGlb(false, 3);
  const noteHash = await store.putBlob(noteBytes);
  await store.saveNotes('test.removed', [
    {
      id: 'old-note',
      assetId: 'test.removed',
      revision: noteHash,
      text: '解決後も参照を残す',
      createdAt: '2026-01-01T00:00:00.000Z',
      resolved: true,
    },
  ]);
  const orphan = await store.putBlob(triangleGlb(false, 4));
  await writeFile(path.join(store.storeDir, orphan + '.png'), 'thumbnail fixture');
  const report = await inspectStorage();
  assert.equal(report.complete, true);
  assert.equal(
    report.summary.currentBytes,
    (await store.getBlobRecord(current.revision)).encodedBytes,
  ); // Deduplicated across IDs.
  assert.equal(
    report.summary.retainedHistoryBytes,
    (await store.getBlobRecord(old.revision)).encodedBytes +
      (await store.getBlobRecord(noteHash)).encodedBytes,
  );
  assert.deepEqual(
    report.candidates.map((f) => f.file),
    ['blobs/' + orphan + '.zst', orphan + '.png'],
  );
  assert.ok(await store.exists(store.encodedPath(orphan))); // Dry run means no deletions.
  await rm(store.encodedPath(old.file.hash));
  const missing = await inspectStorage();
  assert.deepEqual(
    missing.missing.map((r) => r.hash),
    [old.file.hash],
  );
  const broken = path.join(temp, 'catalog/revisions/test.model', 'f'.repeat(64) + '.json');
  await writeFile(broken, '{');
  const incomplete = await inspectStorage();
  assert.equal(incomplete.complete, false);
  assert.deepEqual(incomplete.candidates, []);
  assert.equal(incomplete.problems.length, 1);
});

test('cached catalog reflects external edits, new/resolved notes and file removal; damaged records stay isolated', async () => {
  const asset = await register('test.cached');
  assert.equal((await getCatalog()).assets.length, 1);
  const detached = await store.getAsset(asset.id);
  detached.tags.push('must-not-leak');
  assert.deepEqual((await store.getAsset(asset.id)).tags, ['test']);
  // Bypass atomicJson to simulate a different editor/process, including same-length content.
  const filename = store.assetPath(asset.id);
  await writeFile(filename, JSON.stringify({ ...asset, name: 'aaaa' }));
  assert.equal((await getCatalog()).assets[0].name, 'aaaa');
  await writeFile(filename, JSON.stringify({ ...asset, name: 'bbbb' }));
  assert.equal((await getCatalog()).assets[0].name, 'bbbb');
  const note = {
    id: 'note-1',
    assetId: asset.id,
    revision: asset.revision,
    text: '確認',
    createdAt: '2026-01-01T00:00:00.000Z',
    resolved: false,
  };
  await store.saveNotes(asset.id, [note]);
  assert.equal((await getCatalog()).assets[0].notesCount, 1);
  const notesFile = path.join(temp, 'catalog/reviews', asset.id + '.json');
  await writeFile(notesFile, JSON.stringify([{ ...note, resolved: true }]));
  assert.equal((await getCatalog()).assets[0].notesCount, 0);
  await rm(store.encodedPath(asset.file.hash));
  assert.equal((await getCatalog()).assets[0].available, false);
  await writeFile(notesFile, '{');
  await writeFile(path.join(store.assetDir, 'broken.json'), '{}');
  const partial = await getCatalog();
  assert.equal(partial.assets.length, 1);
  assert.equal(partial.problems.length, 2);
  await assert.rejects(() => store.listAssets()); // Exports/sync must not silently omit data.
  await store.saveNotes(asset.id, [note]);
  await rm(path.join(store.assetDir, 'broken.json'));
  assert.deepEqual((await getCatalog()).problems, []);
  assert.equal((await getCatalog()).assets[0].notesCount, 1);
});

test('sync validates the whole lock before publishing destinations and supports a shared GLB', async () => {
  const one = await register('test.one', 1);
  const two = await register('test.two', 2);
  await store.registerAsset({ ...one, id: 'test.shared' });
  const entry = (id: string, hash: string) => ({
    id,
    revision: hash,
    sha256: hash,
    variant: 'glb',
  });
  const lock = { schema: 1, assets: [entry(one.id, one.revision), entry(two.id, two.revision)] };
  const out = path.join(temp, 'runtime');
  await writeFile(store.encodedPath(two.revision), 'invalid second model');
  await assert.rejects(() => syncLock(lock, out), /SHA-256/);
  assert.equal(await store.exists(out), false);
  const result = await syncLock(
    { schema: 1, assets: [entry(one.id, one.revision), entry('test.shared', one.revision)] },
    out,
  );
  assert.equal(result.length, 2);
  for (const item of result)
    assert.equal(store.digest(await readFile(path.join(out, item.file))), one.revision);
  assert.equal((await readdir(out)).filter((name) => name.endsWith('.tmp')).length, 0);
});
