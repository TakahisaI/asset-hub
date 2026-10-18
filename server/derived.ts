import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { REVISION } from 'three';
import { normalizeBakeInput, bakeRecipeSchema } from '../src/bake-schema.ts';
import { idSchema, assetSchema, behaviorSchema, type Asset } from '../src/schema.ts';
import { recipePath, resultPath, getDerivation } from './recipes.ts';
import { bakeGlb } from '../tools/bake.ts';
import { compareBake } from '../tools/bake-render.ts';
import { inspectGlb } from '../tools/inspect.ts';
import { profileGlb } from '../tools/profile.ts';
import { readGlb } from '../tools/glb.ts';
import { readBlob, putBlob, assertStorageReady } from './blobs.ts';
import { getRevision, getBehavior, behaviorPath, inspectAsset } from './operations.ts';
import {
  root,
  getAsset,
  digest,
  exists,
  assetPath,
  registerAsset,
  atomicJson,
  withLibraryLock,
} from './store.ts';
import { saveProfiles } from './profiles.ts';

async function toolStamp() {
  const codeRoot = fileURLToPath(new URL('..', import.meta.url));
  const files = [
    'tools/bake.ts',
    'tools/bake-render.ts',
    'tools/glb.ts',
    'server/derived.ts',
    'server/recipes.ts',
    'tools/browser.ts',
    'src/bake-schema.ts',
    'src/viewer.ts',
    'src/playback.ts',
    'package-lock.json',
  ];
  const source = await Promise.all(
    files.map(async (file) => [
      file,
      (await readFile(path.join(codeRoot, file))).toString('base64'),
    ]),
  );
  const { stdout } = await promisify(execFile)('git', ['rev-parse', 'HEAD'], { cwd: codeRoot });
  return {
    repository: 'TakahisaI/asset-hub' as const,
    commit: stdout.trim(),
    scriptHash: digest(Buffer.from(JSON.stringify(source))),
    runtime: `node ${process.version}; three r${REVISION}; ${process.platform}/${process.arch}`,
  };
}

export async function bakeAsset(
  sourceId: string,
  id: string,
  raw: unknown,
  revision?: string,
  write = false,
) {
  idSchema.parse(sourceId);
  idSchema.parse(id);
  assert(sourceId !== id, '派生元と同じIDには登録できません');
  await assertStorageReady();
  const input = normalizeBakeInput(raw);
  const head = await getAsset(sourceId);
  const source = await getRevision(sourceId, revision ?? head.revision);
  assert.equal(source.schema, 1, '派生アセットの再統合には未対応です');
  assert(!source.vfx, 'VFXの統合には未対応です');
  const behaviorHash = source.revision === head.revision ? head.behavior : source.behavior;
  const behavior = behaviorHash ? await getBehavior(behaviorHash) : undefined;
  if (behavior)
    assert(
      behavior.assetId === sourceId && behavior.modelRevision === source.revision,
      '動作設定と入力版が一致しません',
    );
  const bytes = await readBlob(source.revision);
  assert.equal(digest(bytes), source.revision, '入力GLBのSHA-256が一致しません');
  assert.equal((await inspectGlb(bytes)).qa.errors, 0, '仕様エラーのある入力は統合できません');
  const moving = new Set<number>();
  const motions: Record<string, Uint8Array> = {};
  for (const preset of behavior?.presets ?? []) {
    preset.rotations.forEach((rotation) => moving.add(rotation.node));
    if (preset.clip?.source) {
      const s = preset.clip.source;
      const structure = await inspectAsset(s.id, s.revision);
      const clip = structure.clips[preset.clip.index];
      assert(clip, '参照モーションにクリップがありません');
      for (const channel of clip.channels) {
        const target: number | undefined =
          channel.node === undefined ? undefined : preset.clip.nodeMap?.[channel.node];
        assert(target !== undefined, '参照モーションの対象ノードが確定していません');
        moving.add(target);
      }
      motions[s.revision] = await readBlob(s.revision);
    }
  }
  const recipe = bakeRecipeSchema.parse({
    schema: 1,
    operation: 'merge-rigid-material',
    source: { id: sourceId, revision: source.revision },
    ...(behaviorHash ? { behavior: behaviorHash } : {}),
    tool: await toolStamp(),
    ...input,
  });
  const recipeHash = digest(Buffer.from(JSON.stringify(recipe)));
  const generated = bakeGlb(bytes, input, [...moving]);
  const hash = digest(generated.bytes);
  for (let run = 1; run < 3; run++)
    assert.equal(
      digest(bakeGlb(bytes, input, [...moving]).bytes),
      hash,
      '同条件で出力が再現しません',
    );
  const inspection = await inspectGlb(generated.bytes);
  assert.equal(inspection.qa.errors, 0, '生成GLBの仕様検証が失敗しました');
  const before = profileGlb(bytes),
    after = profileGlb(generated.bytes);
  assert.equal(
    before.geometry.trianglesDrawn,
    after.geometry.trianglesDrawn,
    '描画三角形が増減しました',
  );
  assert.equal(
    before.textures.decodedBytes,
    after.textures.decodedBytes,
    'テクスチャ展開後容量が変わりました',
  );
  assert.deepEqual(
    readGlb(bytes).materials,
    readGlb(generated.bytes).materials,
    '材質が変わりました',
  );
  const rendered = await compareBake(bytes, generated.bytes, recipe, behavior, motions);
  const { images, ...render } = rendered;
  const result = {
    schema: 1,
    recipe: recipeHash,
    source: recipe.source,
    output: hash,
    reproductions: 3,
    geometry: {
      triangles: generated.triangles,
      maxPositionError: generated.maxPositionError,
      maxAttributeError: generated.maxAttributeError,
      ranges: generated.ranges,
    },
    render,
    before,
    after,
  };
  if (!write) return { registered: false, id, recipe: recipeHash, result };
  const asset = await withLibraryLock(async () => {
    if (await exists(assetPath(id))) {
      const existing = await getAsset(id);
      assert(
        existing.schema === 2 &&
          existing.revision === hash &&
          existing.derivedFrom.recipe === recipeHash,
        '既存IDの版・来歴は変更できません。別IDを指定してください',
      );
      return existing;
    }
    // Publish the asset last; failures cannot expose an asset with missing supporting records.
    if (!(await exists(recipePath(recipeHash)))) await atomicJson(recipePath(recipeHash), recipe);
    const resultDir = path.join(root, 'catalog/recipes/results', recipeHash);
    await mkdir(resultDir, { recursive: true });
    if (!(await exists(resultPath(recipeHash)))) {
      for (const image of images)
        await writeFile(path.join(resultDir, image.name), Buffer.from(image.data, 'base64'));
      await atomicJson(resultPath(recipeHash), result);
    }
    await putBlob(generated.bytes);
    let derivedBehavior: string | undefined;
    if (behavior) {
      const adapted = behaviorSchema.parse({ ...behavior, assetId: id, modelRevision: hash });
      derivedBehavior = digest(Buffer.from(JSON.stringify(adapted)));
      await atomicJson(behaviorPath(derivedBehavior), adapted);
    }
    await saveProfiles([after]);
    const now = new Date().toISOString();
    const asset: Asset = assetSchema.parse({
      schema: 2,
      id,
      name: `${head.name}（統合派生）`,
      description: head.description,
      category: head.category,
      kind: head.kind,
      tags: head.tags,
      collections: head.collections,
      license: head.license,
      derivedFrom: { id: sourceId, revision: source.revision, recipe: recipeHash },
      source: {
        repository: recipe.tool.repository,
        commit: recipe.tool.commit,
        path: 'tools/bake.ts',
        kind: 'procedural',
        upstreamId: sourceId,
        specification: recipePath(recipeHash),
        verification: path.join(root, 'catalog/recipes/results', recipeHash + '.json'),
        scope:
          '固定版の剛体グループを材質・頂点属性構成ごとに統合。正本・部位別検査の代用にはなりません。',
        integrationNote:
          '数値と限定した視点の比較であり、全環境の見た目・スケール・ゲーム組込みは保証しません。元のBINを保持するためファイルサイズが増える場合があります。',
      },
      revision: hash,
      file: { hash, bytes: generated.bytes.length, name: id + '.glb' },
      ...inspection,
      ...(derivedBehavior ? { behavior: derivedBehavior } : {}),
      importedAt: now,
      updatedAt: now,
    });
    await getDerivation(asset);
    return registerAsset(asset, { createOnly: true });
  });
  return { registered: true, id, recipe: recipeHash, asset, result };
}
