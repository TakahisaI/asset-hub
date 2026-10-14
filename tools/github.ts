import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export async function ghJson(endpoint: string) {
  const { stdout } = await exec('gh', ['api', endpoint], { maxBuffer: 100 * 1024 * 1024 });
  return JSON.parse(stdout);
}
export async function ghFile(repo: string, commit: string, file: string): Promise<Buffer> {
  if (/\.(glb|blend|png|jpg)$/i.test(file)) {
    const info = await ghJson(`repos/${repo}/contents/${file}?ref=${commit}`);
    const blob = await ghJson(`repos/${repo}/git/blobs/${info.sha}`);
    if (blob.encoding !== 'base64') throw new Error('Unsupported Git blob encoding');
    return Buffer.from(blob.content, 'base64');
  }
  const { stdout } = await exec(
    'gh',
    [
      'api',
      `repos/${repo}/contents/${file}?ref=${commit}`,
      '-H',
      'Accept: application/vnd.github.raw+json',
    ],
    { encoding: 'buffer', maxBuffer: 100 * 1024 * 1024 },
  );
  return stdout;
}
export async function pool<T>(items: T[], fn: (item: T) => Promise<void>, size = 3) {
  let i = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}
