import express from 'express';
import path from 'node:path';
import { createApp, apiErrors } from './app.ts';
import { fileURLToPath } from 'node:url';
const codeRoot = fileURLToPath(new URL('..', import.meta.url));
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
const server = app.listen(port, '127.0.0.1', () =>
  console.log(`Asset Hub: http://127.0.0.1:${(server.address() as { port: number }).port}`),
);
