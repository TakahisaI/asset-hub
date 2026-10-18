import assert from 'node:assert/strict';
import { Matrix3, Matrix4, Quaternion, Vector3 } from 'three';
import { normalizeBakeInput } from '../src/bake-schema.ts';
import { readGlb, readGlbBinary, writeGlb, type Gltf } from './glb.ts';

type Primitive = NonNullable<Gltf['meshes']>[number]['primitives'][number];
const widths: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const supportedExtensions = new Set([
  'KHR_lights_punctual',
  'KHR_texture_transform',
  'KHR_materials_sheen',
  'KHR_materials_unlit',
  'KHR_materials_specular',
  'KHR_materials_ior',
  'KHR_materials_clearcoat',
  'KHR_materials_emissive_strength',
  'KHR_materials_anisotropy',
]);

function accessorValues(g: Gltf, bin: Buffer, index: number) {
  const a = g.accessors?.[index];
  assert(
    a && a.count !== undefined && a.bufferView !== undefined && !a.sparse && !a.normalized,
    '統合するaccessorはbufferViewを持つ非sparse・非normalized形式が必要です',
  );
  const view = g.bufferViews?.[a.bufferView];
  assert(
    view && view.buffer === 0 && !g.buffers?.[0]?.uri,
    '統合する頂点はGLBのBINに埋め込んでください',
  );
  const width = widths[a.type ?? ''];
  const size =
    a.componentType === 5126 || a.componentType === 5125
      ? 4
      : a.componentType === 5123
        ? 2
        : a.componentType === 5121
          ? 1
          : 0;
  assert(width && size, '未対応のaccessor形式です');
  const stride = view.byteStride ?? width * size;
  const start = (view.byteOffset ?? 0) + (a.byteOffset ?? 0);
  assert(
    stride >= width * size &&
      start + (a.count - 1) * stride + width * size <= (view.byteOffset ?? 0) + view.byteLength &&
      start >= 0 &&
      (view.byteOffset ?? 0) + view.byteLength <= bin.length,
    'accessorの範囲が不正です',
  );
  const values = new Float64Array(a.count * width);
  for (let i = 0; i < a.count; i++)
    for (let c = 0; c < width; c++) {
      const offset = start + i * stride + c * size;
      const value: number =
        a.componentType === 5126
          ? bin.readFloatLE(offset)
          : size === 4
            ? bin.readUInt32LE(offset)
            : size === 2
              ? bin.readUInt16LE(offset)
              : bin[offset];
      assert(Number.isFinite(value), '頂点に非有限値があります');
      values[i * width + c] = value;
    }
  return { accessor: a, width, values };
}

export function bakeGlb(bytes: Uint8Array, raw: unknown, movingNodes: number[] = []) {
  const input = normalizeBakeInput(raw);
  const source = readGlb(bytes);
  const g = structuredClone(source);
  const binary = readGlbBinary(bytes);
  assert(binary && g.buffers?.[0] && !g.buffers[0].uri, 'BINを持つGLBが必要です');
  assert(g.scenes?.length === 1, '初版の統合は単一シーンのGLBに限ります');
  assert(!g.extras?.assetHubVfx, 'VFXの統合には未対応です');
  for (const extension of [...(g.extensionsUsed ?? []), ...(g.extensionsRequired ?? [])])
    assert(supportedExtensions.has(extension), `未対応の拡張です: ${extension}`);
  const nodes = g.nodes ?? [];
  const meshes = g.meshes ?? [];
  const accessors = (g.accessors ??= []);
  const views = (g.bufferViews ??= []);
  const originalNodes = nodes.length;
  const parents = new Map<number, number>();
  nodes.forEach((node, index) =>
    (node.children ?? []).forEach((child) => {
      assert(nodes[child] && !parents.has(child), 'ノード階層が不正または複数の親があります');
      parents.set(child, index);
    }),
  );
  const active = new Set<number>();
  const visit = (index: number) => {
    assert(nodes[index] && !active.has(index), '既定シーンに循環または重複ノードがあります');
    active.add(index);
    (nodes[index].children ?? []).forEach(visit);
  };
  (g.scenes?.[g.scene ?? 0]?.nodes ?? []).forEach(visit);
  const moving = new Set(movingNodes);
  for (const clip of g.animations ?? [])
    for (const channel of clip.channels) {
      assert(
        channel.target.node !== undefined &&
          ['translation', 'rotation', 'scale'].includes(channel.target.path),
        '未対応のアニメーションです',
      );
      moving.add(channel.target.node);
    }
  const world = new Map<number, Matrix4>();
  const matrix = (index: number): Matrix4 => {
    const existing = world.get(index);
    if (existing) return existing;
    const node = nodes[index];
    const local = node.matrix
      ? new Matrix4().fromArray(node.matrix)
      : new Matrix4().compose(
          new Vector3().fromArray(node.translation ?? [0, 0, 0]),
          new Quaternion().fromArray(node.rotation ?? [0, 0, 0, 1]),
          new Vector3().fromArray(node.scale ?? [1, 1, 1]),
        );
    const parent = parents.get(index);
    const value = parent === undefined ? local : matrix(parent).clone().multiply(local);
    assert(
      value.elements.every(Number.isFinite) && Math.abs(value.determinant()) > 1e-12,
      '特異または非有限な変換は統合できません',
    );
    world.set(index, value);
    return value;
  };
  const chunks: Buffer[] = [binary];
  let offset = binary.length;
  const append = (
    data: Buffer,
    type: string,
    count: number,
    componentType: number,
    bounds?: { min: number[]; max: number[] },
  ) => {
    const padding = (4 - (offset % 4)) % 4;
    if (padding) {
      chunks.push(Buffer.alloc(padding));
      offset += padding;
    }
    const view = views.push({ buffer: 0, byteOffset: offset, byteLength: data.length }) - 1;
    chunks.push(data);
    offset += data.length;
    return accessors.push({ bufferView: view, componentType, type, count, ...bounds }) - 1;
  };
  const ranges: {
    node: number;
    primitive: number;
    outputNode: number;
    outputPrimitive: number;
    firstVertex: number;
    vertices: number;
    firstIndex: number;
    indices: number;
  }[] = [];
  let maxPositionError = 0;
  let maxAttributeError = 0;
  let triangles = 0;
  for (const group of input.groups) {
    assert(active.has(group.rootNode), '統合rootが既定シーンにありません');
    const rootWorld = matrix(group.rootNode);
    const inverse = rootWorld.clone().invert();
    type Part = { node: number; primitive: number; data: Primitive; transform: Matrix4 };
    const buckets = new Map<string, Part[]>();
    for (const index of group.nodes) {
      assert(
        active.has(index) && nodes[index]?.mesh !== undefined,
        `統合対象にメッシュがありません: ${index}`,
      );
      let cursor = index;
      while (cursor !== group.rootNode) {
        assert(!moving.has(cursor), `可動ノードを跨いだ統合はできません: ${cursor}`);
        const parent = parents.get(cursor);
        assert(parent !== undefined, `対象ノードはrootの部分木にありません: ${index}`);
        cursor = parent;
      }
      const node = nodes[index];
      assert(
        node.skin === undefined && !node.extensions?.EXT_mesh_gpu_instancing,
        'スキニング・GPU instancingには未対応です',
      );
      const transform = inverse.clone().multiply(matrix(index));
      for (const [primitive, data] of meshes[node.mesh!].primitives.entries()) {
        assert(
          (data.mode ?? 4) === 4 && !data.targets && !data.extensions,
          '統合は拡張・morphのない三角形primitiveに限ります',
        );
        assert(
          g.materials?.[data.material ?? -1]?.alphaMode !== 'BLEND',
          '透過描画の統合には未対応です',
        );
        const layout = Object.entries(data.attributes).sort(([a], [b]) => a.localeCompare(b, 'en'));
        for (const [semantic, index] of layout) {
          assert(
            /^(POSITION|NORMAL|TANGENT|TEXCOORD_\d+|COLOR_\d+)$/.test(semantic),
            `未対応の頂点属性です: ${semantic}`,
          );
          assert(accessors[index]?.componentType === 5126, '初版の頂点属性はFLOAT形式に限ります');
        }
        assert(data.attributes.POSITION !== undefined, 'POSITIONが必要です');
        const key = JSON.stringify([
          data.material ?? -1,
          layout.map(([name, index]) => [name, accessors[index].type]),
        ]);
        const parts = buckets.get(key) ?? [];
        parts.push({ node: index, primitive, data, transform });
        buckets.set(key, parts);
      }
    }
    const outputNode = nodes.length;
    const outputPrimitives: Primitive[] = [];
    for (const parts of buckets.values()) {
      const names = Object.keys(parts[0].data.attributes).sort();
      const attributeChunks = new Map(names.map((name) => [name, [] as Buffer[]]));
      const indexChunks: Buffer[] = [];
      let vertexCount = 0,
        indexCount = 0;
      const min = [Infinity, Infinity, Infinity],
        max = [-Infinity, -Infinity, -Infinity];
      for (const part of parts) {
        const positions = accessorValues(g, binary, part.data.attributes.POSITION);
        assert(positions.width === 3, 'POSITIONはVEC3が必要です');
        const count = positions.accessor.count!;
        const normalMatrix = new Matrix3().getNormalMatrix(part.transform);
        const reflected = part.transform.determinant() < 0;
        const identity = part.transform.equals(new Matrix4());
        for (const name of names) {
          const { values, width, accessor } = accessorValues(g, binary, part.data.attributes[name]);
          assert(
            accessor.count === count &&
              (name !== 'NORMAL' || width === 3) &&
              (name !== 'TANGENT' || width === 4),
            '頂点属性の構成が不正です',
          );
          const data = Buffer.alloc(values.length * 4);
          for (let vertex = 0; vertex < count; vertex++) {
            const item = Array.from(values.subarray(vertex * width, (vertex + 1) * width));
            const original = new Vector3().fromArray(item);
            if (name === 'POSITION')
              new Vector3().fromArray(item).applyMatrix4(part.transform).toArray(item);
            if (name === 'NORMAL' && !identity)
              new Vector3().fromArray(item).applyNormalMatrix(normalMatrix).toArray(item);
            if (name === 'TANGENT' && !identity) {
              new Vector3().fromArray(item).transformDirection(part.transform).toArray(item);
              if (reflected) item[3] *= -1;
            }
            for (let c = 0; c < width; c++) {
              data.writeFloatLE(item[c], (vertex * width + c) * 4);
              const stored = data.readFloatLE((vertex * width + c) * 4);
              assert(Number.isFinite(stored), '変換後の頂点がFLOATの範囲を超えました');
              if (name === 'POSITION') {
                min[c] = Math.min(min[c], stored);
                max[c] = Math.max(max[c], stored);
              } else maxAttributeError = Math.max(maxAttributeError, Math.abs(stored - item[c]));
            }
            if (name === 'POSITION') {
              const stored = new Vector3(
                data.readFloatLE(vertex * 12),
                data.readFloatLE(vertex * 12 + 4),
                data.readFloatLE(vertex * 12 + 8),
              ).applyMatrix4(rootWorld);
              maxPositionError = Math.max(
                maxPositionError,
                stored.distanceTo(original.applyMatrix4(matrix(part.node))),
              );
            }
          }
          attributeChunks.get(name)!.push(data);
        }
        const indices: Float64Array =
          part.data.indices === undefined
            ? Float64Array.from({ length: count }, (_, i) => i)
            : accessorValues(g, binary, part.data.indices).values;
        if (part.data.indices !== undefined)
          assert(
            accessors[part.data.indices].type === 'SCALAR' &&
              [5121, 5123, 5125].includes(accessors[part.data.indices].componentType!),
            'indexは符号なし整数SCALARが必要です',
          );
        assert(indices.length % 3 === 0, '三角形のindex数が不正です');
        const data = Buffer.alloc(indices.length * 4);
        for (let i = 0; i < indices.length; i++) {
          const at = reflected && i % 3 !== 0 ? i + (i % 3 === 1 ? 1 : -1) : i;
          assert(
            Number.isInteger(indices[at]) && indices[at] >= 0 && indices[at] < count,
            'indexが頂点の範囲を超えています',
          );
          data.writeUInt32LE(indices[at] + vertexCount, i * 4);
        }
        indexChunks.push(data);
        ranges.push({
          node: part.node,
          primitive: part.primitive,
          outputNode,
          outputPrimitive: outputPrimitives.length,
          firstVertex: vertexCount,
          vertices: count,
          firstIndex: indexCount,
          indices: indices.length,
        });
        vertexCount += count;
        indexCount += indices.length;
        triangles += indices.length / 3;
      }
      const attributes: Record<string, number> = {};
      for (const name of names) {
        const type = accessors[parts[0].data.attributes[name]].type!;
        attributes[name] = append(
          Buffer.concat(attributeChunks.get(name)!),
          type,
          vertexCount,
          5126,
          name === 'POSITION' ? { min, max } : undefined,
        );
      }
      outputPrimitives.push({
        attributes,
        indices: append(Buffer.concat(indexChunks), 'SCALAR', indexCount, 5125),
        ...(parts[0].data.material === undefined ? {} : { material: parts[0].data.material }),
      });
    }
    nodes.push({
      name: `baked-group-${group.rootNode}`,
      mesh: meshes.push({ primitives: outputPrimitives }) - 1,
    });
    nodes[group.rootNode].children = [...(nodes[group.rootNode].children ?? []), outputNode];
  }
  for (const index of input.groups.flatMap((g) => g.nodes)) delete nodes[index].mesh;
  assert(
    maxPositionError <= Number(input.checks.positionToleranceMeters),
    `位置の誤差が閾値を超えました: ${maxPositionError}`,
  );
  assert(
    maxAttributeError <= Number(input.checks.normalUvTangentTolerance),
    `属性の誤差が閾値を超えました: ${maxAttributeError}`,
  );
  const used = new Set(nodes.flatMap((n) => (n.mesh === undefined ? [] : [n.mesh])));
  const remap = new Map<number, number>();
  g.meshes = meshes.filter((_, i) => {
    if (!used.has(i)) return false;
    remap.set(i, remap.size);
    return true;
  });
  for (const node of nodes) if (node.mesh !== undefined) node.mesh = remap.get(node.mesh)!;
  // shortcut: original BIN/accessors remain for unchanged resources; compact them when storage becomes the measured bottleneck.
  g.buffers[0].byteLength = offset;
  const output = writeGlb(g, Buffer.concat(chunks));
  assert.equal(nodes.length, originalNodes + input.groups.length);
  return { bytes: output, ranges, triangles, maxPositionError, maxAttributeError };
}
