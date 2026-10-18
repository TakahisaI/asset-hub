import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { bakeRecipeSchema } from '../src/bake-schema.ts';
import { hashSchema, idSchema, type Asset } from '../src/schema.ts';
import { renderProfileSchema } from '../src/render-profile-schema.ts';
import { root, digest } from './store.ts';
import { getRevision, getBehavior } from './operations.ts';

export const recipePath = (hash: string) =>
  path.join(root, 'catalog/recipes', hashSchema.parse(hash) + '.json');
export const resultPath = (hash: string) =>
  path.join(root, 'catalog/recipes/results', hashSchema.parse(hash) + '.json');
const resultSchema = z
  .object({
    schema: z.literal(1),
    recipe: hashSchema,
    source: z.object({ id: idSchema, revision: hashSchema }).strict(),
    output: hashSchema,
    reproductions: z.literal(3),
    geometry: z
      .object({
        triangles: z.number().int().nonnegative(),
        maxPositionError: z.number().nonnegative(),
        maxAttributeError: z.number().nonnegative(),
        ranges: z.array(
          z
            .object({
              node: z.number().int().nonnegative(),
              primitive: z.number().int().nonnegative(),
              outputNode: z.number().int().nonnegative(),
              outputPrimitive: z.number().int().nonnegative(),
              firstVertex: z.number().int().nonnegative(),
              vertices: z.number().int().positive(),
              firstIndex: z.number().int().nonnegative(),
              indices: z.number().int().nonnegative(),
            })
            .strict(),
        ),
      })
      .strict(),
    render: z
      .object({
        width: z.literal(384),
        height: z.literal(288),
        near: z.literal('span/200'),
        browser: z.string(),
        poses: z
          .array(
            z
              .object({
                clip: z.number().int().nonnegative().optional(),
                preset: z.number().int().nonnegative().optional(),
                time: z.number().nonnegative(),
              })
              .strict(),
          )
          .min(1),
        samples: z
          .array(
            z
              .object({
                pose: z.number().int().nonnegative(),
                mode: z.enum(['pbr', 'normal', 'wireframe']),
                view: z.number().int().min(0).max(7),
                maxError: z.number().min(0).max(2),
                changedRatio: z.number().min(0).max(0.001),
              })
              .strict(),
          )
          .min(24),
      })
      .strict(),
    before: renderProfileSchema,
    after: renderProfileSchema,
  })
  .strict();

export async function getRecipe(hash: string) {
  const recipe = bakeRecipeSchema.parse(JSON.parse(await readFile(recipePath(hash), 'utf8')));
  assert.equal(digest(Buffer.from(JSON.stringify(recipe))), hash, 'レシピのSHA-256が一致しません');
  const source = await getRevision(recipe.source.id, recipe.source.revision);
  assert.equal(source.schema, 1, 'レシピの入力は正本に限ります');
  if (recipe.behavior) {
    const behavior = await getBehavior(recipe.behavior);
    assert(
      behavior.assetId === source.id && behavior.modelRevision === source.revision,
      'レシピの動作設定と入力版が一致しません',
    );
  }
  return recipe;
}
export async function getDerivation(asset: Asset) {
  assert(asset.schema === 2, '派生アセットではありません');
  const recipe = await getRecipe(asset.derivedFrom.recipe);
  assert.deepEqual(
    recipe.source,
    { id: asset.derivedFrom.id, revision: asset.derivedFrom.revision },
    '派生元とレシピが一致しません',
  );
  const result = resultSchema.parse(
    JSON.parse(await readFile(resultPath(asset.derivedFrom.recipe), 'utf8')),
  );
  assert.equal(result.recipe, asset.derivedFrom.recipe, '検証結果とレシピが一致しません');
  assert.deepEqual(result.source, recipe.source, '検証結果の入力版が一致しません');
  assert.equal(result.output, asset.revision, '検証結果と出力GLBが一致しません');
  assert.equal(result.before.glb.hash, recipe.source.revision, '計測結果の入力版が一致しません');
  assert.equal(result.after.glb.hash, asset.revision, '計測結果の出力版が一致しません');
  assert(
    result.geometry.maxPositionError <= Number(recipe.checks.positionToleranceMeters) &&
      result.geometry.maxAttributeError <= Number(recipe.checks.normalUvTangentTolerance) &&
      result.before.geometry.trianglesDrawn === result.after.geometry.trianglesDrawn &&
      result.before.textures.decodedBytes === result.after.textures.decodedBytes,
    '検証結果がレシピの幾何条件を満たしません',
  );
  const samples = result.render.samples;
  assert(
    samples.length === result.render.poses.length * 24 &&
      new Set(samples.map((s) => `${s.pose}/${s.mode}/${s.view}`)).size === samples.length &&
      samples.every(
        (s) =>
          s.pose < result.render.poses.length &&
          s.maxError <= recipe.checks.imageMaxChannelError &&
          s.changedRatio <= Number(recipe.checks.imageMaxChangedPixelRatio),
      ),
    '検証結果にレンダーの不足または閾値超過があります',
  );
  return { recipe, result };
}
