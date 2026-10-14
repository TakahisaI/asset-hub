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
await mkdir(path.join(temp, 'catalog/behaviors'), { recursive: true });
await writeFile(
  path.join(temp, 'catalog/behaviors', asset.behavior + '.json'),
  JSON.stringify(behavior),
);
await mkdir(path.join(temp, 'catalog/assets'), { recursive: true });
await mkdir(path.join(temp, 'catalog/revisions', asset.id), { recursive: true });
await mkdir(path.join(temp, '.store'), { recursive: true });
await writeFile(path.join(temp, 'catalog/assets', asset.id + '.json'), JSON.stringify(asset));
await writeFile(
  path.join(temp, 'catalog/revisions', asset.id, asset.revision + '.json'),
  JSON.stringify(asset),
);
await writeFile(path.join(temp, '.store', asset.file.hash + '.glb'), bytes);
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
  await page.locator('.viewer-state').waitFor({ state: 'hidden', timeout: 20000 });
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
  await page.getByText('部材の接続位置を再確認する', { exact: true }).waitFor();
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
    .setInputFiles(path.join(temp, '.store', asset.file.hash + '.glb'));
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
  assert.equal(notes.length, 1);
  assert.equal(notes[0].resolved, true);
  assert.equal(notes[0].revision, asset.revision);
  assert.ok(notes[0].camera);
  assert.equal(notes[0].playback.clip, 0);
  assert.equal(notes[0].playback.time, 0.75);
  console.log(
    'Browser PASS: 3D load, one-click modes, metadata/collections persistence, notes/camera/resolve, lock download, GLB upload, modal focus, search, mobile grid/list/detail, deferred heavy model, partial catalog failure.',
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
