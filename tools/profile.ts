// A render profile is a structural measurement, not a frame time.
// It answers "how much work does this GLB ask for", never "how fast does it run".
import { createHash } from 'node:crypto';
import { readGlb, readGlbBinary } from './glb.ts';
import {
  renderProfileSchema,
  renderProfileTool,
  type RenderProfile,
} from '../src/render-profile-schema.ts';
const COMPONENT_BYTES: Record<number, number> = {
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4,
};
const TYPE_COMPONENTS: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
};
type Accessor = NonNullable<ReturnType<typeof readGlb>['accessors']>[number];
type Primitive = NonNullable<
  NonNullable<ReturnType<typeof readGlb>['meshes']>[number]
>['primitives'][number];
function accessorBytes(accessor: Accessor | undefined) {
  if (!accessor) return 0;
  return (
    (accessor.count ?? 0) *
    (TYPE_COMPONENTS[accessor.type ?? ''] ?? 0) *
    (COMPONENT_BYTES[accessor.componentType ?? -1] ?? 0)
  );
}
function triangleCount(primitive: Primitive, accessors: Accessor[]) {
  const count =
    accessors[primitive.indices ?? -1]?.count ??
    accessors[primitive.attributes.POSITION]?.count ??
    0;
  const mode = primitive.mode ?? 4;
  if (mode === 4) return Math.floor(count / 3);
  if (mode === 5 || mode === 6) return Math.max(0, count - 2);
  return 0;
}
// Walk the segment lengths instead of scanning for 0xFFC0. An Exif thumbnail carries its own
// frame header, and scanning finds it first, reporting the thumbnail as the image.
function jpegSize(bytes: Uint8Array) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1];
    // 0xFF fill bytes and standalone markers carry no length field.
    if (marker === 0xff) {
      offset++;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += 2;
      continue;
    }
    // Entropy-coded data starts before any frame header would have been found.
    if (marker === 0xd9 || marker === 0xda) return undefined;
    const length = view.getUint16(offset + 2);
    if (length < 2) return undefined;
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    )
      return offset + 9 <= bytes.length
        ? { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) }
        : undefined;
    offset += 2 + length;
  }
  return undefined;
}
// Dimensions decide VRAM, compressed bytes do not. glTF only allows PNG and JPEG.
export function imageSize(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.length > 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return { width: view.getUint32(16), height: view.getUint32(20) };
  return jpegSize(bytes);
}
// glTF allows images to be embedded either in the binary chunk or as a data URI.
function dataUriImage(uri: string) {
  const comma = uri.indexOf(',');
  if (!uri.startsWith('data:') || comma < 0) return undefined;
  const meta = uri.slice(5, comma);
  if (!meta.endsWith(';base64')) return undefined;
  return {
    mimeType: meta.slice(0, Math.max(0, meta.indexOf(';'))),
    bytes: Buffer.from(uri.slice(comma + 1), 'base64'),
  };
}
export function profileGlb(
  bytes: Uint8Array,
  measuredAt = new Date().toISOString(),
): RenderProfile {
  const gltf = readGlb(bytes);
  const nodes = gltf.nodes ?? [];
  const meshes = gltf.meshes ?? [];
  const accessors = gltf.accessors ?? [];
  const materials = gltf.materials ?? [];
  const primitives = meshes.reduce((total, mesh) => total + (mesh.primitives?.length ?? 0), 0);
  let drawCalls = 0;
  let trianglesDrawn = 0;
  let meshInstances = 0;
  const byMaterial = new Map<number, { drawCalls: number; triangles: number }>();
  const visited = new Set<number>();
  const visit = (index: number) => {
    // A node reachable twice would otherwise be charged twice; instances are separate nodes.
    if (visited.has(index)) return;
    visited.add(index);
    const node = nodes[index];
    if (!node) return;
    const mesh = node.mesh === undefined ? undefined : meshes[node.mesh];
    if (mesh) {
      meshInstances++;
      for (const primitive of mesh.primitives ?? []) {
        const triangles = triangleCount(primitive, accessors);
        drawCalls++;
        trianglesDrawn += triangles;
        const key = primitive.material ?? -1;
        const entry = byMaterial.get(key) ?? { drawCalls: 0, triangles: 0 };
        entry.drawCalls++;
        entry.triangles += triangles;
        byMaterial.set(key, entry);
      }
    }
    for (const child of node.children ?? []) visit(child);
  };
  for (const root of gltf.scenes?.[gltf.scene ?? 0]?.nodes ?? []) visit(root);
  let triangles = 0;
  let vertices = 0;
  let primitivesWithUv = 0;
  let primitivesWithTangent = 0;
  let primitivesWithColor = 0;
  let primitivesWithSkin = 0;
  const vertexAccessors = new Set<number>();
  const indexAccessors = new Set<number>();
  // A tangent accessor is only wasted when no primitive that uses it samples a normal map.
  const tangentAccessors = new Set<number>();
  const tangentAccessorsUsed = new Set<number>();
  for (const mesh of meshes)
    for (const primitive of mesh.primitives ?? []) {
      triangles += triangleCount(primitive, accessors);
      vertices += accessors[primitive.attributes.POSITION ?? -1]?.count ?? 0;
      for (const index of Object.values(primitive.attributes)) vertexAccessors.add(index);
      // Morph targets hold real vertex data and are uploaded alongside the base attributes.
      for (const target of primitive.targets ?? [])
        for (const index of Object.values(target)) vertexAccessors.add(index);
      if (primitive.indices !== undefined) indexAccessors.add(primitive.indices);
      if (primitive.attributes.TEXCOORD_0 !== undefined) primitivesWithUv++;
      if (primitive.attributes.TANGENT !== undefined) {
        primitivesWithTangent++;
        const tangent = primitive.attributes.TANGENT;
        tangentAccessors.add(tangent);
        if (materials[primitive.material ?? -1]?.normalTexture) tangentAccessorsUsed.add(tangent);
      }
      if (primitive.attributes.COLOR_0 !== undefined) primitivesWithColor++;
      if (primitive.attributes.JOINTS_0 !== undefined) primitivesWithSkin++;
    }
  const tangentBytesUnused = [...tangentAccessors]
    .filter((index) => !tangentAccessorsUsed.has(index))
    .reduce((total, index) => total + accessorBytes(accessors[index]), 0);
  const binary = readGlbBinary(bytes);
  const images = (gltf.images ?? []).map((image) => {
    const view = image.bufferView === undefined ? undefined : gltf.bufferViews?.[image.bufferView];
    const embedded = image.uri ? dataUriImage(image.uri) : undefined;
    const data =
      view && binary
        ? binary.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength)
        : embedded?.bytes;
    const size = data ? imageSize(data) : undefined;
    return {
      ...(image.name ? { name: image.name } : {}),
      mimeType: image.mimeType ?? embedded?.mimeType ?? '',
      bytes: view?.byteLength ?? embedded?.bytes.length ?? 0,
      width: size?.width ?? 0,
      height: size?.height ?? 0,
    };
  });
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
  return renderProfileSchema.parse({
    schema: 1,
    tool: renderProfileTool,
    measuredAt,
    glb: {
      hash: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
    },
    scene: {
      nodes: nodes.length,
      meshes: meshes.length,
      meshInstances,
      primitives,
      drawCalls,
      materials: materials.length,
      doubleSidedMaterials: materials.filter((material) => material.doubleSided).length,
    },
    geometry: {
      triangles,
      trianglesDrawn,
      vertices,
      vertexBytes: sum([...vertexAccessors].map((index) => accessorBytes(accessors[index]))),
      indexBytes: sum([...indexAccessors].map((index) => accessorBytes(accessors[index]))),
    },
    attributes: {
      primitivesWithUv,
      primitivesWithTangent,
      tangentBytesUnused,
      primitivesWithColor,
      primitivesWithSkin,
    },
    textures: {
      count: images.length,
      bytes: sum(images.map((image) => image.bytes)),
      // RGBA8 without mipmaps. A floor, not an estimate of the engine's real allocation.
      decodedBytes: sum(images.map((image) => image.width * image.height * 4)),
      maxEdge: Math.max(0, ...images.map((image) => Math.max(image.width, image.height))),
      items: images,
    },
    byMaterial: [...byMaterial]
      .map(([index, entry]) => ({
        name: materials[index]?.name ?? (index < 0 ? '(unassigned)' : `material ${index}`),
        drawCalls: entry.drawCalls,
        triangles: entry.triangles,
        doubleSided: materials[index]?.doubleSided ?? false,
      }))
      .sort((a, b) => b.triangles - a.triangles || a.name.localeCompare(b.name)),
  });
}
