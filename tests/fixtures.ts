import { createHash } from 'node:crypto';
import { inspectGlb } from '../tools/inspect.ts';
import type { Asset } from '../src/schema.ts';
import { SphereGeometry } from 'three';
import type { Vfx } from '../src/vfx-schema.ts';

export function vfxGlb(runtime: string, source: string, preview?: string) {
  const original = animatedGlb();
  const length = original.readUInt32LE(12);
  const gltf = JSON.parse(original.subarray(20, 20 + length).toString());
  const geometry = new SphereGeometry(1, 8, 6);
  const chunks: Buffer[] = [original.subarray(28 + length)];
  let offset = chunks[0].length;
  for (const [name, values, type, componentType] of [
    ['POSITION', geometry.attributes.position.array, 'VEC3', 5126],
    ['NORMAL', geometry.attributes.normal.array, 'VEC3', 5126],
    ['indices', geometry.index!.array, 'SCALAR', 5123],
  ] as const) {
    const bytes = Buffer.from(values.buffer, values.byteOffset, values.byteLength);
    const view = gltf.bufferViews.length;
    gltf.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length });
    const accessor = gltf.accessors.length;
    gltf.accessors.push({
      bufferView: view,
      componentType,
      count: values.length / (type === 'VEC3' ? 3 : 1),
      type,
      ...(name === 'POSITION' ? { min: [-1, -1, -1], max: [1, 1, 1] } : {}),
    });
    const primitive = gltf.meshes[0].primitives[0];
    if (name === 'indices') primitive.indices = accessor;
    else primitive.attributes[name] = accessor;
    chunks.push(bytes);
    offset += bytes.length;
  }
  gltf.meshes[0].primitives[0].material = 0;
  gltf.materials = [{ name: 'smoke' }];
  const vfx: Vfx = {
    schema: 1,
    clip: 0,
    posterTime: 1,
    runtime,
    source: { name: 'source.blend', hash: source },
    ...(preview ? { preview: { name: 'preview.mp4', hash: preview } } : {}),
    limitations: 'テスト用の近似ボリューム',
    times: [0, 1, 2],
    smoke: [
      { material: 0, color: [0.3, 0.3, 0.3], noiseScale: 5, threshold: 0.35, density: [0, 4, 0] },
    ],
    emission: [],
  };
  gltf.extras = { assetHubVfx: vfx };
  gltf.buffers[0].byteLength = offset;
  const json = Buffer.from(JSON.stringify(gltf));
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 32);
  json.copy(padded);
  const bin = Buffer.concat(chunks);
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
  geometry.dispose();
  return bytes;
}

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
// Two nodes instancing one two-primitive mesh: instances, materials and texture bytes are all distinct.
export function profiledGlb() {
  const chunks: Buffer[] = [];
  const views: { buffer: number; byteOffset: number; byteLength: number }[] = [];
  const accessors: Record<string, unknown>[] = [];
  let offset = 0;
  const append = (data: Buffer) => {
    const padding = (4 - (offset % 4)) % 4;
    if (padding) {
      chunks.push(Buffer.alloc(padding));
      offset += padding;
    }
    views.push({ buffer: 0, byteOffset: offset, byteLength: data.length });
    chunks.push(data);
    offset += data.length;
    return views.length - 1;
  };
  const accessor = (data: Buffer, spec: Record<string, unknown>) => {
    const index = accessors.length;
    accessors.push({ bufferView: append(data), ...spec });
    return index;
  };
  const floats = (values: number[]) => Buffer.from(new Float32Array(values).buffer);
  const shorts = (values: number[]) => Buffer.from(new Uint16Array(values).buffer);
  const position = accessor(floats([0, 0, 0, 1, 0, 0, 0, 1, 0]), {
    componentType: 5126,
    count: 3,
    type: 'VEC3',
    min: [0, 0, 0],
    max: [1, 1, 0],
  });
  const normal = accessor(floats([0, 0, 1, 0, 0, 1, 0, 0, 1]), {
    componentType: 5126,
    count: 3,
    type: 'VEC3',
  });
  const uv = accessor(floats([0, 0, 1, 0, 0, 1]), { componentType: 5126, count: 3, type: 'VEC2' });
  const tangent = accessor(floats([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]), {
    componentType: 5126,
    count: 3,
    type: 'VEC4',
  });
  const indices = accessor(shorts([0, 1, 2]), { componentType: 5123, count: 3, type: 'SCALAR' });
  const otherIndices = accessor(shorts([0, 2, 1]), {
    componentType: 5123,
    count: 3,
    type: 'SCALAR',
  });
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const image = append(png);
  const gltf = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0, 1] }],
    nodes: [{ mesh: 0 }, { mesh: 0, translation: [2, 0, 0] }],
    meshes: [
      {
        primitives: [
          {
            attributes: { POSITION: position, NORMAL: normal, TEXCOORD_0: uv },
            indices,
            material: 0,
          },
          {
            attributes: { POSITION: position, TANGENT: tangent },
            indices: otherIndices,
            material: 1,
          },
        ],
      },
    ],
    materials: [{ name: 'wood', doubleSided: true, normalTexture: { index: 0 } }, { name: 'iron' }],
    textures: [{ source: 0 }],
    images: [{ mimeType: 'image/png', bufferView: image }],
    buffers: [{ byteLength: offset }],
    bufferViews: views,
    accessors,
  };
  return rawGlb(gltf, Buffer.concat(chunks));
}
// Minimal GLB assembly for tests that need a specific malformed or unusual document.
export function rawGlb(gltf: Record<string, unknown>, bin = Buffer.alloc(0)) {
  const json = Buffer.from(JSON.stringify(gltf));
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 32);
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
