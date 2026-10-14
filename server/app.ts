import express from 'express';
import path from 'node:path';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { ZodError, z } from 'zod';
import {
  editAsset,
  importGlb,
  addNote,
  resolveNote,
  inspectAsset,
  getBehavior,
  setBehavior,
  clearBehavior,
} from './operations.ts';
import { hashSchema, idSchema } from '../src/schema.ts';
import { withBlob } from './blobs.ts';
import { inspectStorage } from '../tools/storage.ts';
import { getCatalog } from './catalog.ts';
import { createLock } from '../tools/assetctl.ts';
import {
  root,
  storeDir,
  getAsset,
  listAssets,
  getNotes,
  withLibraryLock,
  exists,
} from './store.ts';
export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const host = (req.headers.host ?? '').split(':')[0];
    if (!['127.0.0.1', 'localhost', '['].includes(host))
      return res.status(403).json({ error: 'ローカル接続のみ利用できます' });
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      req.headers.origin &&
      ![`http://${req.headers.host}`, `https://${req.headers.host}`].includes(req.headers.origin)
    )
      return res.status(403).json({ error: '異なるサイトからの保存は許可されていません' });
    next();
  });
  app.use(express.json({ limit: '256kb' }));
  app.post(
    '/api/import/:id',
    express.raw({ type: 'application/octet-stream', limit: '100mb' }),
    async (req, res) => {
      const id = idSchema.parse(req.params.id),
        name = z.string().min(1).max(160).parse(req.query.name),
        collection = z
          .string()
          .trim()
          .max(80)
          .parse(req.query.collection ?? '');
      const filename = z
        .string()
        .min(1)
        .max(255)
        .parse(req.query.filename ?? id + '.glb');
      if (!Buffer.isBuffer(req.body))
        return res.status(400).json({ error: 'GLBファイルが必要です' });
      const asset = await importGlb(
        req.body,
        filename,
        { id, name, collections: collection ? [collection] : [] },
        req.headers['if-match'] as string | undefined,
      );
      res.status(201).json(asset);
    },
  );
  app.post(
    '/api/assets/:id/thumbnail/:hash',
    express.raw({ type: 'image/png', limit: '8mb' }),
    async (req, res) => {
      const id = idSchema.parse(req.params.id),
        hash = hashSchema.parse(req.params.hash);
      if (!(await exists(path.join(root, 'catalog/revisions', id, hash + '.json'))))
        return res.status(404).json({ error: '登録された版が見つかりません' });
      if (
        !Buffer.isBuffer(req.body) ||
        !req.body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      )
        return res.status(400).json({ error: 'PNGが必要です' });
      const target = path.join(storeDir, hash + '.png'),
        temp = target + '.' + randomUUID() + '.tmp';
      await withLibraryLock(async () => {
        await writeFile(temp, req.body);
        await rename(temp, target);
      });
      res.json({ saved: true });
    },
  );
  app.get('/api/catalog', async (req, res) => {
    const q = String(req.query.q ?? '').toLowerCase(),
      collection = String(req.query.collection ?? '');
    const catalog = await getCatalog();
    const assets = catalog.assets.filter(
      (a) =>
        (!q || [a.name, a.id, a.description, ...a.tags].join(' ').toLowerCase().includes(q)) &&
        (!collection || a.collections.includes(collection)),
    );
    res.json({
      ...catalog,
      assets,
    });
  });
  app.get('/api/storage', async (_req, res) => res.json(await inspectStorage()));
  app.delete('/api/assets/:id/behavior', async (req, res) =>
    res.json(await clearBehavior(req.params.id, String(req.headers['if-match'] ?? ''))),
  );
  app.get('/api/assets/:id', async (req, res) => res.json(await getAsset(req.params.id)));
  app.get('/api/assets/:id/lock', async (req, res) => res.json(await createLock([req.params.id])));
  app.patch('/api/assets/:id', async (req, res) => {
    res.json(await editAsset(req.params.id, req.body, String(req.headers['if-match'] ?? '')));
  });
  app.get('/api/assets/:id/inspect', async (req, res) =>
    res.json(await inspectAsset(req.params.id)),
  );
  app.get('/api/behaviors/:hash', async (req, res) => res.json(await getBehavior(req.params.hash)));
  app.put('/api/assets/:id/behavior', async (req, res) =>
    res.json(await setBehavior(req.params.id, req.body, String(req.headers['if-match'] ?? ''))),
  );
  app.get('/api/assets/:id/notes', async (req, res) => {
    await getAsset(req.params.id);
    res.json(await getNotes(req.params.id));
  });
  app.post('/api/assets/:id/notes', async (req, res) => {
    res.status(201).json(await addNote(req.params.id, req.body));
  });
  app.patch('/api/assets/:id/notes/:noteId', async (req, res) => {
    const { resolved } = z.object({ resolved: z.boolean() }).strict().parse(req.body);
    res.json(await resolveNote(req.params.id, req.params.noteId, resolved));
  });
  app.get('/api/assets/:id/revisions', async (req, res) => {
    const a = await getAsset(req.params.id);
    const { readdir } = await import('node:fs/promises');
    const dir = path.join(root, 'catalog/revisions', a.id);
    res.json(
      await Promise.all(
        (await readdir(dir))
          .filter((f) => f.endsWith('.json'))
          .map(async (f) => JSON.parse(await readFile(path.join(dir, f), 'utf8'))),
      ),
    );
  });
  app.get('/api/files/:hash', async (req, res) => {
    const hash = hashSchema.parse(req.params.hash);
    res.set('Cache-Control', 'public,max-age=31536000,immutable').type('model/gltf-binary');
    await withBlob(
      hash,
      (file) =>
        new Promise<void>((resolve, reject) =>
          res.sendFile(file, { dotfiles: 'allow' }, (error) => (error ? reject(error) : resolve())),
        ),
    );
  });
  app.get('/api/thumbnails/:hash', async (req, res) => {
    const hash = hashSchema.parse(req.params.hash);
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(storeDir, hash + '.png'), { dotfiles: 'allow' });
  });
  app.get('/api/assets/:id/download', async (req, res) => {
    const a = await getAsset(req.params.id);
    await withBlob(
      a.file.hash,
      (file) =>
        new Promise<void>((resolve, reject) =>
          res.download(file, a.id + '.glb', { dotfiles: 'allow' }, (error) =>
            error ? reject(error) : resolve(),
          ),
        ),
    );
  });
  app.get('/api/export', async (req, res) =>
    res.json({ schema: 1, exportedAt: new Date().toISOString(), assets: await listAssets() }),
  );
  app.use('/api', (_req, res) => res.status(404).json({ error: '見つかりません' }));
  return app;
}
export function apiErrors(
  error: Error & { code?: string; status?: number },
  _req: express.Request,
  res: express.Response,
  _next: express.NextFunction,
) {
  const status =
    error instanceof ZodError ? 400 : error.code === 'ENOENT' ? 404 : (error.status ?? 500);
  if (status === 500) console.error(error);
  if (res.headersSent) return res.destroy(error);
  res.status(status).json({
    error:
      status === 404
        ? 'データが見つかりません'
        : status === 500
          ? '保存または読み込みに失敗しました'
          : error.message,
  });
}
