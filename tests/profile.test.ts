import { profiledGlb, rawGlb, triangleGlb } from './fixtures.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { profileGlb, imageSize } from '../tools/profile.ts';
import { readGlb, readGlbBinary } from '../tools/glb.ts';
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
// --- regression cases reported on the first version of the profile ---
const TRI = [0, 0, 0, 1, 0, 0, 0, 1, 0];
const TAN = [1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1];
const floats = (values: number[]) => Buffer.from(new Float32Array(values).buffer);
const shorts = (values: number[]) => Buffer.from(new Uint16Array(values).buffer);
const triangleBin = () => Buffer.concat([floats(TRI), shorts([0, 1, 2])]);
const triangleAccessors = [
  { bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
  { bufferView: 1, componentType: 5123, count: 3, type: 'SCALAR' },
];
const triangleGltf = (extra: Record<string, unknown>) => ({
  asset: { version: '2.0' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0 }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
  bufferViews: [
    { buffer: 0, byteOffset: 0, byteLength: 36 },
    { buffer: 0, byteOffset: 36, byteLength: 6 },
  ],
  accessors: triangleAccessors,
  ...extra,
});
test('GPU instances multiply drawn triangles without multiplying draw calls or geometry', () => {
  const bin = Buffer.concat([triangleBin(), Buffer.alloc(2), floats(TRI)]);
  const instanced = profileGlb(
    rawGlb(
      triangleGltf({
        extensionsUsed: ['EXT_mesh_gpu_instancing'],
        extensionsRequired: ['EXT_mesh_gpu_instancing'],
        nodes: [
          { mesh: 0, extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: 2 } } } },
        ],
        buffers: [{ byteLength: bin.length }],
        bufferViews: [
          { buffer: 0, byteOffset: 0, byteLength: 36 },
          { buffer: 0, byteOffset: 36, byteLength: 6 },
          { buffer: 0, byteOffset: 44, byteLength: 36 },
        ],
        accessors: [
          ...triangleAccessors,
          { bufferView: 2, componentType: 5126, count: 3, type: 'VEC3' },
        ],
      }),
      bin,
    ),
  );
  assert.equal(instanced.scene.meshInstances, 3);
  assert.equal(instanced.scene.drawCalls, 1);
  assert.equal(instanced.geometry.triangles, 1);
  assert.equal(instanced.geometry.trianglesDrawn, 3);
  assert.equal(instanced.geometry.vertexBytes, 36);
  assert.equal(instanced.geometry.indexBytes, 6);
  assert.equal(instanced.byMaterial[0].drawCalls, 1);
  assert.equal(instanced.byMaterial[0].triangles, 3);
});
test('a model with 257 materials is measured instead of rejected', () => {
  const materials = Array.from({ length: 257 }, (_, index) => ({ name: `m${index}` }));
  const primitives = materials.map((_, index) => ({
    attributes: { POSITION: 0 },
    indices: 1,
    material: index,
  }));
  const many = profileGlb(
    rawGlb(
      triangleGltf({
        meshes: [{ primitives }],
        materials,
      }),
      triangleBin(),
    ),
  );
  assert.equal(many.byMaterial.length, 257);
  assert.equal(many.scene.drawCalls, 257);
  assert.equal(renderProfileSchema.safeParse(many).success, true);
});
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
for (const [encoding, encode] of Object.entries({
  base64: (data: Buffer) => `;base64,${data.toString('base64')}`,
  'percent-encoded base64': (data: Buffer) =>
    `;base64,${encodeURIComponent(data.toString('base64'))}`,
  'percent-encoded bytes': (data: Buffer) =>
    `,${[...data].map((byte) => `%${byte.toString(16).padStart(2, '0')}`).join('')}`,
})) {
  test(`images embedded as ${encoding} data URIs are measured like bufferView images`, () => {
    const embedded = profileGlb(
      rawGlb(
        triangleGltf({
          images: [{ uri: `data:image/png${encode(png)}` }],
          textures: [{ source: 0 }],
        }),
        triangleBin(),
      ),
    );
    assert.equal(embedded.textures.count, 1);
    assert.equal(embedded.textures.maxEdge, 1);
    assert.equal(embedded.textures.decodedBytes, 4);
    assert.equal(embedded.textures.items[0].mimeType, 'image/png');
    assert.equal(embedded.textures.bytes, png.length);
    assert.deepEqual(embedded.textures.items[0], {
      mimeType: 'image/png',
      bytes: png.length,
      width: 1,
      height: 1,
    });
  });
  test(`bufferView images resolve their ${encoding} data URI buffer and byte offset`, () => {
    const bin = Buffer.concat([triangleBin(), Buffer.alloc(2)]);
    const imageBuffer = Buffer.concat([Buffer.alloc(4), png, Buffer.alloc(2)]);
    const embedded = profileGlb(
      rawGlb(
        triangleGltf({
          buffers: [
            { byteLength: bin.length },
            {
              byteLength: imageBuffer.length,
              uri: `data:application/octet-stream${encode(imageBuffer)}`,
            },
          ],
          bufferViews: [
            { buffer: 0, byteOffset: 0, byteLength: 36 },
            { buffer: 0, byteOffset: 36, byteLength: 6 },
            { buffer: 1, byteOffset: 4, byteLength: png.length },
          ],
          images: [{ mimeType: 'image/png', bufferView: 2 }],
          textures: [{ source: 0 }],
        }),
        bin,
      ),
    );
    assert.equal(embedded.textures.bytes, png.length);
    assert.equal(embedded.textures.decodedBytes, 4);
    assert.equal(embedded.textures.maxEdge, 1);
    assert.deepEqual(embedded.textures.items[0], {
      mimeType: 'image/png',
      bytes: png.length,
      width: 1,
      height: 1,
    });
  });
}
test('a JPEG thumbnail in Exif is not mistaken for the image', () => {
  const thumbnail = Buffer.from([
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x10, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01,
    0x03, 0x11, 0x01,
  ]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0x00, 0x00]), thumbnail, Buffer.alloc(20)]);
  app1.writeUInt16BE(app1.length - 2, 2);
  const frame = Buffer.from([
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x90, 0x01, 0x90, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01,
    0x03, 0x11, 0x01,
  ]);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), app1, frame, Buffer.from([0xff, 0xd9])]);
  assert.deepEqual(imageSize(jpeg), { width: 400, height: 400 });
});
test('morph target vertex data counts toward vertex bytes', () => {
  const morphed = profileGlb(
    rawGlb(
      triangleGltf({
        meshes: [
          {
            primitives: [{ attributes: { POSITION: 0 }, targets: [{ POSITION: 2 }], indices: 1 }],
          },
        ],
        bufferViews: [
          { buffer: 0, byteOffset: 0, byteLength: 36 },
          { buffer: 0, byteOffset: 36, byteLength: 6 },
          { buffer: 0, byteOffset: 42, byteLength: 36 },
        ],
        accessors: [
          ...triangleAccessors,
          { bufferView: 2, componentType: 5126, count: 3, type: 'VEC3' },
        ],
      }),
      Buffer.concat([floats(TRI), shorts([0, 1, 2]), floats(TRI)]),
    ),
  );
  assert.equal(morphed.geometry.vertexBytes, 72);
});
test('a tangent accessor shared by several primitives is counted once', () => {
  const shared = profileGlb(
    rawGlb(
      triangleGltf({
        meshes: [
          {
            primitives: [
              { attributes: { POSITION: 0, TANGENT: 2 }, indices: 1, material: 0 },
              { attributes: { POSITION: 0, TANGENT: 2 }, indices: 1, material: 1 },
            ],
          },
        ],
        materials: [{ name: 'a' }, { name: 'b' }],
        bufferViews: [
          { buffer: 0, byteOffset: 0, byteLength: 36 },
          { buffer: 0, byteOffset: 36, byteLength: 6 },
          { buffer: 0, byteOffset: 42, byteLength: 48 },
        ],
        accessors: [
          ...triangleAccessors,
          { bufferView: 2, componentType: 5126, count: 3, type: 'VEC4' },
        ],
      }),
      Buffer.concat([floats(TRI), shorts([0, 1, 2]), floats(TAN)]),
    ),
  );
  assert.equal(shared.attributes.tangentBytesUnused, 48);
  // One primitive with a normal map makes the shared accessor worth keeping.
  const used = profileGlb(
    rawGlb(
      triangleGltf({
        meshes: [
          {
            primitives: [
              { attributes: { POSITION: 0, TANGENT: 2 }, indices: 1, material: 0 },
              { attributes: { POSITION: 0, TANGENT: 2 }, indices: 1, material: 1 },
            ],
          },
        ],
        materials: [{ name: 'a', normalTexture: { index: 0 } }, { name: 'b' }],
        bufferViews: [
          { buffer: 0, byteOffset: 0, byteLength: 36 },
          { buffer: 0, byteOffset: 36, byteLength: 6 },
          { buffer: 0, byteOffset: 42, byteLength: 48 },
        ],
        accessors: [
          ...triangleAccessors,
          { bufferView: 2, componentType: 5126, count: 3, type: 'VEC4' },
        ],
      }),
      Buffer.concat([floats(TRI), shorts([0, 1, 2]), floats(TAN)]),
    ),
  );
  assert.equal(used.attributes.tangentBytesUnused, 0);
});
for (const { name, extensions, unused } of [
  {
    name: 'clearcoat normal maps',
    extensions: {
      KHR_materials_clearcoat: { clearcoatFactor: 1, clearcoatNormalTexture: { index: 0 } },
    },
    unused: 0,
  },
  {
    name: 'anisotropic materials',
    extensions: { KHR_materials_anisotropy: { anisotropyStrength: 1 } },
    unused: 0,
  },
  {
    name: 'disabled anisotropy',
    extensions: { KHR_materials_anisotropy: { anisotropyStrength: 0 } },
    unused: 48,
  },
]) {
  test(`tangent usage accounts for ${name}`, () => {
    const gltf = readGlb(bytes);
    Object.assign(gltf.meshes![0].primitives[1].attributes, { NORMAL: 1, TEXCOORD_0: 2 });
    const measured = profileGlb(
      rawGlb(
        { ...gltf, extensionsUsed: Object.keys(extensions), materials: [{}, { extensions }] },
        readGlbBinary(bytes),
      ),
    );
    assert.equal(measured.attributes.tangentBytesUnused, unused);
  });
}
test('profiles are stored by GLB hash and leave the fixed revision untouched', async (t) => {
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
    await store.atomicJson(profiles.profilePath(hash), { ...measured, tool: 'render-profile/0' });
    await assert.rejects(() => profiles.getProfile(hash), /計測方法の版が異なります/);
    await profiles.saveProfiles([measured]);
    // Measuring is a read of the library; the ledger must not gain a revision or a timestamp.
    assert.equal(await readFile(store.assetPath(asset.id), 'utf8'), ledger);
    await t.test('bulk measurement pins revisions during concurrent reimports', async () => {
      const old = await fixtureAsset(triangleGlb(), 'zz.target');
      await store.putBlob(triangleGlb());
      await store.registerAsset(old);
      const replacement = await fixtureAsset(bytes, old.id);
      let acquired!: () => void;
      let replace!: () => void;
      const ready = new Promise<void>((resolve) => {
        acquired = resolve;
      });
      const proceed = new Promise<void>((resolve) => {
        replace = resolve;
      });
      const replacing = store.withLibraryLock(async () => {
        acquired();
        await proceed;
        await store.registerAsset(replacement);
      });
      await ready;
      const pending = profiles.measureAll(true);
      try {
        // The first blob read has taken the catalog snapshot and is waiting for our lock.
        const work = path.join(temp, '.cache/work');
        for (let attempts = 0; !(await store.directoryEntries(work)).length; attempts++) {
          assert.ok(attempts < 500, 'bulk measurement did not reach its first blob read');
          await setTimeout(10);
        }
      } finally {
        replace();
        await replacing;
        await pending;
      }
      const result = (await pending).find((entry) => entry.id === old.id);
      assert.equal((await store.getAsset(old.id)).revision, replacement.revision);
      assert.equal(result?.revision, old.revision);
      assert.equal(result?.profile.glb.hash, old.revision);
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
