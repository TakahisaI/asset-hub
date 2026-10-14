import { writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { browser } from './browser.ts';
import { listAssets, storeDir, exists, withLibraryLock } from '../server/store.ts';
const base = process.env.ASSET_HUB_URL ?? 'http://127.0.0.1:4310';
const b = await browser();
const failures: string[] = [];
try {
  const page = await b.newPage({ viewport: { width: 720, height: 486 }, deviceScaleFactor: 1 });
  await page.addInitScript('window.__name = (fn) => fn');
  await page.goto(base + '/tools/blank.html');
  await page.evaluate(async () => {
    document.body.style.margin = '0';
    const host = document.createElement('div');
    host.style.cssText = 'width:720px;height:486px';
    document.body.append(host);
    const moduleUrl = '/src/viewer.ts';
    const { AssetViewer } = await import(/* @vite-ignore */ moduleUrl);
    (window as any).assetViewer = new AssetViewer(host);
  });
  await mkdir(storeDir, { recursive: true });
  for (const asset of await listAssets()) {
    const target = path.join(storeDir, asset.file.hash + '.png');
    if ((await exists(target)) && !process.argv.includes('--force')) continue;
    try {
      const data = await page.evaluate(async (hash) => {
        const v = (window as any).assetViewer;
        await v.load('/api/files/' + hash);
        v.grid.visible = false;
        v.renderer.setPixelRatio(1);
        v.fit();
        await new Promise<void>((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r())),
        );
        return v.capture();
      }, asset.file.hash);
      await withLibraryLock(async () => {
        const temp = target + '.' + randomUUID() + '.tmp';
        try {
          await writeFile(temp, Buffer.from(data.split(',')[1], 'base64'));
          await rename(temp, target);
        } finally {
          await rm(temp, { force: true });
        }
      });
      console.log('rendered', asset.id);
    } catch (e) {
      failures.push(asset.id);
      console.error(asset.id, (e as Error).message);
    }
  }
  await page.evaluate(() => (window as any).assetViewer.dispose());
} finally {
  await b.close();
}
if (failures.length) throw new Error('プレビュー生成失敗: ' + failures.join(', '));
