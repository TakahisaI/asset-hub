import express from 'express';
import path from 'node:path';
import { createApp, apiErrors } from './app.ts';
import { fileURLToPath } from 'node:url';
const codeRoot = fileURLToPath(new URL('..', import.meta.url));
const { assertStorageReady } = await import('./blobs.ts');
await assertStorageReady();
const app = createApp();
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(codeRoot, 'dist')));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(codeRoot, 'dist/index.html')));
} else {
  const { createServer } = await import('vite');
  const vite = await createServer({
    root: codeRoot,
    server: { middlewareMode: true },
    appType: 'spa',
  });
  app.use(vite.middlewares);
}
app.use(apiErrors);
const port = Number(process.env.PORT ?? 4310);
const server = app.listen(port, '127.0.0.1', (error?: Error) => {
  if (error) {
    console.error(
      (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
        ? `127.0.0.1:${port}は使用中です。起動済みのAsset Hubを開くか、PORTで別のポートを指定してください。`
        : `Asset Hubを起動できません: ${error.message}`,
    );
    process.exit(1);
  }
  console.log(`Asset Hub: http://127.0.0.1:${(server.address() as { port: number }).port}`);
});
