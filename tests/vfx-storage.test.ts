import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { vfxGlb, triangleGlb } from './fixtures.ts';
const temp = await mkdtemp(path.join(os.tmpdir(), 'asset-hub-vfx-'));
process.env.ASSET_HUB_ROOT = temp;
const { digest, getAsset, getNotes } = await import('../server/store.ts');
const { readBlob, manifestPath, encodedPath, putBlob } = await import('../server/blobs.ts');
const { importGlb, addNote } = await import('../server/operations.ts');
const { createLock, syncLock } = await import('../tools/assetctl.ts');
const { inspectStorage } = await import('../tools/storage.ts');
const { backupLibrary, verifyBackup } = await import('../tools/backup.ts');
const { createApp, apiErrors } = await import('../server/app.ts');
const app = createApp();
app.use(apiErrors);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await rm(temp, { recursive: true, force: true });
});

test('VFX originals, video and runtime are pinned, served and retained after replacing the model', async () => {
  const source = Buffer.from('BLENDER original fixture');
  const preview = Buffer.from('preview fixture');
  const runtime = await readFile(new URL('../src/vfx-runtime.js', import.meta.url));
  const folder = path.join(temp, 'catalog/sources/cannon');
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'source.blend'), source);
  await writeFile(path.join(folder, 'preview.mp4'), preview);
  const input = {
    id: 'test.vfx',
    name: 'VFX',
    category: 'effects',
    source: {
      repository: 'local',
      commit: '',
      path: path.join(folder, 'source.blend'),
      kind: 'blender',
      upstreamId: 'fixture',
      scope: 'fixture',
      integrationNote: '',
    },
  };
  const bytes = vfxGlb(digest(runtime), digest(source), digest(preview));
  let asset = await importGlb(bytes, 'vfx.glb', input);
  assert.equal(asset.qa.errors, 0);
  assert.ok(asset.vfx);
  for (const [kind, expected] of [
    ['source', source],
    ['preview', preview],
    ['runtime', runtime],
  ] as const) {
    const response = await fetch(
      `${base}/api/assets/${asset.id}/revisions/${asset.revision}/vfx/${kind}`,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected);
  }
  const ranged = await fetch(
    `${base}/api/assets/${asset.id}/revisions/${asset.revision}/vfx/preview`,
    { headers: { Range: 'bytes=1-3' } },
  );
  assert.equal(ranged.status, 206);
  assert.deepEqual(Buffer.from(await ranged.arrayBuffer()), preview.subarray(1, 4));
  const originalSource = asset.source;
  asset = await importGlb(bytes, 'vfx.glb', { id: asset.id }, asset.updatedAt);
  assert.deepEqual(asset.source, originalSource);
  const lock = await createLock([asset.id]);
  const out = path.join(temp, 'exported');
  const exported = await syncLock(lock, out);
  assert.deepEqual(await readFile(path.join(out, exported[0].runtimeFile!)), runtime);
  await writeFile(path.join(temp, 'package.json'), '{"type":"module"}');
  await symlink(path.join(process.cwd(), 'node_modules'), path.join(temp, 'node_modules'));
  const portable = await import(pathToFileURL(path.join(out, exported[0].runtimeFile!)).href);
  const gltf = await new GLTFLoader().parseAsync(Uint8Array.from(bytes).buffer, '');
  portable.applyVfx(gltf);
  const mixer = new THREE.AnimationMixer(gltf.scene);
  mixer.clipAction(gltf.animations[0]).play();
  mixer.update(1);
  const densities: number[] = [];
  gltf.scene.traverse((object) => {
    if (object instanceof THREE.Mesh && object.material instanceof THREE.ShaderMaterial)
      densities.push(object.material.opacity);
  });
  assert.deepEqual(densities, [4]);
  mixer.stopAllAction();
  await writeFile(path.join(out, exported[0].runtimeFile!), 'corrupt');
  await assert.rejects(() => syncLock(lock, out), /異なる内容/);
  assert.deepEqual(await readFile(path.join(out, exported[0].file)), bytes);
  await syncLock(lock, out, true);
  await addNote(asset.id, {
    revision: asset.revision,
    text: 'VFX timing',
    playback: { clip: 0, time: 1, speed: 1, loop: true },
  });
  const updated = await importGlb(triangleGlb(), 'model.glb', { id: asset.id }, asset.updatedAt);
  assert.equal(updated.vfx, undefined);
  assert.equal(updated.category, 'effects');
  assert.equal((await getNotes(asset.id))[0].revision, asset.revision);
  const storage = await inspectStorage();
  for (const hash of [digest(source), digest(preview), digest(runtime)]) {
    assert.equal(storage.complete, true);
    assert.ok(!storage.candidates.some((b) => b.hash === hash));
    assert.ok(!storage.missing.some((b) => b.hash === hash));
  }
  const backup = await backupLibrary(path.join(temp, '..', path.basename(temp) + '-backup'));
  try {
    const saved = await verifyBackup(backup.path);
    assert.ok(
      saved.files.some((f) => f.path === path.relative(temp, encodedPath(digest(runtime)))),
    );
  } finally {
    await rm(backup.path, { recursive: true, force: true });
  }
  const old = await fetch(`${base}/api/assets/${asset.id}/revisions/${asset.revision}/vfx/source`);
  assert.deepEqual(Buffer.from(await old.arrayBuffer()), source);
  await writeFile(encodedPath(digest(source)), 'corrupt');
  assert.equal(
    (await fetch(`${base}/api/assets/${asset.id}/revisions/${asset.revision}/vfx/source`)).status,
    500,
  );
});

test('VFX import cannot read outside the source snapshot through symlinks and failed imports do not register assets', async () => {
  const runtime = await readFile(new URL('../src/vfx-runtime.js', import.meta.url));
  const outside = path.join(temp, 'outside.blend');
  const content = Buffer.from('not a library source');
  await writeFile(outside, content);
  const folder = path.join(temp, 'catalog/sources/escape');
  await mkdir(folder, { recursive: true });
  await symlink(outside, path.join(folder, 'source.blend'));
  const bytes = vfxGlb(digest(runtime), digest(content));
  await assert.rejects(
    () =>
      importGlb(bytes, 'vfx.glb', {
        id: 'test.escape',
        source: {
          repository: 'local',
          commit: '',
          path: path.join(folder, 'source.blend'),
          kind: 'blender',
          upstreamId: 'escape',
          scope: '',
          integrationNote: '',
        },
      }),
    /sources内/,
  );
  await assert.rejects(() => getAsset('test.escape'), { code: 'ENOENT' });
  assert.equal((await readBlob(digest(runtime))).length, runtime.length);
  assert.ok(await readFile(manifestPath(digest(runtime))));
});

test('an existing arbitrary blob cannot be substituted for the Three.js runtime', async () => {
  const other = Buffer.from('export const untrusted = true;');
  const hash = await putBlob(other);
  await assert.rejects(
    () => importGlb(vfxGlb(hash, 'f'.repeat(64)), 'bad.glb', { id: 'test.untrusted' }),
    /ローダーが未保存/,
  );
  await assert.rejects(() => getAsset('test.untrusted'), { code: 'ENOENT' });
});

test('VFX tracks cannot extend beyond the embedded geometry clip', async () => {
  const bytes = vfxGlb('a'.repeat(64), 'b'.repeat(64));
  const offset = bytes.indexOf('"times":[0,1,2]');
  assert.ok(offset > 0);
  bytes.write('"times":[0,1,9]', offset);
  await assert.rejects(() => importGlb(bytes, 'bad.glb', { id: 'test.range' }), /VFXの再生範囲/);
  await assert.rejects(() => getAsset('test.range'), { code: 'ENOENT' });
});
