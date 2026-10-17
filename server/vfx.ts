import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Asset } from '../src/schema.ts';
import { root, digest, exists, atomicJson } from './store.ts';
import { manifestPath, verifyBlob, putBlob, putBlobFile, fileDigest } from './blobs.ts';

export async function preserveVfx(vfx: NonNullable<Asset['vfx']>, source: Asset['source']) {
  const trusted = path.join(root, 'catalog/runtimes', vfx.runtime + '.json');
  if (!(await exists(trusted))) {
    const bytes = await readFile(fileURLToPath(new URL('../src/vfx-runtime.js', import.meta.url)));
    if (digest(bytes) !== vfx.runtime)
      throw new Error(
        'VFX用ローダーが未保存です。対応するライブラリのバックアップから復元してください',
      );
    await putBlob(bytes);
    await atomicJson(trusted, { schema: 1, hash: vfx.runtime, renderer: 'three' });
  } else await verifyBlob(vfx.runtime);
  for (const file of [vfx.source, ...(vfx.preview ? [vfx.preview] : [])]) {
    if (await exists(manifestPath(file.hash))) {
      await verifyBlob(file.hash);
      continue;
    }
    if (source.repository !== 'local')
      throw new Error('VFX原本はcatalog/sourcesのスナップショットから登録してください');
    const allowed = await realpath(path.join(root, 'catalog/sources'));
    const location = await realpath(path.join(path.dirname(source.path), file.name));
    const relative = path.relative(allowed, location);
    if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative))
      throw new Error('VFX原本はcatalog/sources内に保管してください');
    if ((await fileDigest(location)) !== file.hash)
      throw new Error('VFX原本・動画のSHA-256が一致しません');
    if ((await putBlobFile(location)) !== file.hash)
      throw new Error('VFX原本・動画が登録中に変更されました');
  }
}
