import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Page } from 'playwright';
import { rigidGlb, animatedGlb } from './fixtures.ts';
import { readGlb, readGlbBinary, writeGlb } from '../tools/glb.ts';

export async function testBakeRegistration(base: string, page: Page, temp: string) {
  const { bakeAsset } = await import('../server/derived.ts');
  const { importGlb, setBehavior, addNote, editAsset, getBehavior } =
    await import('../server/operations.ts');
  const { getAsset, getNotes, digest, registerAsset } = await import('../server/store.ts');
  const { readBlob } = await import('../server/blobs.ts');
  const { recipePath, resultPath, getDerivation } = await import('../server/recipes.ts');
  const { createLock, syncLock } = await import('../tools/assetctl.ts');
  const { backupLibrary, restoreBackup, verifyBackup } = await import('../tools/backup.ts');
  const bytes = rigidGlb();
  let source = await importGlb(bytes, 'rigid.glb', {
    id: 'test.rigid',
    name: '固定部品',
    tags: ['original'],
    collections: ['game'],
  });
  source = await setBehavior(
    source.id,
    {
      schema: 1,
      assetId: source.id,
      modelRevision: source.revision,
      presets: [
        {
          id: 'spin',
          name: '全体の回転',
          duration: 1,
          rotations: [{ node: 0, axis: [0, 1, 0], rpm: 15 }],
        },
      ],
    },
    source.updatedAt,
  );
  await addNote(source.id, { revision: source.revision, text: '正本に残すメモ' });
  const originalRecord = await readFile(path.join(temp, 'catalog/assets', source.id + '.json'));
  const originalNotes = await getNotes(source.id);
  const input = { groups: [{ rootNode: 0, nodes: [1, 2] }] };
  const dry = await bakeAsset(source.id, 'test.baked', input);
  assert.equal(dry.registered, false);
  await assert.rejects(() => getAsset('test.baked'), /ENOENT/);
  await assert.rejects(() => readFile(recipePath(dry.recipe!)), /ENOENT/);
  const written = await bakeAsset(source.id, 'test.baked', input, undefined, true);
  const derived = await getAsset('test.baked');
  assert.equal(written.registered, true);
  assert.equal(derived.schema, 2);
  assert(derived.schema === 2);
  assert.deepEqual(derived.derivedFrom, {
    id: source.id,
    revision: source.revision,
    recipe: dry.recipe,
  });
  assert.deepEqual(await readBlob(source.revision), bytes);
  assert.deepEqual(
    await readFile(path.join(temp, 'catalog/assets', source.id + '.json')),
    originalRecord,
  );
  assert.deepEqual(await getNotes(source.id), originalNotes);
  const provenance = await getDerivation(derived);
  assert.equal(provenance.result.before.scene.drawCalls, 2);
  assert.equal(provenance.result.after.scene.drawCalls, 1);
  assert.equal(provenance.result.reproductions, 3);
  assert.equal(provenance.result.render.samples.length, provenance.result.render.poses.length * 24);
  assert(provenance.result.render.poses.some((p) => p.preset === 0 && p.time === 1));
  const images = await readdir(
    path.join(temp, 'catalog/recipes/results', derived.derivedFrom.recipe),
  );
  assert.equal(images.length, provenance.result.render.samples.length * 2);
  const adapted = await getBehavior(derived.behavior!);
  assert.equal(adapted.assetId, derived.id);
  assert.equal(adapted.modelRevision, derived.revision);
  const saved = await editAsset(
    derived.id,
    { name: '利用側の名前', tags: ['keep'], collections: ['production'] },
    derived.updatedAt,
  );
  assert(saved.schema === 2);
  await addNote(derived.id, { revision: derived.revision, text: '派生版に残すメモ' });
  const notes = await getNotes(derived.id);
  await bakeAsset(source.id, derived.id, input, undefined, true);
  assert.deepEqual(await getAsset(derived.id), saved);
  assert.deepEqual(await getNotes(derived.id), notes);
  await assert.rejects(
    () => importGlb(bytes, 'edited.glb', { id: derived.id }, saved.updatedAt),
    /別ID/,
  );
  const { derivedFrom: _provenance, ...record } = saved;
  await assert.rejects(
    () => registerAsset({ ...record, schema: 1 }, { expected: saved.updatedAt }),
    /派生/,
  );
  await page.goto(base + '?asset=' + derived.id);
  await page.getByRole('heading', { name: '統合した派生アセット', exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole('link', { name: '正本を開く：' + source.id, exact: true })
      .getAttribute('href'),
    '?asset=' + source.id,
  );
  const response = await page.request.get(
    base + `/api/assets/${derived.id}/derivation?revision=${derived.revision}`,
  );
  assert.equal(response.status(), 200);
  assert.deepEqual(await response.json(), provenance);
  assert.equal(
    (await page.request.get(base + `/api/assets/${source.id}/derivation`)).status(),
    404,
  );
  const out = path.join(temp, 'derived-sync');
  const lock = await createLock([derived.id]);
  assert.deepEqual(lock.assets[0].derivedFrom, derived.derivedFrom);
  await syncLock(lock, out);
  assert.equal(
    digest(await readFile(path.join(out, `${derived.id}.${derived.revision.slice(0, 12)}.glb`))),
    derived.revision,
  );
  assert.deepEqual(
    JSON.parse(
      await readFile(path.join(out, derived.derivedFrom.recipe + '.derivation.json'), 'utf8'),
    ),
    provenance,
  );
  // The dependency path must carry the same provenance as an explicitly selected derived asset.
  const animated = animatedGlb(),
    motionG = readGlb(bytes),
    clips = readGlb(animated),
    bin = readGlbBinary(bytes)!;
  const viewOffset = motionG.bufferViews!.length,
    accessorOffset = motionG.accessors!.length;
  motionG.bufferViews!.push(
    ...clips.bufferViews!.map((v) => ({ ...v, byteOffset: (v.byteOffset ?? 0) + bin.length })),
  );
  motionG.accessors!.push(
    ...clips.accessors!.map((a) => ({ ...a, bufferView: a.bufferView! + viewOffset })),
  );
  motionG.animations = clips.animations!.map((clip) => ({
    ...clip,
    samplers: clip.samplers.map((s) => ({
      ...s,
      input: s.input + accessorOffset,
      output: s.output! + accessorOffset,
    })),
    channels: clip.channels.map((c) => ({ ...c, target: { ...c.target, node: 0 } })),
  }));
  const motionBin = Buffer.concat([bin, readGlbBinary(animated)!]);
  motionG.buffers![0].byteLength = motionBin.length;
  const motionBytes = writeGlb(motionG, motionBin);
  const motionSource = await importGlb(motionBytes, 'motion.glb', {
    id: 'test.rigid-motion',
    name: '固定部品モーション',
    kind: 'motion',
  });
  await bakeAsset(motionSource.id, 'test.baked-motion', input, undefined, true);
  const motion = await getAsset('test.baked-motion');
  assert(motion.schema === 2);
  let consumer = await importGlb(bytes, 'consumer.glb', { id: 'test.consumer' });
  consumer = await setBehavior(
    consumer.id,
    {
      schema: 1,
      assetId: consumer.id,
      modelRevision: consumer.revision,
      presets: [
        {
          id: 'shared',
          name: '共有',
          clip: {
            index: 0,
            source: { id: motion.id, revision: motion.revision },
            nodeMap: { 0: 0 },
          },
        },
      ],
    },
    consumer.updatedAt,
  );
  const dependentLock = await createLock([consumer.id]);
  assert.deepEqual(
    dependentLock.assets.find((a) => a.id === motion.id)!.derivedFrom,
    motion.derivedFrom,
  );
  await syncLock(dependentLock, path.join(temp, 'dependency-sync'));
  const originalResult = await readFile(resultPath(derived.derivedFrom.recipe));
  await writeFile(
    resultPath(derived.derivedFrom.recipe),
    JSON.stringify({ ...provenance.result, output: source.revision }),
  );
  await assert.rejects(() => createLock([derived.id]), /出力GLB/);
  await writeFile(resultPath(derived.derivedFrom.recipe), originalResult);
  const external = await mkdtemp(path.join(os.tmpdir(), 'asset-hub-derived-backup-'));
  try {
    const backup = path.join(external, 'backup'),
      restored = path.join(external, 'restored');
    await backupLibrary(backup);
    const manifest = await verifyBackup(backup);
    assert(
      manifest.files.some(
        (f) => f.path === 'catalog/recipes/' + derived.derivedFrom.recipe + '.json',
      ),
    );
    assert(manifest.files.some((f) => f.path.endsWith(images[0])));
    await restoreBackup(backup, restored);
    for (const file of [
      'catalog/assets/' + derived.id + '.json',
      'catalog/reviews/' + derived.id + '.json',
      'catalog/recipes/' + derived.derivedFrom.recipe + '.json',
      'catalog/recipes/results/' + derived.derivedFrom.recipe + '.json',
    ])
      assert.deepEqual(
        await readFile(path.join(restored, file)),
        await readFile(path.join(temp, file)),
      );
  } finally {
    await rm(external, { recursive: true, force: true });
  }
  console.log(
    'Derived PASS: dry run, deterministic bake, root motion/render comparison, sibling registration, preserved metadata/notes/source, pinned provenance/download, dependent motion sync, tamper rejection and backup/restore.',
  );
}
