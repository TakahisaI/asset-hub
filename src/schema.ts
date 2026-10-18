import { z } from 'zod';
import { vfxInfoSchema } from './vfx-schema.ts';
import type { RenderProfile } from './render-profile-schema.ts';
export const categories = {
  buildings: '建築',
  props: '小道具',
  ships: '船',
  environments: '地形・島',
  animals: '動物',
  characters: '人物',
  motions: 'モーション',
  effects: 'VFX',
  other: 'その他',
};
export const idSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,159}$/);
export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const downloadSchema = z
  .object({
    repository: z.string().regex(/^[\w-]+\/[\w.-]+$/),
    commit: z.string().regex(/^[a-f0-9]{40}$/),
    path: z.string().min(1),
  })
  .strict();
export const vectorSchema = z.tuple([
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
]);
const nodeIndex = z.number().int().nonnegative();
export const behaviorSchema = z
  .object({
    schema: z.literal(1),
    assetId: idSchema,
    modelRevision: hashSchema,
    presets: z
      .array(
        z
          .object({
            id: idSchema,
            name: z.string().min(1).max(160),
            clip: z
              .object({
                index: nodeIndex,
                source: z.object({ id: idSchema, revision: hashSchema }).strict().optional(),
                nodeMap: z.record(z.string().regex(/^\d+$/), nodeIndex).optional(),
              })
              .strict()
              .optional(),
            speed: z.number().finite().min(0).max(20).default(1),
            loop: z.boolean().default(true),
            duration: z.number().finite().positive().max(3600).default(10),
            rotations: z
              .array(
                z
                  .object({
                    node: nodeIndex,
                    axis: vectorSchema.refine(
                      (v) => Math.hypot(...v) > 0,
                      '回転軸はゼロにできません',
                    ),
                    rpm: z.number().finite().min(-10000).max(10000),
                  })
                  .strict(),
              )
              .max(100)
              .default([]),
            lights: z
              .array(
                z
                  .object({
                    node: nodeIndex,
                    intensity: z.number().finite().min(0).max(100000),
                    // Omit type to control a light already embedded in the GLB.
                    type: z.enum(['point', 'spot']).optional(),
                    color: z
                      .string()
                      .regex(/^#[a-fA-F0-9]{6}$/)
                      .default('#ffffff'),
                    range: z.number().finite().min(0).default(0),
                    angle: z
                      .number()
                      .finite()
                      .gt(0)
                      .lte(Math.PI / 2)
                      .default(Math.PI / 6),
                  })
                  .strict(),
              )
              .max(100)
              .default([]),
          })
          .strict(),
      )
      .max(100)
      .refine((p) => new Set(p.map((x) => x.id)).size === p.length, '動作IDが重複しています'),
  })
  .strict();
export type Behavior = z.infer<typeof behaviorSchema>;
export type Preset = Behavior['presets'][number];
export const playbackSchema = z
  .object({
    behavior: hashSchema.optional(),
    preset: idSchema.optional(),
    clip: nodeIndex.optional(),
    time: z.number().finite().nonnegative(),
    rotationTime: z.number().finite().nonnegative().optional(),
    speed: z.number().finite().min(0).max(20),
    loop: z.boolean(),
  })
  .strict();
const assetRecordSchema = z
  .object({
    schema: z.literal(1),
    id: idSchema,
    name: z.string().min(1).max(160),
    description: z.string().max(12000),
    category: z.enum([
      'buildings',
      'props',
      'ships',
      'environments',
      'animals',
      'characters',
      'motions',
      'effects',
      'other',
    ]),
    kind: z.enum(['model', 'motion']).optional(),
    behavior: hashSchema.optional(),
    tags: z.array(z.string().min(1).max(80)).max(40),
    collections: z.array(z.string().min(1).max(80)).max(40),
    license: z.string().max(500),
    source: z
      .object({
        repository: z.union([z.literal('local'), z.string().regex(/^[\w-]+\/[\w.-]+$/)]),
        commit: z.union([z.literal(''), z.string().regex(/^[a-f0-9]{40}$/)]),
        path: z.string(),
        kind: z.enum(['blender', 'procedural', 'other']),
        upstreamId: z.string(),
        specification: z.string().optional(),
        verification: z.string().optional(),
        scope: z.string(),
        integrationNote: z.string(),
      })
      .strict(),
    revision: hashSchema,
    file: z
      .object({
        hash: hashSchema,
        bytes: z.number().int().nonnegative(),
        name: z.string(),
        upstreamPath: z.string().optional(),
        download: downloadSchema.optional(),
      })
      .strict(),
    metrics: z
      .object({
        triangles: z.number().int().nonnegative(),
        vertices: z.number().int().nonnegative(),
        meshes: z.number().int().nonnegative(),
        materials: z.number().int().nonnegative(),
        textures: z.number().int().nonnegative(),
        animations: z.number().int().nonnegative(),
      })
      .strict(),
    qa: z
      .object({
        errors: z.number().int().nonnegative(),
        warnings: z.number().int().nonnegative(),
        messages: z.array(
          z
            .object({
              code: z.string(),
              message: z.string(),
              severity: z.number().int().nonnegative(),
              pointer: z.string().optional(),
            })
            .strict(),
        ),
      })
      .strict(),
    importWarnings: z.array(z.string()).optional(),
    vfx: vfxInfoSchema.optional(),
    importedAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict();
export const assetSchema = assetRecordSchema.refine(
  (asset) => asset.revision === asset.file.hash,
  'リビジョンとGLBハッシュが一致しません',
);
export type Asset = z.infer<typeof assetSchema>;
export const editSchema = assetRecordSchema
  .pick({
    name: true,
    description: true,
    category: true,
    tags: true,
    collections: true,
    license: true,
  })
  .partial()
  .strict();
export const noteInput = z
  .object({
    revision: hashSchema,
    text: z.string().trim().min(1).max(10000),
    camera: z.object({ position: vectorSchema, target: vectorSchema }).strict().optional(),
    playback: playbackSchema.optional(),
  })
  .strict();
export const reviewNoteSchema = noteInput.extend({
  id: z.string().min(1),
  assetId: idSchema,
  createdAt: z.iso.datetime(),
  resolved: z.boolean(),
});
export type ReviewNote = z.infer<typeof reviewNoteSchema>;
export type CatalogProblem = { file: string; message: string };
export type CatalogAsset = Asset & {
  available: boolean;
  thumbnail: boolean;
  notesCount: number;
  profile?: RenderProfile | null;
  profileError?: string;
};
export function sourceUrl(a: Asset, path = a.source.path) {
  return `https://github.com/${a.source.repository}/blob/${a.source.commit}/${path.split('/').map(encodeURIComponent).join('/')}`;
}
