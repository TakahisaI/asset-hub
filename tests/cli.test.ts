import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { animatedGlb } from './fixtures.ts';
const exec = promisify(execFile),
  temp = await mkdtemp(path.join(os.tmpdir(), 'asset-hub-cli-'));
const env = { ...process.env, ASSET_HUB_ROOT: temp };
const file = path.join(temp, 'model.glb');
await writeFile(file, animatedGlb());
after(() => rm(temp, { recursive: true, force: true }));
const cli = async (...args: string[]) =>
  JSON.parse(
    (await exec(process.execPath, ['--import', 'tsx', 'tools/assetctl.ts', ...args], { env }))
      .stdout,
  );
async function json(name: string, value: unknown) {
  const file = path.join(temp, name + '.json');
  await writeFile(file, JSON.stringify(value));
  return file;
}

test('CLI edits and cross-process tag changes preserve metadata, reject conflicts, and retain old versions/notes', async () => {
  const a = await cli('add', file, '--id', 'fixture.actor', '--name', 'Actor');
  assert.deepEqual(a.collections, []);
  await assert.rejects(() => cli('add', file, '--id', 'fixture.actor'), /CONFLICT/);
  const updated = await cli(
    'update',
    a.id,
    '--json',
    await json('edit', { name: 'My actor', collections: ['use-a', 'use-b'] }),
    '--if-match',
    a.updatedAt,
  );
  await assert.rejects(
    () => cli('update', a.id, '--json', awaitablePath('edit'), '--if-match', a.updatedAt),
    /CONFLICT/,
  );
  await Promise.all(Array.from({ length: 5 }, (_, i) => cli('tag', 'add', a.id, 'tag-' + i)));
  let saved = await cli('get', a.id);
  assert.equal(saved.tags.length, 5);
  assert.equal(saved.name, 'My actor');
  const note = await cli(
    'note',
    'add',
    a.id,
    '--json',
    await json('note', { revision: a.revision, text: 'Before replacement' }),
  );
  await cli('note', 'resolve', a.id, note.id);
  const next = path.join(temp, 'next.glb');
  await writeFile(next, animatedGlb(true, 0.1));
  saved = await cli('replace', a.id, next, '--if-match', saved.updatedAt);
  assert.notEqual(saved.revision, a.revision);
  assert.equal(saved.name, 'My actor');
  assert.equal(saved.tags.length, 5);
  assert.deepEqual(saved.collections, ['use-a', 'use-b']);
  assert.equal(saved.importedAt, a.importedAt);
  assert.equal((await cli('revisions', a.id)).length, 2);
  assert.equal((await cli('note', 'list', a.id))[0].revision, a.revision);
  assert.equal((await cli('search', '--tag', 'tag-2', '--collection', 'use-b')).length, 1);
  await cli('collection', 'remove', a.id, 'use-a', 'use-b');
  saved = await cli('get', a.id);
  assert.deepEqual(saved.collections, []);
  saved = await cli('replace', a.id, next, '--if-match', saved.updatedAt);
  assert.deepEqual(saved.collections, []);
  assert.ok((await cli('search')).some((asset: { id: string }) => asset.id === a.id));
  await assert.rejects(
    () => cli('update', a.id, '--json', awaitablePath('edit'), '--if-match', updated.updatedAt),
    /CONFLICT/,
  );
});
function awaitablePath(name: string) {
  return path.join(temp, name + '.json');
}

test('CLI motion bindings pin source versions; lock/sync include behavior, old settings are immutable', async () => {
  const model = await cli('add', file, '--id', 'fixture.model');
  const motion = await cli('add', file, '--id', 'fixture.motion', '--kind', 'motion');
  const data = {
    schema: 1,
    assetId: model.id,
    modelRevision: model.revision,
    presets: [
      {
        id: 'walk',
        name: 'Walk',
        clip: { index: 0, source: { id: motion.id, revision: motion.revision } },
      },
    ],
  };
  let current = await cli(
    'behavior',
    'set',
    model.id,
    '--json',
    await json('behavior', data),
    '--if-match',
    model.updatedAt,
  );
  const oldHash = current.behavior,
    before = await readFile(path.join(temp, 'catalog/behaviors', oldHash + '.json'), 'utf8');
  const lock = await cli('lock', model.id);
  assert.equal(lock.assets.length, 2);
  const out = path.join(temp, 'sync');
  const synced = await cli('sync', '--lock', await json('lock', lock), '--out', out);
  assert.equal(synced[0].behaviorFile, oldHash + '.behavior.json');
  assert.equal(
    JSON.parse(await readFile(path.join(out, synced[0].behaviorFile), 'utf8')).presets[0].clip
      .source.revision,
    motion.revision,
  );
  const newMotionFile = path.join(temp, 'new-motion.glb');
  await writeFile(newMotionFile, animatedGlb(true, 0.2));
  const newMotion = await cli('replace', motion.id, newMotionFile, '--if-match', motion.updatedAt);
  const mixedLock = await cli('lock', model.id, motion.id);
  assert.deepEqual(
    mixedLock.assets
      .filter((a: { id: string }) => a.id === motion.id)
      .map((a: { revision: string }) => a.revision)
      .sort(),
    [motion.revision, newMotion.revision].sort(),
  );
  const mixed = await cli(
    'sync',
    '--lock',
    await json('mixed-lock', mixedLock),
    '--out',
    path.join(temp, 'mixed-sync'),
  );
  assert.equal(mixed.length, 3);
  assert.equal(new Set(mixed.map((a: { file: string }) => a.file)).size, 3);
  current = await cli(
    'behavior',
    'set',
    model.id,
    '--json',
    await json('behavior2', { ...data, presets: [{ ...data.presets[0], speed: 2 }] }),
    '--if-match',
    current.updatedAt,
  );
  assert.notEqual(current.behavior, oldHash);
  assert.equal(
    await readFile(path.join(temp, 'catalog/behaviors', oldHash + '.json'), 'utf8'),
    before,
  );
  const invalid = {
    ...data,
    presets: [
      { id: 'broken', name: 'broken', rotations: [{ node: 999, axis: [0, 1, 0], rpm: 5 }] },
    ],
  };
  await json('invalid', invalid);
  await assert.rejects(
    () =>
      cli(
        'behavior',
        'set',
        model.id,
        '--json',
        awaitablePath('invalid'),
        '--if-match',
        current.updatedAt,
      ),
    /対象ノード/,
  );
  const next = path.join(temp, 'changed.glb');
  await writeFile(next, animatedGlb(true, 0.3));
  await cli('replace', model.id, next, '--if-match', current.updatedAt);
  await assert.rejects(() => cli('lock', model.id), /再設定/);
  assert.equal((await cli('schema', 'behavior')).type, 'object');
});

test('CLI and HTTP compete on the same compare-and-swap lock', async () => {
  process.env.ASSET_HUB_ROOT = temp;
  const { createApp, apiErrors } = await import('../server/app.ts');
  const { once } = await import('node:events');
  const app = createApp();
  app.use(apiErrors);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const a = await cli('add', file, '--id', 'fixture.concurrent');
    const patch = await json('concurrent', { name: 'CLI winner' });
    const [cliResult, http] = await Promise.all([
      cli('update', a.id, '--json', patch, '--if-match', a.updatedAt)
        .then((value) => ({ ok: true, value }))
        .catch(() => ({ ok: false })),
      fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/assets/${a.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'If-Match': a.updatedAt },
        body: JSON.stringify({ name: 'HTTP winner' }),
      }),
    ]);
    assert.equal(Number(cliResult.ok) + Number(http.status === 200), 1);
    assert.ok([200, 409].includes(http.status));
    assert.equal((await cli('get', a.id)).name, cliResult.ok ? 'CLI winner' : 'HTTP winner');
    await assert.rejects(() => cli('get', a.id, '--name', 'ignored'), /このコマンド/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
