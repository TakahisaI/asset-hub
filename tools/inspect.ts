// The validator checks glTF conformance; it does not certify visual quality.
// @ts-expect-error gltf-validator ships no TypeScript declarations
import validator from 'gltf-validator';
import { readGlb } from './glb.ts';
import { vfxInfoSchema, vfxSchema } from '../src/vfx-schema.ts';
export async function inspectGlb(bytes: Uint8Array) {
  const gltf = readGlb(bytes) as any;
  if (
    [...(gltf.buffers ?? []), ...(gltf.images ?? [])].some(
      (x) => x.uri && !x.uri.startsWith('data:'),
    )
  )
    throw new Error('外部ファイルを参照するGLBは取り込めません。埋め込みで書き出してください');
  let triangles = 0,
    vertices = 0;
  for (const mesh of gltf.meshes ?? [])
    for (const p of mesh.primitives ?? []) {
      const count =
        gltf.accessors?.[p.indices]?.count ?? gltf.accessors?.[p.attributes.POSITION]?.count ?? 0;
      vertices += gltf.accessors?.[p.attributes.POSITION]?.count ?? 0;
      const mode = p.mode ?? 4;
      triangles +=
        mode === 4 ? Math.floor(count / 3) : mode === 5 || mode === 6 ? Math.max(0, count - 2) : 0;
    }
  const result = await validator.validateBytes(bytes, { maxIssues: 100 });
  const vfx =
    gltf.extras?.assetHubVfx === undefined ? undefined : vfxSchema.parse(gltf.extras.assetHubVfx);
  if (
    vfx &&
    (!gltf.animations?.[vfx.clip] ||
      [...vfx.smoke, ...vfx.emission].some((t) => !gltf.materials?.[t.material]))
  )
    throw new Error('VFXのクリップまたは材質が見つかりません');
  if (vfx) {
    const duration = gltf.animations[vfx.clip].samplers.reduce(
      (max: number, sampler: { input: number }) =>
        Math.max(max, gltf.accessors[sampler.input].max?.[0] ?? 0),
      0,
    );
    if (vfx.times.at(-1)! > duration + 1e-4)
      throw new Error('VFXの再生範囲がGLBクリップを超えています');
  }
  return {
    ...(vfx
      ? {
          vfx: vfxInfoSchema.parse({
            runtime: vfx.runtime,
            source: vfx.source,
            preview: vfx.preview,
            limitations: vfx.limitations,
          }),
        }
      : {}),
    metrics: {
      triangles,
      vertices,
      meshes: gltf.meshes?.length ?? 0,
      materials: gltf.materials?.length ?? 0,
      textures: gltf.textures?.length ?? 0,
      animations: gltf.animations?.length ?? 0,
    },
    qa: {
      errors: result.issues.numErrors,
      warnings: result.issues.numWarnings,
      messages: result.issues.messages
        .sort((a: { severity: number }, b: { severity: number }) => a.severity - b.severity)
        .slice(0, 25)
        .map((m: { code: string; message: string; severity: number; pointer?: string }) => ({
          code: m.code,
          message: m.message,
          severity: m.severity,
          pointer: m.pointer,
        })),
    },
  };
}
