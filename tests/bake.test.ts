import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import { bakeGlb } from '../tools/bake.ts';
import { readGlb, readGlbBinary, writeGlb, type Gltf } from '../tools/glb.ts';
import { profileGlb } from '../tools/profile.ts';
import { inspectGlb } from '../tools/inspect.ts';
import { bakeInputSchema, normalizeBakeInput } from '../src/bake-schema.ts';
import { rigidGlb } from './fixtures.ts';

const input = { groups: [{ rootNode: 0, nodes: [1, 2] }] };
function changed(edit: (g: Gltf) => void) {
  const bytes = rigidGlb(),
    g = readGlb(bytes);
  edit(g);
  return writeGlb(g, readGlbBinary(bytes)!);
}
function values(bytes: Uint8Array, index: number) {
  const g = readGlb(bytes),
    bin = readGlbBinary(bytes)!;
  const a = g.accessors![index],
    v = g.bufferViews![a.bufferView!];
  const width = { SCALAR: 1, VEC3: 3, VEC4: 4 }[a.type as 'SCALAR' | 'VEC3' | 'VEC4'];
  return Array.from({ length: a.count! * width }, (_, i) => {
    const offset = v.byteOffset! + i * 4;
    return a.componentType === 5126 ? bin.readFloatLE(offset) : bin.readUInt32LE(offset);
  });
}
test('bake merges shared rigid meshes deterministically without changing source or hierarchy', async () => {
  const source = rigidGlb(),
    saved = Buffer.from(source);
  const result = bakeGlb(source, input),
    g = readGlb(result.bytes);
  assert.deepEqual(source, saved);
  assert.deepEqual(
    bakeGlb(source, { groups: [{ rootNode: 0, nodes: [2, 1] }] }).bytes,
    result.bytes,
  );
  assert.equal((await inspectGlb(result.bytes)).qa.errors, 0);
  assert.equal(profileGlb(source).scene.drawCalls, 2);
  assert.equal(profileGlb(result.bytes).scene.drawCalls, 1);
  assert.equal(profileGlb(result.bytes).geometry.trianglesDrawn, 2);
  assert.deepEqual(g.nodes!.slice(0, 3), [
    { name: 'Root', children: [1, 2, 3] },
    { name: 'Left' },
    { name: 'Right', translation: [2, 0, 0] },
  ]);
  const p = g.meshes![g.nodes![3].mesh!].primitives[0];
  assert.deepEqual(
    values(result.bytes, p.attributes.POSITION),
    [0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0, 0, 3, 0, 0, 2, 1, 0],
  );
  assert.deepEqual(values(result.bytes, p.indices!), [0, 1, 2, 3, 4, 5]);
  assert.equal(result.ranges.length, 2);
});
test('reflection changes triangle winding and tangent handedness; nonuniform scale preserves normals', () => {
  const bytes = changed((g) => {
    g.nodes![2].scale = [-2, 3, 1];
  });
  const result = bakeGlb(bytes, input),
    g = readGlb(result.bytes);
  const p = g.meshes![g.nodes![3].mesh!].primitives[0];
  assert.deepEqual(values(result.bytes, p.indices!), [0, 1, 2, 3, 5, 4]);
  assert.deepEqual(
    values(result.bytes, p.attributes.TANGENT).slice(12),
    [-1, 0, 0, -1, -1, 0, 0, -1, -1, 0, 0, -1],
  );
  assert.deepEqual(
    values(result.bytes, p.attributes.NORMAL).map((v) => (v === 0 ? 0 : v)),
    [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  );
});
test('material and attribute boundaries remain separate', () => {
  const bytes = changed((g) => {
    g.materials!.push({ name: 'iron' });
    const p = structuredClone(g.meshes![0].primitives[0]);
    p.material = 1;
    g.meshes![0].primitives.push(p);
    const noTangent = structuredClone(p);
    delete noTangent.attributes.TANGENT;
    g.meshes![0].primitives.push(noTangent);
  });
  const output = bakeGlb(bytes, input).bytes;
  assert.equal(profileGlb(output).scene.drawCalls, 3);
  assert.equal(profileGlb(output).geometry.trianglesDrawn, 6);
});
test('rejects moving paths, including cubic clips, and preserves root motion', () => {
  const animate = (node: number) =>
    changed((g) => {
      g.animations = [
        {
          samplers: [{ input: 0, output: 0, interpolation: 'CUBICSPLINE' }],
          channels: [{ sampler: 0, target: { node, path: 'rotation' } }],
        },
      ];
    });
  assert.throws(() => bakeGlb(animate(1), input), /可動ノード/);
  assert.throws(() => bakeGlb(rigidGlb(), input, [2]), /可動ノード/);
  assert.doesNotThrow(() => bakeGlb(animate(0), input));
  assert.throws(() => bakeGlb(rigidGlb(), { groups: [{ rootNode: 1, nodes: [2] }] }), /部分木/);
});
test('rejects unsupported geometry rather than silently losing it', () => {
  for (const edit of [
    (g: Gltf) => {
      g.nodes![1].skin = 0;
    },
    (g: Gltf) => {
      g.meshes![0].primitives[0].targets = [{ POSITION: 0 }];
    },
    (g: Gltf) => {
      g.materials![0].alphaMode = 'BLEND';
    },
    (g: Gltf) => {
      g.meshes![0].primitives[0].attributes._CUSTOM = 0;
    },
    (g: Gltf) => {
      g.accessors![0].sparse = {};
    },
    (g: Gltf) => {
      g.accessors![0].normalized = true;
    },
    (g: Gltf) => {
      g.bufferViews![0].byteLength = 1;
    },
    (g: Gltf) => {
      g.extensionsUsed = ['KHR_draco_mesh_compression'];
    },
    (g: Gltf) => {
      g.nodes![1].scale = [0, 1, 1];
    },
    (g: Gltf) => {
      g.nodes![1].children = [0];
    },
  ])
    assert.throws(() => bakeGlb(changed(edit), input));
  assert.throws(() => normalizeBakeInput({ groups: [{ rootNode: 0, nodes: [1, 1] }] }));
});
test('bake input schema can be exported and sorting is canonical', () => {
  assert.ok(z.toJSONSchema(bakeInputSchema).properties?.groups);
  assert.equal(normalizeBakeInput(input).checks.imageMaxChannelError, 2);
  assert.equal(
    normalizeBakeInput({ ...input, checks: { imageMaxChannelError: 40 } }).checks
      .imageMaxChannelError,
    40,
  );
  assert.throws(() => normalizeBakeInput({ ...input, checks: { imageMaxChannelError: 256 } }));
  assert.deepEqual(
    normalizeBakeInput({ groups: [{ rootNode: 0, nodes: [2, 1] }] }).groups,
    input.groups,
  );
});
