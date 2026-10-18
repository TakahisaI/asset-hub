import { z } from 'zod';
import { idSchema, hashSchema } from './schema.ts';

const index = z.number().int().nonnegative();
const tolerance = z
  .string()
  .regex(/^0\.(0*[1-9]\d*)$/)
  .refine((v) => Number(v) <= 0.001 && !v.endsWith('0'));
export const bakeInputSchema = z
  .object({
    groups: z.array(z.object({ rootNode: index, nodes: z.array(index).min(1) }).strict()).min(1),
    checks: z
      .object({
        positionToleranceMeters: tolerance.default('0.000001'),
        normalUvTangentTolerance: tolerance.default('0.000001'),
        imageMaxChannelError: z.number().int().min(0).max(255).default(2),
        imageMaxChangedPixelRatio: tolerance.default('0.001'),
      })
      .strict()
      .default({
        positionToleranceMeters: '0.000001',
        normalUvTangentTolerance: '0.000001',
        imageMaxChannelError: 2,
        imageMaxChangedPixelRatio: '0.001',
      }),
  })
  .strict()
  .refine(
    ({ groups }) =>
      new Set(groups.map((g) => g.rootNode)).size === groups.length &&
      new Set(groups.flatMap((g) => g.nodes)).size ===
        groups.reduce((n, g) => n + g.nodes.length, 0),
    'グループや対象ノードが重複しています',
  );

export function normalizeBakeInput(raw: unknown) {
  const { groups, checks } = bakeInputSchema.parse(raw);
  return {
    groups: groups
      .map((g) => ({ rootNode: g.rootNode, nodes: [...g.nodes].sort((a, b) => a - b) }))
      .sort((a, b) => a.rootNode - b.rootNode),
    checks,
  };
}

export const bakeRecipeSchema = z
  .object({
    schema: z.literal(1),
    operation: z.literal('merge-rigid-material'),
    source: z.object({ id: idSchema, revision: hashSchema }).strict(),
    behavior: hashSchema.optional(),
    tool: z
      .object({
        repository: z.literal('TakahisaI/asset-hub'),
        commit: z.string().regex(/^[a-f0-9]{40}$/),
        scriptHash: hashSchema,
        runtime: z.string().min(1),
      })
      .strict(),
    groups: z.array(z.object({ rootNode: index, nodes: z.array(index).min(1) }).strict()).min(1),
    checks: z
      .object({
        positionToleranceMeters: tolerance,
        normalUvTangentTolerance: tolerance,
        imageMaxChannelError: z.number().int().min(0).max(255),
        imageMaxChangedPixelRatio: tolerance,
      })
      .strict(),
  })
  .strict();
export type BakeRecipe = z.infer<typeof bakeRecipeSchema>;
