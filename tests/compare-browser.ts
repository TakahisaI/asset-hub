import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';
import { triangleGlb } from './fixtures.ts';
import { profileGlb } from '../tools/profile.ts';
import { readGlb, readGlbBinary, writeGlb } from '../tools/glb.ts';
import { compareUrl } from '../src/compare.tsx';

export async function testComparison(base: string, page: Page, temp: string) {
  const { importGlb, addNote } = await import('../server/operations.ts');
  const { saveProfiles, profilePath } = await import('../server/profiles.ts');
  const { getNotes } = await import('../server/store.ts');
  await page.setViewportSize({ width: 1440, height: 1000 });
  const bytes = triangleGlb(),
    rightG = readGlb(triangleGlb(false, 2));
  rightG.nodes![0].translation = [3, 0, 0];
  const rightBytes = writeGlb(rightG, readGlbBinary(triangleGlb(false, 2))!);
  const left = await importGlb(bytes, 'left.glb', { id: 'compare.left', name: '比較A' });
  const right = await importGlb(rightBytes, 'right.glb', { id: 'compare.right', name: '比較B' });
  const litG = {
    ...readGlb(bytes),
    scenes: [{ nodes: [1] }],
    nodes: [{ mesh: 0 }, { extensions: { KHR_lights_punctual: { light: 0 } }, children: [0] }],
    extensionsUsed: ['KHR_lights_punctual'],
    extensions: {
      KHR_lights_punctual: { lights: [{ type: 'directional', intensity: 100, color: [1, 0, 0] }] },
    },
  };
  const litBytes = writeGlb(litG, readGlbBinary(bytes)!);
  const lit = await importGlb(litBytes, 'lit.glb', { id: 'compare.lit', name: '内蔵照明モデル' });
  await saveProfiles([profileGlb(bytes), profileGlb(rightBytes)]);
  await addNote(left.id, { revision: left.revision, text: '比較で変更しないメモ' });
  const notes = await getNotes(left.id);
  const next = await importGlb(triangleGlb(false, 3), 'new.glb', { id: left.id }, left.updatedAt);
  const head = await readFile(path.join(temp, 'catalog/assets', left.id + '.json'));
  const snapshot = await readFile(
    path.join(temp, 'catalog/revisions', left.id, left.revision + '.json'),
  );
  const mutations: string[] = [];
  const track = (request: import('playwright').Request) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()))
      mutations.push(request.method() + ' ' + request.url());
  };
  page.on('request', track);
  const url = base + compareUrl(left, right);
  await page.goto(url);
  await page.getByRole('heading', { name: 'アセットを比較', exact: true }).waitFor();
  await page.getByLabel('Aの版', { exact: true }).selectOption(left.revision);
  assert.equal(await page.getByLabel('Bの版', { exact: true }).inputValue(), right.revision);
  const panel = page.getByLabel('固定版の負荷比較', { exact: true });
  await panel.getByRole('table').waitFor();
  assert.match(await panel.innerText(), /0 B/);
  assert.equal(await page.locator('.compare-viewport canvas').count(), 0);
  await page.getByRole('button', { name: '2つの3Dモデルを読み込む', exact: true }).click();
  const canvas = page.locator('.compare-viewport canvas');
  const pixels = () =>
    canvas.evaluate(async (element) => {
      const canvas = element as HTMLCanvasElement;
      const gl = canvas.getContext('webgl2')!;
      const data = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, data);
      return {
        width: canvas.width,
        height: canvas.height,
        sha256: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)))
          .map((n) => n.toString(16).padStart(2, '0'))
          .join(''),
      };
    });
  async function conditions() {
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '比較条件を保存', exact: true }).click();
    return JSON.parse(await readFile((await (await download).path())!, 'utf8'));
  }
  const initial = await conditions();
  assert.deepEqual(initial.left, { id: left.id, revision: left.revision });
  assert.notEqual(initial.left.revision, next.revision);
  await canvas.scrollIntoViewIfNeeded();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 20, { steps: 5 });
  await page.mouse.up();
  await page.mouse.wheel(0, -120);
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await page.getByLabel('比較の表示モード', { exact: true }).selectOption('normal');
  await page.getByLabel('比較の照明と背景', { exact: true }).selectOption('night');
  await page.getByLabel('グリッド', { exact: true }).uncheck();
  const a = await conditions();
  assert.notDeepEqual(a.camera.position, initial.camera.position);
  const imageA = await pixels();
  await page.getByRole('button', { name: 'Bを表示：比較B', exact: true }).click();
  const b = await conditions();
  assert.equal(b.displayed, 'B');
  for (const key of [
    'camera',
    'viewport',
    'mode',
    'lighting',
    'grid',
    'background',
    'toneMapping',
    'exposure',
  ])
    assert.deepEqual(b[key], a[key], key);
  assert.notDeepEqual(
    await pixels(),
    imageA,
    'Different scale/position must not be hidden by per-model fitting',
  );
  await page.getByRole('button', { name: /^Aを表示：/ }).click();
  assert.deepEqual(await pixels(), imageA);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: '比較条件をコピー', exact: true }).click();
  await page.getByText('比較条件をコピーしました', { exact: true }).waitFor();
  const copied = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  assert.deepEqual(copied.camera, a.camera);
  assert.deepEqual(copied.right, { id: right.id, revision: right.revision });
  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await conditions();
  assert.deepEqual(mobile.camera.position, a.camera.position);
  assert.deepEqual(mobile.camera.target, a.camera.target);
  assert(mobile.viewport.width < a.viewport.width);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole('button', { name: 'Bを表示：比較B', exact: true }).click();
  assert.deepEqual((await conditions()).viewport, mobile.viewport);
  await page.getByLabel('Bのアセット', { exact: true }).selectOption(lit.id);
  await page.getByRole('button', { name: '2つの3Dモデルを読み込む', exact: true }).click();
  const unlit = await conditions();
  assert.equal(unlit.embeddedLights, false);
  const sharedLighting = await pixels();
  await page.getByRole('button', { name: 'Bを表示：内蔵照明モデル', exact: true }).click();
  assert.deepEqual(
    await pixels(),
    sharedLighting,
    'Embedded lights must not change the common illumination',
  );
  await page.goto(base + compareUrl(lit, left));
  await page.getByRole('button', { name: '2つの3Dモデルを読み込む', exact: true }).click();
  await conditions();
  const reversed = await pixels();
  await page.getByRole('button', { name: /^Bを表示：/ }).click();
  assert.deepEqual(
    await pixels(),
    reversed,
    'Light nodes on either side must retain their child geometry',
  );
  await page.goto(url);
  const savedProfile = await readFile(profilePath(left.revision));
  await writeFile(
    profilePath(left.revision),
    JSON.stringify({ ...profileGlb(bytes), tool: 'render-profile/0' }),
  );
  await page.reload();
  await panel
    .getByRole('alert')
    .getByText(/計測方法の版が異なります/)
    .waitFor();
  assert.match(await panel.getByRole('table').innerText(), /—/);
  await writeFile(profilePath(left.revision), savedProfile);
  await rm(profilePath(right.revision));
  await page.reload();
  await panel.getByText('描写負荷：未計測', { exact: true }).waitFor();
  assert.match(await panel.getByRole('table').innerText(), /—/);
  await saveProfiles([profileGlb(rightBytes)]);
  await page.goto(base + compareUrl({ id: left.id, revision: 'a'.repeat(64) }, right));
  await page.getByRole('alert').getByText('Aの指定版が見つかりません。', { exact: true }).waitFor();
  assert.equal(await page.locator('.compare-viewport').count(), 0);
  assert.deepEqual(mutations, []);
  page.off('request', track);
  assert.deepEqual(await readFile(path.join(temp, 'catalog/assets', left.id + '.json')), head);
  assert.deepEqual(
    await readFile(path.join(temp, 'catalog/revisions', left.id, left.revision + '.json')),
    snapshot,
  );
  assert.deepEqual(await getNotes(left.id), notes);
  await page.goto(base + '?asset=test.baked');
  await page.getByRole('link', { name: '正本の固定版と比較', exact: true }).click();
  await page.getByRole('heading', { name: 'アセットを比較', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Aのアセット', { exact: true }).inputValue(), 'test.rigid');
  assert.equal(await page.getByLabel('Bのアセット', { exact: true }).inputValue(), 'test.baked');
  console.log(
    'Comparison PASS: fixed IDs/revisions, shared camera/projection/lighting/drawing buffer, no per-model fitting, roundtrip pixels, copied conditions, mobile resize, missing/incompatible profiles, source link and read-only metadata/notes.',
  );
}
