import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { behaviorSchema } from '../src/schema.ts';
import { browser } from '../tools/browser.ts';
import { fixtureAsset, triangleGlb, animatedGlb } from './fixtures.ts';
const root = process.cwd(),
  temp = await mkdtemp(path.join(os.tmpdir(), 'asset-hub-browser-'));
const bytes = animatedGlb(true, 0, true);
const asset = await fixtureAsset(bytes, 'test.browser', '試験モデル');
asset.collections = ['all', 'notes'];
const behavior = behaviorSchema.parse({
  schema: 1,
  assetId: asset.id,
  modelRevision: asset.revision,
  presets: [
    { id: 'breeze', name: '微風', rotations: [{ node: 1, axis: [0, 0, 1], rpm: 6 }] },
    { id: 'wind', name: '強風', rotations: [{ node: 1, axis: [0, 0, 1], rpm: 30 }] },
    { id: 'lit', name: '点灯', lights: [{ node: 2, intensity: 30 }] },
  ],
});
asset.behavior = createHash('sha256').update(JSON.stringify(behavior)).digest('hex');
const oldBytes = animatedGlb(true, 2, true),
  oldAsset = await fixtureAsset(oldBytes, asset.id, '旧版の試験モデル'),
  oldBehavior = behaviorSchema.parse({
    schema: 1,
    assetId: asset.id,
    modelRevision: oldAsset.revision,
    presets: [
      { id: 'old-wind', name: '旧版の回転', rotations: [{ node: 1, axis: [0, 0, 1], rpm: 12 }] },
    ],
  }),
  priorBehavior = behaviorSchema.parse({
    ...oldBehavior,
    modelRevision: asset.revision,
  }),
  oldBehaviorHash = createHash('sha256').update(JSON.stringify(oldBehavior)).digest('hex'),
  priorBehaviorHash = createHash('sha256').update(JSON.stringify(priorBehavior)).digest('hex');
await mkdir(path.join(temp, 'catalog/behaviors'), { recursive: true });
for (const [hash, data] of [
  [asset.behavior, behavior],
  [oldBehaviorHash, oldBehavior],
  [priorBehaviorHash, priorBehavior],
] as const)
  await writeFile(path.join(temp, 'catalog/behaviors', hash + '.json'), JSON.stringify(data));
await mkdir(path.join(temp, 'catalog/assets'), { recursive: true });
await mkdir(path.join(temp, 'catalog/revisions', asset.id), { recursive: true });
await mkdir(path.join(temp, '.store'), { recursive: true });
await writeFile(path.join(temp, 'catalog/assets', asset.id + '.json'), JSON.stringify(asset));
await writeFile(
  path.join(temp, 'catalog/revisions', asset.id, asset.revision + '.json'),
  JSON.stringify(asset),
);
await writeFile(
  path.join(temp, 'catalog/revisions', asset.id, oldAsset.revision + '.json'),
  JSON.stringify(oldAsset),
);
process.env.ASSET_HUB_ROOT = temp;
const { root: libraryRoot } = await import('../server/store.ts');
assert.equal(libraryRoot, temp);
const { putBlob } = await import('../server/blobs.ts');
await putBlob(bytes);
await putBlob(oldBytes);
const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
  cwd: root,
  env: { ...process.env, PORT: '0', NODE_ENV: 'production', ASSET_HUB_ROOT: temp },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
child.stdout.on('data', (d) => {
  logs += d;
});
child.stderr.on('data', (d) => {
  logs += d;
});
const b = await browser();
try {
  const base = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Server startup timed out: ' + logs)), 20000);
    child.stdout.on('data', () => {
      const match = logs.match(/Asset Hub: (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) {
        clearTimeout(t);
        resolve(match[1]);
      }
    });
    child.on('exit', () => {
      clearTimeout(t);
      reject(new Error('Server exited: ' + logs));
    });
    const match = logs.match(/Asset Hub: (http:\/\/127\.0\.0\.1:\d+)/);
    if (match) {
      clearTimeout(t);
      resolve(match[1]);
    }
  });
  const page = await b.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base);
  await page.getByRole('heading', { name: '試験モデル', exact: true }).waitFor();
  for (const name of ['all', 'notes']) {
    await page
      .getByRole('navigation')
      .getByRole('button', { name: new RegExp('^' + name) })
      .click();
    assert.equal(await page.locator('.asset-card').count(), 1);
  }
  await page.locator('.asset-card').click();
  await page
    .locator('.viewer-state')
    .waitFor({ state: 'hidden', timeout: 20000 })
    .catch(async (error) => {
      console.error(await page.locator('.viewer-state').innerText(), logs);
      throw error;
    });
  for (const mode of ['ワイヤーフレーム', '法線', 'マテリアル']) {
    await page.getByRole('button', { name: mode, exact: true }).click();
    assert.equal(
      await page.getByRole('button', { name: mode, exact: true }).getAttribute('aria-pressed'),
      'true',
    );
    assert.equal(await page.locator('.view-modes [aria-pressed="true"]').count(), 1);
  }
  await page.getByLabel('動作', { exact: true }).selectOption('clip:0');
  await page.getByLabel('再生位置', { exact: true }).fill('0.8');
  const rotated = await page.locator('.viewport canvas').screenshot();
  await page.getByLabel('動作', { exact: true }).selectOption('clip:1');
  await page.getByLabel('再生位置', { exact: true }).fill('0.8');
  const lifted = await page.locator('.viewport canvas').screenshot();
  assert.notDeepEqual(rotated, lifted);
  await page.getByLabel('動作', { exact: true }).selectOption('preset:breeze');
  await page.getByLabel('再生速度', { exact: true }).fill('2');
  await page.getByRole('button', { name: '動作を再生', exact: true }).click();
  await page.waitForTimeout(250);
  await page.getByRole('button', { name: '動作を一時停止', exact: true }).click();
  assert.ok(Number(await page.getByLabel('再生位置', { exact: true }).inputValue()) > 0);
  await page.getByLabel('照射確認面').check();
  await page.getByLabel('照明', { exact: true }).selectOption('night');
  const unlit = await page.locator('.viewport canvas').screenshot();
  await page.getByLabel('動作', { exact: true }).selectOption('preset:lit');
  const lit = await page.locator('.viewport canvas').screenshot();
  assert.notDeepEqual(unlit, lit);
  await page.getByRole('button', { name: '正面', exact: true }).click();
  await page.getByLabel('寸法枠').check();
  await page.getByRole('button', { name: '情報を編集', exact: true }).click();
  await page.getByLabel('名前', { exact: true }).fill('名前を変えたモデル');
  await page.getByLabel('タグ（カンマ区切り）').fill('棚, 木工');
  await page
    .getByLabel('プロジェクト・用途（カンマ区切り）', { exact: false })
    .fill('project-one, project-two');
  await page.getByRole('button', { name: '変更を保存', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '保存しました' }).waitFor();
  await page.reload();
  await page.getByRole('heading', { name: '名前を変えたモデル', exact: true }).waitFor();
  await page.locator('.viewer-state').waitFor({ state: 'hidden' });
  await page.getByLabel('動作', { exact: true }).selectOption('clip:0');
  await page.getByLabel('再生位置', { exact: true }).fill('0.75');
  await page.getByRole('button', { name: '確認メモ 0', exact: true }).click();
  await page.getByLabel('確認メモ', { exact: true }).fill('部材の接続位置を再確認する');
  await page.getByRole('button', { name: '確認メモを保存', exact: true }).click();
  await page.locator('.note').getByText('部材の接続位置を再確認する', { exact: true }).waitFor();
  await page.getByRole('button', { name: '視点を復元' }).click();
  await page.getByRole('button', { name: '解決済みにする' }).click();
  await page.getByText('解決済み', { exact: true }).waitFor();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '固定版を参照', exact: true }).click();
  const downloaded = await download;
  const lock = JSON.parse(await readFile((await downloaded.path())!, 'utf8'));
  assert.equal(lock.assets[0].sha256, asset.file.hash);
  await page.getByRole('button', { name: 'ライブラリに戻る', exact: true }).click();
  // One asset belongs to both collections, without duplicating its ID or GLB.
  for (const collection of ['project-one', 'project-two']) {
    await page
      .getByRole('navigation')
      .getByRole('button', { name: new RegExp(collection) })
      .click();
    assert.equal(await page.locator('.asset-card').count(), 1);
    await page.getByRole('heading', { name: '名前を変えたモデル', exact: true }).waitFor();
  }
  await page
    .getByRole('navigation')
    .getByRole('button', { name: /すべてのアセット/ })
    .click();
  const openModal = page.getByRole('button', { name: 'アセットを追加', exact: true });
  await openModal.click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  for (let i = 0; i < 16; i++) {
    await page.keyboard.press(i < 8 ? 'Tab' : 'Shift+Tab');
    assert.equal(
      await dialog.evaluate((element) => element.contains(document.activeElement)),
      true,
    );
  }
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await openModal.evaluate((element) => document.activeElement === element), true);
  await openModal.click();
  await page
    .getByLabel('GLBファイル', { exact: true })
    .setInputFiles({ name: 'model.glb', mimeType: 'model/gltf-binary', buffer: bytes });
  await page.getByLabel('名前', { exact: true }).fill('追加したモデル');
  await page.getByLabel('アセットID', { exact: true }).fill('test.uploaded');
  await page.getByRole('button', { name: 'ライブラリに登録' }).click();
  await page.getByRole('heading', { name: '追加したモデル', exact: true }).waitFor();
  assert.deepEqual(
    JSON.parse(await readFile(path.join(temp, 'catalog/assets/test.uploaded.json'), 'utf8'))
      .collections,
    [],
  );
  await page.locator('.viewer-state').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'ライブラリに戻る', exact: true }).click();
  await page.getByLabel('アセットを検索').fill('存在しないモデル');
  await page.getByRole('heading', { name: 'アセットが見つかりません' }).waitFor();
  await page.getByRole('button', { name: '条件をリセット' }).click();
  assert.equal(await page.locator('.asset-card').count(), 2);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole('button', { name: 'リスト表示', exact: true }).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  // Simulate advertised heavy-model metadata using a tiny self-contained GLB.
  // No GLB request should happen until the user asks to inspect it.
  await page.route('**/api/catalog', async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.assets.find((a: { id: string }) => a.id === asset.id).file.bytes = 77_000_000;
    await route.fulfill({ response, json: data });
  });
  let modelRequests = 0;
  page.on('request', (request) => {
    if (request.url().includes('/api/files/')) modelRequests++;
  });
  await page.goto(base + '?asset=' + asset.id);
  await page.getByRole('button', { name: '3Dモデルを読み込む（77.0 MB）', exact: true }).waitFor();
  assert.equal(modelRequests, 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole('button', { name: '3Dモデルを読み込む（77.0 MB）', exact: true }).click();
  await page.locator('.viewer-state').waitFor({ state: 'hidden' });
  assert.equal(modelRequests, 1);
  await page.getByRole('button', { name: '法線', exact: true }).click();
  assert.equal(
    await page.getByRole('button', { name: '法線', exact: true }).getAttribute('aria-pressed'),
    'true',
  );
  await page.unroute('**/api/catalog');
  await page.reload();
  await page.locator('.viewer-state').waitFor({ state: 'hidden' });
  const headFile = path.join(temp, 'catalog/assets', asset.id + '.json'),
    headBefore = await readFile(headFile),
    fixedBefore = await readFile(
      path.join(temp, 'catalog/revisions', asset.id, oldAsset.revision + '.json'),
    );
  await page
    .locator('select[aria-label="表示する版"] option[value="' + oldAsset.revision + '"]')
    .waitFor({ state: 'attached' });
  await page.getByRole('button', { name: '情報を編集', exact: true }).click();
  await page.getByLabel('名前', { exact: true }).fill('未保存の名前');
  const revisionSelect = page.getByLabel('表示する版', { exact: true });
  await revisionSelect.focus();
  await revisionSelect.selectOption(oldAsset.revision);
  await page.locator('.viewer-state').waitFor({ state: 'hidden' });
  assert.equal(
    await revisionSelect.evaluate((element) => document.activeElement === element),
    true,
  );
  await page.getByText('履歴を閲覧中 · 現在の登録内容は変更しません', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '情報を編集', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '変更を保存', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '固定版を参照', exact: true }).count(), 0);
  assert.equal(await page.getByRole('alert').count(), 0);
  assert.equal(await page.getByText(/回転・点灯などの動作設定は/).count(), 0);
  assert.equal(
    await page
      .getByLabel('動作', { exact: true })
      .locator('optgroup[label="動作プリセット"]')
      .count(),
    0,
  );
  const oldDownload = page.waitForEvent('download');
  await page.getByRole('link', { name: 'GLBを取得', exact: true }).click();
  const oldDownloaded = await oldDownload;
  assert.equal(
    createHash('sha256')
      .update(await readFile((await oldDownloaded.path())!))
      .digest('hex'),
    oldAsset.revision,
  );
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole('button', { name: '現在版へ戻る', exact: true }).click();
  await page.locator('.viewer-state').waitFor({ state: 'hidden' });
  assert.equal(await page.getByLabel('名前', { exact: true }).inputValue(), '未保存の名前');
  await page.getByRole('button', { name: 'キャンセル', exact: true }).click();
  const playback = { preset: 'old-wind', time: 1.25, rotationTime: 7, speed: 2, loop: false };
  for (const input of [
    {
      revision: oldAsset.revision,
      text: '旧版と旧動作のメモ',
      playback: { ...playback, behavior: oldBehaviorHash },
    },
    {
      revision: asset.revision,
      text: '現在のGLBと旧動作のメモ',
      playback: { ...playback, behavior: priorBehaviorHash },
    },
    {
      revision: asset.revision,
      text: '現在版と現在動作のメモ',
      playback: { ...playback, preset: 'breeze', behavior: asset.behavior },
    },
  ]) {
    const response = await fetch(base + '/api/assets/' + asset.id + '/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...input, camera: { position: [3, 3, 3], target: [0, 2, 0] } }),
    });
    assert.equal(response.status, 201);
  }
  await page.reload();
  await page.locator('.viewer-state').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '確認メモ 4', exact: true }).click();
  const noteDraft = page.getByLabel('確認メモ', { exact: true }),
    currentNote = page.locator('.note').filter({ hasText: '現在版と現在動作のメモ' }),
    oldNote = page.locator('.note').filter({ hasText: '旧版と旧動作のメモ' });
  await noteDraft.fill('版を切り替えても残す下書き');
  const openedFiles: string[] = [],
    openedBehaviors: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/files/')) openedFiles.push(url.pathname);
    if (url.pathname.startsWith('/api/behaviors/')) openedBehaviors.push(url.pathname);
  });
  await oldNote.getByRole('button', { name: 'この版の状態を開く' }).click();
  await page.locator('.viewer-state').waitFor({ state: 'hidden' });
  assert.equal(await noteDraft.inputValue(), '版を切り替えても残す下書き');
  assert.equal(await currentNote.getByText(/旧版へのメモ|旧動作設定/).count(), 0);
  assert.match(await oldNote.locator('.note-revision').innerText(), /旧版へのメモ.*旧動作設定/);
  assert.equal(
    await page.getByLabel('表示する版', { exact: true }).inputValue(),
    oldAsset.revision,
  );
  assert.equal(await page.getByLabel('動作', { exact: true }).inputValue(), 'preset:old-wind');
  assert.equal(await page.getByLabel('再生時刻', { exact: true }).innerText(), '1.25 / 10.00s');
  assert.equal(await page.getByLabel('再生速度', { exact: true }).inputValue(), '2');
  assert.equal(await page.getByLabel('ループ', { exact: true }).isChecked(), false);
  assert.ok(openedFiles.includes('/api/files/' + oldAsset.revision));
  assert.ok(openedBehaviors.includes('/api/behaviors/' + oldBehaviorHash));
  const restored = await page.locator('.viewport canvas').screenshot();
  await page.getByRole('button', { name: '上面', exact: true }).click();
  assert.notDeepEqual(await page.locator('.viewport canvas').screenshot(), restored);
  await page
    .locator('.note')
    .filter({ hasText: '旧版と旧動作のメモ' })
    .getByRole('button', { name: '視点を復元' })
    .click();
  await page.getByLabel('確認メモ', { exact: true }).fill('復元状態の確認');
  await page.getByRole('button', { name: '確認メモを保存', exact: true }).click();
  await page.locator('.note').getByText('復元状態の確認', { exact: true }).waitFor();
  const restoredNotes = JSON.parse(
    await readFile(path.join(temp, 'catalog/reviews', asset.id + '.json'), 'utf8'),
  );
  const restoredState = restoredNotes.find((n: { text: string }) => n.text === '復元状態の確認');
  assert.equal(restoredState.revision, oldAsset.revision);
  assert.deepEqual(restoredState.playback, { ...playback, behavior: oldBehaviorHash });
  for (const [key, expected] of [
    ['position', [3, 3, 3]],
    ['target', [0, 2, 0]],
  ] as const)
    restoredState.camera[key].forEach((value: number, i: number) =>
      assert.ok(Math.abs(value - expected[i]) < 1e-6),
    );
  await page
    .locator('.note')
    .filter({ hasText: '現在のGLBと旧動作のメモ' })
    .getByRole('button', { name: 'この版の状態を開く' })
    .click();
  await page.locator('.viewer-state').waitFor({ state: 'hidden' });
  assert.equal(await page.getByLabel('表示する版', { exact: true }).inputValue(), asset.revision);
  assert.equal(await page.getByLabel('動作', { exact: true }).inputValue(), 'preset:old-wind');
  assert.ok(openedBehaviors.includes('/api/behaviors/' + priorBehaviorHash));
  assert.equal(await currentNote.getByText(/旧版へのメモ|旧動作設定/).count(), 0);
  await noteDraft.fill('現在版へ戻っても残す下書き');
  await page.getByRole('button', { name: '現在版へ戻る', exact: true }).click();
  await page.locator('.viewer-state').waitFor({ state: 'hidden' });
  assert.equal(await noteDraft.inputValue(), '現在版へ戻っても残す下書き');
  await revisionSelect.focus();
  await revisionSelect.selectOption(oldAsset.revision);
  await page.locator('.viewer-state').waitFor({ state: 'hidden' });
  assert.equal(await noteDraft.inputValue(), '現在版へ戻っても残す下書き');
  assert.equal(
    await revisionSelect.evaluate((element) => document.activeElement === element),
    true,
  );
  await revisionSelect.selectOption(asset.revision);
  await page.locator('.viewer-state').waitFor({ state: 'hidden' });
  assert.equal(await noteDraft.inputValue(), '現在版へ戻っても残す下書き');
  assert.equal(
    await revisionSelect.evaluate((element) => document.activeElement === element),
    true,
  );
  assert.equal(
    await page.getByLabel('動作', { exact: true }).locator('option[value="preset:breeze"]').count(),
    1,
  );
  assert.deepEqual(await readFile(headFile), headBefore);
  assert.deepEqual(
    await readFile(path.join(temp, 'catalog/revisions', asset.id, oldAsset.revision + '.json')),
    fixedBefore,
  );
  await assert.rejects(() => readFile(path.join(temp, '.store', oldAsset.revision + '.png')), {
    code: 'ENOENT',
  });
  await writeFile(path.join(temp, 'catalog/assets/broken.json'), '{broken');
  await page.goto(base);
  await page.getByRole('alert').getByText('1件のファイルを読み込めませんでした').waitFor();
  assert.equal(await page.locator('.asset-card').count(), 2);
  assert.deepEqual(errors, []);
  const saved = JSON.parse(
    await readFile(path.join(temp, 'catalog/assets', asset.id + '.json'), 'utf8'),
  );
  assert.equal(saved.name, '名前を変えたモデル');
  assert.deepEqual(saved.tags, ['棚', '木工']);
  assert.deepEqual(saved.collections, ['project-one', 'project-two']);
  const notes = JSON.parse(
    await readFile(path.join(temp, 'catalog/reviews', asset.id + '.json'), 'utf8'),
  );
  assert.equal(notes.length, 5);
  assert.equal(notes[0].resolved, true);
  assert.equal(notes[0].revision, asset.revision);
  assert.ok(notes[0].camera);
  assert.equal(notes[0].playback.clip, 0);
  assert.equal(notes[0].playback.time, 0.75);
  console.log(
    'Browser PASS: 3D load, one-click modes, metadata/collections persistence, notes/camera/resolve, read-only revision history, revision-switch drafts/focus, revision behavior isolation, current-head note labels, old GLB/behavior/camera restoration, lock/GLB download, GLB upload, modal focus, search, mobile grid/list/detail, deferred heavy model, partial catalog failure.',
  );
} finally {
  await b.close();
  child.kill('SIGTERM');
  await new Promise<void>((r) => {
    if (child.exitCode !== null) r();
    else child.once('exit', () => r());
  });
  await rm(temp, { recursive: true, force: true });
}
