import { createHash } from 'node:crypto';
import { inspectGlb } from '../tools/inspect.ts';
import type { Asset } from '../src/schema.ts';

export function triangleGlb(external = false, scale = 1) {
  const gltf = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: 36, ...(external ? { uri: 'https://example.invalid/mesh.bin' } : {}) }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: 'VEC3',
        min: [0, 0, 0],
        max: [scale, scale, 0],
      },
    ],
  };
  const json = Buffer.from(JSON.stringify(gltf));
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 32);
  json.copy(padded);
  const bin = Buffer.from(new Float32Array([0, 0, 0, scale, 0, 0, 0, scale, 0]).buffer);
  const bytes = Buffer.alloc(12 + 8 + padded.length + 8 + bin.length);
  bytes.write('glTF');
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(padded.length, 12);
  bytes.writeUInt32LE(0x4e4f534a, 16);
  padded.copy(bytes, 20);
  bytes.writeUInt32LE(bin.length, 20 + padded.length);
  bytes.writeUInt32LE(0x004e4942, 24 + padded.length);
  bin.copy(bytes, 28 + padded.length);
  return bytes;
}
export async function fixtureAsset(
  bytes = triangleGlb(),
  id = 'test.triangle',
  name = '試験モデル',
): Promise<Asset> {
  const hash = createHash('sha256').update(bytes).digest('hex');
  const inspection = await inspectGlb(bytes);
  return {
    schema: 1 as const,
    id,
    name,
    description: 'triangle fixture',
    category: 'props' as const,
    tags: ['test'],
    collections: ['fixture'],
    license: 'CC0',
    source: {
      repository: 'local',
      commit: '',
      path: '/fixtures/triangle.glb',
      kind: 'other' as const,
      upstreamId: 'triangle',
      scope: 'test fixture',
      integrationNote: '',
    },
    revision: hash,
    file: { hash, bytes: bytes.length, name: 'triangle.glb' },
    ...inspection,
    importedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

export function animatedGlb(mesh = true, offset = 0, multipleScenes = false) {
  const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0];
  const times = [0, 1, 2];
  const rotations = [0, 0, 0, 1, 0, 0, Math.SQRT1_2, Math.SQRT1_2, 0, 0, 1, 0];
  const translations = [0, offset, 0, 0, offset + 1, 0, 0, offset, 0];
  const bin = Buffer.from(
    new Float32Array([...positions, ...times, ...rotations, ...translations]).buffer,
  );
  const gltf = {
    asset: { version: '2.0' },
    scene: multipleScenes ? 1 : 0,
    scenes: multipleScenes ? [{ nodes: [0] }, { nodes: [0, 3] }] : [{ nodes: [0] }],
    nodes: [
      { name: 'Root', children: [1, 2] },
      { name: 'Wheel', translation: [0, offset, 0], ...(mesh ? { mesh: 0 } : {}) },
      { name: 'Lamp', translation: [0, 1, 1], extensions: { KHR_lights_punctual: { light: 0 } } },
      ...(multipleScenes ? [{ name: 'OtherRoot' }] : []),
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 12 },
      { buffer: 0, byteOffset: 48, byteLength: 48 },
      { buffer: 0, byteOffset: 96, byteLength: 36 },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 3,
        type: 'VEC3',
        min: [0, 0, 0],
        max: [1, 1, 0],
      },
      { bufferView: 1, componentType: 5126, count: 3, type: 'SCALAR', min: [0], max: [2] },
      { bufferView: 2, componentType: 5126, count: 3, type: 'VEC4' },
      { bufferView: 3, componentType: 5126, count: 3, type: 'VEC3' },
    ],
    animations: [
      {
        name: 'Turn',
        samplers: [{ input: 1, output: 2 }],
        channels: [{ sampler: 0, target: { node: 1, path: 'rotation' } }],
      },
      {
        name: 'Lift',
        samplers: [{ input: 1, output: 3 }],
        channels: [{ sampler: 0, target: { node: 1, path: 'translation' } }],
      },
    ],
    extensionsUsed: ['KHR_lights_punctual'],
    extensions: {
      KHR_lights_punctual: { lights: [{ type: 'point', intensity: 1, color: [1, 1, 1] }] },
    },
  };
  const json = Buffer.from(JSON.stringify(gltf)),
    padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 32);
  json.copy(padded);
  const bytes = Buffer.alloc(28 + padded.length + bin.length);
  bytes.write('glTF');
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(padded.length, 12);
  bytes.writeUInt32LE(0x4e4f534a, 16);
  padded.copy(bytes, 20);
  bytes.writeUInt32LE(bin.length, 20 + padded.length);
  bytes.writeUInt32LE(0x004e4942, 24 + padded.length);
  bin.copy(bytes, 28 + padded.length);
  return bytes;
}
