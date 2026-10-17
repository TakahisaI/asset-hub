import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('occupied ports report the startup error and exit in production and development', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'asset-hub-startup-'));
  const occupied = createServer();
  occupied.listen(0, '127.0.0.1');
  await once(occupied, 'listening');
  const port = (occupied.address() as { port: number }).port;
  try {
    for (const mode of ['production', 'development'])
      await assert.rejects(
        () =>
          promisify(execFile)(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
            env: { ...process.env, PORT: String(port), NODE_ENV: mode, ASSET_HUB_ROOT: temp },
            timeout: 10000,
          }),
        (error: any) => {
          assert.equal(error.code, 1);
          assert.match(error.stderr, new RegExp(`127\\.0\\.0\\.1:${port}は使用中`));
          assert.doesNotMatch(error.stderr, /TypeError/);
          assert.doesNotMatch(error.stdout, /Asset Hub: http/);
          return true;
        },
      );
  } finally {
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
    await rm(temp, { recursive: true, force: true });
  }
});
