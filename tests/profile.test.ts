import { profiledGlb } from './fixtures.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { profileGlb, imageSize } from '../tools/profile.ts';
import { renderProfileSchema } from '../src/render-profile-schema.ts';
const bytes = profiledGlb();
const profile = profileGlb(bytes, '2026-01-01T00:00:00.000Z');
test('a profile is a valid document with a stable tool tag', () => {
  assert.equal(renderProfileSchema.safeParse(profile).success, true);
  assert.equal(profile.tool, 'render-profile/1');
  assert.equal(profile.glb.bytes, bytes.length);
});
test('draw calls follow node instances, not the mesh count', () => {
  // Two nodes share one mesh of two primitives: four calls, two primitives, two triangles of geometry.
  assert.equal(profile.scene.meshes, 1);
  assert.equal(profile.scene.primitives, 2);
  assert.equal(profile.scene.meshInstances, 2);
  assert.equal(profile.scene.drawCalls, 4);
  assert.equal(profile.geometry.triangles, 2);
  assert.equal(profile.geometry.trianglesDrawn, 4);
  assert.equal(profile.geometry.vertices, 6);
});
test('vertex and index bytes count unique accessors only', () => {
  // POSITION 36 + NORMAL 36 + UV 24 + TANGENT 48, each shared by both primitives through instancing.
  assert.equal(profile.geometry.vertexBytes, 36 + 36 + 24 + 48);
  assert.equal(profile.geometry.indexBytes, 6 + 6);
});
test('tangents are only paid for where a material samples a normal map', () => {
  assert.equal(profile.attributes.primitivesWithTangent, 1);
  assert.equal(profile.attributes.primitivesWithUv, 1);
  // The tangent accessor belongs to the primitive whose material has no normalTexture.
  assert.equal(profile.attributes.tangentBytesUnused, 48);
});
test('texture dimensions come from the embedded image, not its compressed size', () => {
  assert.equal(profile.textures.count, 1);
  assert.equal(profile.textures.maxEdge, 1);
  assert.equal(profile.textures.decodedBytes, 4);
  assert.equal(profile.textures.items[0].mimeType, 'image/png');
  assert.ok(profile.textures.items[0].bytes > 0);
  assert.deepEqual(imageSize(Buffer.from('not an image')), undefined);
});
test('material totals add up to the drawn triangles', () => {
  assert.equal(profile.scene.materials, 2);
  assert.equal(profile.scene.doubleSidedMaterials, 1);
  assert.deepEqual(
    profile.byMaterial.map((entry) => [entry.name, entry.drawCalls, entry.triangles]),
    [
      ['iron', 2, 2],
      ['wood', 2, 2],
    ],
  );
  assert.equal(
    profile.byMaterial.reduce((total, entry) => total + entry.drawCalls, 0),
    profile.scene.drawCalls,
  );
});
test('profiles are stored by GLB hash and leave the fixed revision untouched', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'asset-hub-profile-'));
  process.env.ASSET_HUB_ROOT = temp;
  try {
    const store = {
      ...(await import('../server/store.ts')),
      ...(await import('../server/blobs.ts')),
    };
    const profiles = await import('../server/profiles.ts');
    const { fixtureAsset } = await import('./fixtures.ts');
    const asset = await fixtureAsset(bytes, 'test.profiled');
    const hash = await store.putBlob(bytes);
    await store.registerAsset(asset);
    const ledger = await readFile(store.assetPath(asset.id), 'utf8');
    assert.equal(await profiles.getProfile(asset.revision), null);
    const measured = await profiles.measureAsset(asset.id);
    assert.equal(measured.glb.hash, hash);
    assert.equal(await profiles.saveProfiles([measured]), 1);
    const stored = await profiles.getProfile(asset.revision);
    assert.equal(stored?.scene.drawCalls, 4);
    // Measuring is a read of the library; the ledger must not gain a revision or a timestamp.
    assert.equal(await readFile(store.assetPath(asset.id), 'utf8'), ledger);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
