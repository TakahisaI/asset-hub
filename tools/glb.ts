import { Matrix4, Quaternion, Vector3 } from 'three';

export type Gltf = {
  extensionsUsed?: string[];
  extensionsRequired?: string[];
  extras?: Record<string, unknown>;
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: {
    name?: string;
    children?: number[];
    mesh?: number;
    skin?: number;
    matrix?: number[];
    translation?: number[];
    rotation?: number[];
    scale?: number[];
    extras?: Record<string, unknown>;
    extensions?: {
      KHR_lights_punctual?: { light: number };
      EXT_mesh_gpu_instancing?: { attributes: Record<string, number> };
    };
  }[];
  animations?: {
    name?: string;
    samplers: { input: number; output?: number; interpolation?: string }[];
    channels: { sampler?: number; target: { node?: number; path: string } }[];
  }[];
  accessors?: {
    min?: number[];
    max?: number[];
    count?: number;
    componentType?: number;
    type?: string;
    bufferView?: number;
    byteOffset?: number;
    normalized?: boolean;
    sparse?: unknown;
  }[];
  bufferViews?: {
    buffer: number;
    byteLength: number;
    byteOffset?: number;
    byteStride?: number;
    target?: number;
  }[];
  skins?: { inverseBindMatrices?: number }[];
  meshes?: {
    primitives: {
      attributes: Record<string, number>;
      targets?: Record<string, number>[];
      indices?: number;
      material?: number;
      mode?: number;
      extensions?: Record<string, unknown>;
    }[];
  }[];
  materials?: {
    name?: string;
    doubleSided?: boolean;
    normalTexture?: unknown;
    alphaMode?: string;
    extensions?: {
      KHR_materials_clearcoat?: { clearcoatNormalTexture?: unknown };
      KHR_materials_anisotropy?: { anisotropyStrength?: number };
    };
  }[];
  images?: { name?: string; mimeType?: string; bufferView?: number; uri?: string }[];
  buffers?: { byteLength: number; uri?: string }[];
};
export function readGlb(bytes: Uint8Array): Gltf {
  const buf = Buffer.from(bytes);
  if (
    buf.length < 20 ||
    buf.toString('ascii', 0, 4) !== 'glTF' ||
    buf.readUInt32LE(4) !== 2 ||
    buf.readUInt32LE(8) !== buf.length
  )
    throw new Error('有効なGLB 2.0ではありません');
  const length = buf.readUInt32LE(12);
  if (buf.readUInt32LE(16) !== 0x4e4f534a || length + 20 > buf.length)
    throw new Error('GLB JSONチャンクが壊れています');
  return JSON.parse(buf.toString('utf8', 20, 20 + length));
}
export function writeGlb(gltf: Gltf, binary: Uint8Array) {
  const json = Buffer.from(JSON.stringify(gltf));
  const jsonLength = Math.ceil(json.length / 4) * 4;
  const binLength = Math.ceil(binary.length / 4) * 4;
  const bytes = Buffer.alloc(28 + jsonLength + binLength);
  bytes.write('glTF');
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(jsonLength, 12);
  bytes.writeUInt32LE(0x4e4f534a, 16);
  bytes.fill(32, 20, 20 + jsonLength);
  json.copy(bytes, 20);
  bytes.writeUInt32LE(binLength, 20 + jsonLength);
  bytes.writeUInt32LE(0x004e4942, 24 + jsonLength);
  bytes.set(binary, 28 + jsonLength);
  return bytes;
}
// The first buffer uses the BIN chunk when it has no URI.
export function readGlbBinary(bytes: Uint8Array) {
  const buf = Buffer.from(bytes);
  let offset = 20 + buf.readUInt32LE(12);
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32LE(offset);
    if (buf.readUInt32LE(offset + 4) === 0x004e4942)
      return buf.subarray(offset + 8, offset + 8 + length);
    offset += 8 + length;
  }
  return undefined;
}
export function describeGlb(bytes: Uint8Array) {
  const gltf = readGlb(bytes),
    nodes = gltf.nodes ?? [];
  const active = new Set<number>();
  const visit = (index: number) => {
    if (active.has(index)) return;
    active.add(index);
    nodes[index]?.children?.forEach(visit);
  };
  gltf.scenes?.[gltf.scene ?? 0]?.nodes?.forEach(visit);
  return {
    nodes: nodes.map((node, index) => ({
      index,
      name: node.name ?? '',
      active: active.has(index),
      parent: nodes.findIndex((n) => n.children?.includes(index)),
      rest:
        node.matrix ??
        new Matrix4()
          .compose(
            new Vector3().fromArray(node.translation ?? [0, 0, 0]),
            new Quaternion().fromArray(node.rotation ?? [0, 0, 0, 1]),
            new Vector3().fromArray(node.scale ?? [1, 1, 1]),
          )
          .toArray(),
      mesh: node.mesh,
      skin: node.skin,
      light: node.extensions?.KHR_lights_punctual?.light,
    })),
    clips: (gltf.animations ?? []).map((clip, index) => ({
      index,
      name: clip.name ?? `Clip ${index + 1}`,
      duration: Math.max(0, ...clip.samplers.map((s) => gltf.accessors?.[s.input]?.max?.[0] ?? 0)),
      channels: clip.channels.map((c) => ({ node: c.target.node, path: c.target.path })),
    })),
  };
}
export type Structure = ReturnType<typeof describeGlb>;

// Direct reuse needs matching rest transforms and hierarchy, not merely matching names.
export function motionMap(
  source: Structure,
  target: Structure,
  clipIndex: number,
  explicit?: Record<string, number>,
) {
  const clip = source.clips[clipIndex];
  if (!clip) throw new Error('参照モーションのクリップがありません');
  const mapping: Record<string, number> = {};
  const match = (index: number): number => {
    if (mapping[index] !== undefined) return mapping[index];
    const from = source.nodes[index];
    if (!from?.active) throw new Error(`参照モーションのノードが既定シーンにありません: ${index}`);
    const candidates =
      explicit?.[index] !== undefined
        ? target.nodes.filter((n) => n.index === explicit[index])
        : target.nodes.filter((n) => from.name && n.name === from.name);
    if (candidates.length !== 1 || !candidates[0].active)
      throw new Error(`モーションのノード対応が一意ではありません: ${index} ${from.name}`);
    const to = candidates[0];
    if (from.rest.some((v, i) => Math.abs(v - to.rest[i]) > 1e-5))
      throw new Error(
        `基準姿勢・寸法が異なります。対象モデル向けにリターゲットして書き出してください: ${from.name}`,
      );
    mapping[index] = to.index;
    if (from.parent < 0 !== to.parent < 0 || (from.parent >= 0 && match(from.parent) !== to.parent))
      throw new Error(`骨格階層が異なります: ${from.name}`);
    return to.index;
  };
  for (const channel of clip.channels) {
    if (channel.node === undefined || !['translation', 'rotation', 'scale'].includes(channel.path))
      throw new Error('外部モーションの共有はノードの移動・回転・拡縮に対応しています');
    match(channel.node);
  }
  if (new Set(Object.values(mapping)).size !== Object.keys(mapping).length)
    throw new Error('複数のノードを同じ対象に対応させることはできません');
  return mapping;
}
