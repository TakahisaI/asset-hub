import { createReadStream } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  rename,
  rm,
  link,
  utimes,
  stat,
  open,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { z } from 'zod';
import { hashSchema } from '../src/schema.ts';
import {
  root,
  storeDir,
  digest,
  exists,
  fileStat,
  directoryEntries,
  atomicJson,
  readRecord,
  withLibraryLock,
} from './store.ts';

const run = promisify(execFile);
export const blobDir = path.join(storeDir, 'blobs');
export const cacheDir = path.join(root, '.cache/materialized');
const recordSchema = z
  .object({
    schema: z.literal(1),
    hash: hashSchema,
    bytes: z.number().int().nonnegative(),
    encodedHash: hashSchema,
    encodedBytes: z.number().int().positive(),
    base: hashSchema.optional(),
  })
  .strict();
export type BlobRecord = z.infer<typeof recordSchema>;
export function encodedPath(hash: string) {
  return path.join(blobDir, hashSchema.parse(hash) + '.zst');
}
export function manifestPath(hash: string) {
  return path.join(blobDir, hashSchema.parse(hash) + '.json');
}
export function cacheLimit() {
  return (
    z.coerce
      .number()
      .finite()
      .nonnegative()
      .parse(process.env.ASSET_HUB_CACHE_MB ?? 512) *
    1024 ** 2
  );
}
export async function fileDigest(file: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export async function getBlobRecord(hash: string) {
  const record = await readRecord(manifestPath(hash), (raw) => recordSchema.parse(raw));
  if (record.hash !== hash || record.base === hash)
    throw new Error('保存記録のハッシュが一致しません');
  return record;
}
export async function blobRecords(hash: string) {
  const record = await getBlobRecord(hash);
  if (!record.base) return [record];
  const base = await getBlobRecord(record.base);
  if (base.base) throw new Error('差分の連鎖は許可されていません');
  return [record, base];
}
export async function blobAvailable(hash: string) {
  try {
    for (const record of await blobRecords(hash))
      if ((await fileStat(encodedPath(record.hash)))?.size !== record.encodedBytes) return false;
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
async function checkEncoded(record: BlobRecord) {
  const info = await fileStat(encodedPath(record.hash));
  if (!info) throw Object.assign(new Error('圧縮データが見つかりません'), { code: 'ENOENT' });
  if (
    info.size !== record.encodedBytes ||
    (await fileDigest(encodedPath(record.hash))) !== record.encodedHash
  )
    throw new Error('圧縮データのSHA-256が一致しません: ' + record.hash);
}
async function workDirectory() {
  const dir = path.join(root, '.cache/work');
  await mkdir(dir, { recursive: true });
  return mkdtemp(path.join(dir, 'blob-'));
}
async function decode(record: BlobRecord, destination: string, baseFile?: string) {
  await checkEncoded(record);
  const output = await open(destination, 'wx');
  const child = spawn(
    'zstd',
    [
      '-q',
      '-d',
      '-M1024MB',
      ...(baseFile ? ['--patch-from=' + baseFile] : []),
      '-c',
      encodedPath(record.hash),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-4096);
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error('zstd復元に失敗しました: ' + stderr)),
    );
  });
  const hash = createHash('sha256');
  let bytes = 0;
  const verify = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      if (bytes > record.bytes) return done(new Error('復元サイズが保存記録を超えています'));
      hash.update(chunk);
      done(null, chunk);
    },
  });
  const written = pipeline(child.stdout, verify, output.createWriteStream());
  try {
    await Promise.all([exited, written]);
    if (bytes !== record.bytes || hash.digest('hex') !== record.hash)
      throw new Error('復元GLBのSHA-256が一致しません: ' + record.hash);
  } catch (error) {
    child.kill();
    await Promise.allSettled([exited, written]);
    await rm(destination, { force: true });
    throw error;
  }
}
// Always decode the archive, even if a materialized copy exists, when verifying durability.
export async function restoreBlob(hash: string, destination: string) {
  const [record, base] = await blobRecords(hash);
  if (!base) return decode(record, destination);
  const temp = await workDirectory();
  try {
    const baseFile = path.join(temp, 'base.glb');
    await decode(base, baseFile);
    await decode(record, destination, baseFile);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
export async function verifyBlob(hash: string) {
  const temp = await workDirectory();
  try {
    await restoreBlob(hash, path.join(temp, 'verified.glb'));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
export async function putBlobFile(file: string, previous?: string) {
  file = path.resolve(file);
  return withLibraryLock(async () => {
    const hash = await fileDigest(file);
    if (await exists(manifestPath(hash))) {
      await verifyBlob(hash);
      return hash;
    }
    const temp = await workDirectory();
    try {
      const full = path.join(temp, 'full.zst');
      await run('zstd', ['-q', '-3', file, '-o', full]);
      let encoded = full,
        base: string | undefined;
      if (previous && previous !== hash) {
        const prior = await getBlobRecord(previous);
        const baseHash = prior.base ?? prior.hash;
        const baseFile = path.join(temp, 'base.glb');
        await restoreBlob(baseHash, baseFile);
        const delta = path.join(temp, 'delta.zst');
        await run('zstd', ['-q', '-3', '-M1024MB', '--patch-from=' + baseFile, file, '-o', delta]);
        if ((await stat(delta)).size < (await stat(full)).size * 0.8) {
          encoded = delta;
          base = baseHash;
        }
      }
      const record = recordSchema.parse({
        schema: 1,
        hash,
        bytes: (await stat(file)).size,
        encodedHash: await fileDigest(encoded),
        encodedBytes: (await stat(encoded)).size,
        ...(base ? { base } : {}),
      });
      await mkdir(blobDir, { recursive: true });
      await rename(encoded, encodedPath(hash));
      await atomicJson(manifestPath(hash), record);
      try {
        await verifyBlob(hash);
      } catch (error) {
        await rm(manifestPath(hash), { force: true });
        await rm(encodedPath(hash), { force: true });
        throw error;
      }
      return hash;
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
}
export async function putBlob(data: Uint8Array, previous?: string) {
  const temp = await workDirectory();
  try {
    const input = path.join(temp, 'input.glb');
    await writeFile(input, data);
    const hash = await putBlobFile(input, previous);
    if (hash !== digest(data)) throw new Error('入力のSHA-256が一致しません');
    return hash;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
async function trimCache() {
  const files = [];
  for (const entry of await directoryEntries(cacheDir)) {
    if (!/^[a-f0-9]{64}\.glb$/.test(entry.name)) continue;
    const file = path.join(cacheDir, entry.name),
      info = await fileStat(file);
    if (info) files.push({ file, bytes: info.size, used: info.mtimeMs });
  }
  let bytes = files.reduce((sum, f) => sum + f.bytes, 0);
  for (const file of files.sort((a, b) => a.used - b.used)) {
    if (bytes <= cacheLimit()) break;
    await rm(file.file);
    bytes -= file.bytes;
  }
}
export async function withBlob<T>(hash: string, use: (file: string) => Promise<T>) {
  hashSchema.parse(hash);
  const temp = await workDirectory(),
    lease = path.join(temp, 'model.glb');
  try {
    await withLibraryLock(async () => {
      const records = await blobRecords(hash);
      for (const record of records) await checkEncoded(record);
      const cached = path.join(cacheDir, hash + '.glb');
      await mkdir(cacheDir, { recursive: true });
      if (await exists(cached)) {
        if ((await fileDigest(cached)) !== hash) await rm(cached);
      }
      if (!(await exists(cached))) {
        await restoreBlob(hash, lease);
        if (records[0].bytes <= cacheLimit()) await rename(lease, cached);
      }
      if (await exists(cached)) {
        // A hard link keeps in-flight readers valid while other processes evict cache entries.
        await link(cached, lease);
        const now = new Date();
        await utimes(cached, now, now);
      }
      await trimCache();
    });
    return await use(lease);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
export function readBlob(hash: string) {
  return withBlob(hash, (file) => readFile(file));
}
export async function assertStorageReady() {
  if ((await directoryEntries(storeDir)).some((f) => /^[a-f0-9]{64}\.glb$/.test(f.name)))
    throw new Error(
      '旧保存形式です。assetctl storage migrate --backup <新規バックアップ先> を実行してください',
    );
}
