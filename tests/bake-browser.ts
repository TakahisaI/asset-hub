import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SphereGeometry } from 'three';
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
  const groupsFile = path.join(temp, 'groups.json');
  await writeFile(groupsFile, JSON.stringify(input));
  const cliArgs = [
    '--import',
    'tsx',
    'tools/assetctl.ts',
    'bake',
    source.id,
    '--id',
    'test.baked',
    '--json',
    groupsFile,
  ];
  const cli = (...args: string[]) =>
    promisify(execFile)(process.execPath, args, {
      env: { ...process.env, ASSET_HUB_ROOT: temp },
    });
  const viteCache = path.join(temp, '.cache/bake-vite');
  await assert.rejects(() => readdir(viteCache), /ENOENT/);
  for (const _cache of ['cold', 'warm']) {
    const { stdout, stderr } = await cli(...cliArgs);
    assert.equal(JSON.parse(stdout).registered, false);
    assert.equal(stderr, '');
  }
  assert((await readdir(path.join(viteCache, 'deps'))).includes('_metadata.json'));
  const concurrent = await Promise.all([cli(...cliArgs), cli(...cliArgs)]);
  for (const { stdout, stderr } of concurrent) {
    assert.equal(JSON.parse(stdout).registered, false);
    assert.equal(stderr, '');
  }
  const dry = await bakeAsset(source.id, 'test.baked', input);
  assert.equal(dry.registered, false);
  await assert.rejects(() => getAsset('test.baked'), /ENOENT/);
  await assert.rejects(() => readFile(recipePath(dry.recipe!)), /ENOENT/);
  const written = await bakeAsset(source.id, 'test.baked', input, undefined, true);
  const derived = await getAsset('test.baked');
  assert.equal(written.registered, true);
  assert.equal(derived.schema, 2);
  assert(derived.schema === 2);
  assert.equal(derived.source.specification, undefined);
  assert.equal(derived.source.verification, undefined);
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
  const geometry = new SphereGeometry(1, 16, 8).toNonIndexed();
  const positions = Buffer.from(geometry.attributes.position.array.buffer);
  const normals = Buffer.from(geometry.attributes.normal.array.buffer);
  const curved = readGlb(bytes);
  curved.bufferViews = [
    { buffer: 0, byteOffset: 0, byteLength: positions.length },
    { buffer: 0, byteOffset: positions.length, byteLength: normals.length },
  ];
  curved.accessors = [
    {
      bufferView: 0,
      componentType: 5126,
      count: geometry.attributes.position.count,
      type: 'VEC3',
      min: [-1, -1, -1],
      max: [1, 1, 1],
    },
    { bufferView: 1, componentType: 5126, count: geometry.attributes.normal.count, type: 'VEC3' },
  ];
  curved.meshes![0].primitives = [{ attributes: { POSITION: 0, NORMAL: 1 }, material: 0 }];
  curved.buffers![0].byteLength = positions.length + normals.length;
  curved.nodes![1].rotation = [0, 0, Math.sin(0.123), Math.cos(0.123)];
  curved.nodes![1].translation = [0.137, 0.217, 0.119];
  curved.nodes![2].scale = [1.3, 0.7, 1.1];
  const curvedBytes = writeGlb(curved, Buffer.concat([positions, normals]));
  const curvedAsset = await importGlb(curvedBytes, 'curved.glb', { id: 'test.curved' });
  await writeFile(
    groupsFile,
    JSON.stringify({
      ...input,
      checks: { imageMaxChannelError: 0, imageMaxChangedPixelRatio: '0.000000001' },
    }),
  );
  async function libraryFiles(dir: string): Promise<Record<string, string>> {
    const entries = await readdir(path.join(temp, dir), { withFileTypes: true });
    const files: Record<string, string> = {};
    for (const entry of entries) {
      const name = path.join(dir, entry.name);
      if (entry.isDirectory()) Object.assign(files, await libraryFiles(name));
      else files[name] = digest(await readFile(path.join(temp, name)));
    }
    return files;
  }
  const unchanged = { ...(await libraryFiles('catalog')), ...(await libraryFiles('.store')) };
  const error = await cli(
    ...cliArgs.map((x) => (x === source.id ? curvedAsset.id : x)),
    '--write',
  ).then(
    () => assert.fail('Expected the render comparison to reject the candidate'),
    (error) => error,
  );
  {
    assert.equal(error.code, 1);
    assert.equal(error.stdout, '');
    const failure = JSON.parse(error.stderr).error;
    assert.equal(failure.code, 'BAKE_RENDER_DIFFERENCE');
    const directory = failure.diagnostics;
    assert.equal(path.dirname(directory), path.join(temp, '.cache/bake-failures'));
    const result = JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8'));
    const recipe = JSON.parse(await readFile(path.join(directory, 'recipe.json'), 'utf8'));
    assert.equal(digest(Buffer.from(JSON.stringify(recipe))), result.recipe);
    assert.equal(recipe.checks.imageMaxChannelError, 0);
    assert.equal(result.registered, false);
    assert.equal(result.reproductions, 3);
    assert(result.geometry.maxPositionError <= Number(recipe.checks.positionToleranceMeters));
    assert.equal(result.source.revision, curvedAsset.revision);
    for (const [file, hash] of [
      ['source.glb', curvedAsset.revision],
      ['output.glb', result.output],
    ])
      assert.equal(digest(await readFile(path.join(directory, file))), hash);
    const failed = result.render.failure;
    assert(
      failed.maxError > 0 || failed.changedRatio > Number(recipe.checks.imageMaxChangedPixelRatio),
    );
    assert.deepEqual(result.render.samples.at(-1), failed);
    for (const suffix of ['source', 'output']) {
      const png = await readFile(
        path.join(directory, `${failed.pose}-${failed.mode}-${failed.view}-${suffix}.png`),
      );
      assert.equal(png.subarray(1, 4).toString(), 'PNG');
      assert.equal(png.readUInt32BE(16), 384);
      assert.equal(png.readUInt32BE(20), 288);
    }
  }
  assert.deepEqual(
    { ...(await libraryFiles('catalog')), ...(await libraryFiles('.store')) },
    unchanged,
  );
  await writeFile(groupsFile, JSON.stringify(input));
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
  const assetFile = path.join(temp, 'catalog/assets', derived.id + '.json');
  await writeFile(
    assetFile,
    JSON.stringify({
      ...saved,
      source: {
        ...saved.source,
        specification: '/old-library/recipe.json',
        verification: '/old-library/result.json',
      },
    }),
  );
  await page.goto(base + '?asset=' + derived.id);
  await page.getByRole('heading', { name: '統合した派生アセット', exact: true }).waitFor();
  assert.equal(await page.getByRole('link', { name: '制作仕様', exact: true }).count(), 0);
  assert.equal(await page.getByRole('link', { name: '出典の検査記録', exact: true }).count(), 0);
  await writeFile(assetFile, JSON.stringify(saved));
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
