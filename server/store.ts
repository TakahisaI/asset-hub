import { mkdir, readFile, writeFile, rename, readdir, access, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import os from 'node:os';
import {
  assetSchema,
  hashSchema,
  idSchema,
  reviewNoteSchema,
  type Asset,
  type ReviewNote,
  type CatalogProblem,
} from '../src/schema.ts';
export const root = path.resolve(process.env.ASSET_HUB_ROOT || process.cwd());
export const storeDir = path.join(root, '.store');
export const assetDir = path.join(root, 'catalog/assets');
// Stat on each read so edits from a CLI/another process are immediately visible.
// Atomic replacements and same-size edits also change the inode/ctime stamp.
const records = new Map<string, { stamp: string; value: unknown }>();
export async function readRecord<T>(file: string, parse: (raw: unknown) => T): Promise<T> {
  let info;
  try {
    info = await stat(file, { bigint: true });
  } catch (error) {
    records.delete(file);
    throw error;
  }
  const stamp = [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
  const cached = records.get(file);
  if (cached?.stamp === stamp) return structuredClone(cached.value) as T;
  const value = parse(JSON.parse(await readFile(file, 'utf8')));
  if (records.size >= 2048) records.delete(records.keys().next().value!);
  records.set(file, { stamp, value });
  return structuredClone(value);
}
export async function directoryEntries(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
export async function fileStat(file: string) {
  try {
    const info = await stat(file);
    return info.isFile() ? info : null;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return null;
    throw error;
  }
}
export function recordProblem(file: string, error: unknown): CatalogProblem {
  return {
    file: path.relative(root, file),
    message: error instanceof Error ? error.message : String(error),
  };
}
export async function atomicJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temp, JSON.stringify(value, null, 2) + '\n');
    await rename(temp, file);
  } finally {
    await rm(temp, { force: true });
  }
  records.delete(file);
}
export async function exists(file: string) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}
export function assetPath(id: string) {
  return path.join(assetDir, idSchema.parse(id) + '.json');
}
export async function getAsset(id: string) {
  const asset = await readRecord(assetPath(id), (raw) => assetSchema.parse(raw));
  if (asset.id !== id || asset.revision !== asset.file.hash)
    throw new Error('台帳のIDまたはリビジョンとGLBハッシュが一致しません');
  return asset;
}
export async function scanAssets() {
  const files = (await directoryEntries(assetDir))
    .filter((f) => f.name.endsWith('.json'))
    .map((f) => f.name)
    .sort();
  const results = await Promise.all(
    files.map(async (file) => {
      try {
        return { asset: await getAsset(file.slice(0, -5)) };
      } catch (error) {
        return { problem: recordProblem(path.join(assetDir, file), error) };
      }
    }),
  );
  return {
    assets: results.flatMap((r) => (r.asset ? [r.asset] : [])),
    problems: results.flatMap((r) => (r.problem ? [r.problem] : [])),
  };
}
export async function listAssets() {
  const result = await scanAssets();
  if (result.problems.length)
    throw new Error(result.problems.map((p) => `${p.file}: ${p.message}`).join('\n'));
  return result.assets;
}
export async function getNotes(id: string): Promise<ReviewNote[]> {
  idSchema.parse(id);
  const file = path.join(root, 'catalog/reviews', id + '.json');
  try {
    const notes = await readRecord(file, (raw) => reviewNoteSchema.array().parse(raw));
    if (notes.some((n) => n.assetId !== id)) throw new Error('メモのアセットIDが一致しません');
    return notes;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}
export async function saveNotes(id: string, notes: ReviewNote[]) {
  await withLibraryLock(() =>
    atomicJson(
      path.join(root, 'catalog/reviews', idSchema.parse(id) + '.json'),
      reviewNoteSchema.array().parse(notes),
    ),
  );
}
export function digest(data: Uint8Array) {
  return createHash('sha256').update(data).digest('hex');
}
export async function registerAsset(
  raw: Asset,
  options: { createOnly?: boolean; expected?: string } = {},
) {
  return withLibraryLock(async () => {
    const asset = assetSchema.parse(raw),
      prev = (await exists(assetPath(asset.id))) ? await getAsset(asset.id) : null;
    if (options.createOnly && prev)
      throw Object.assign(new Error('このIDは登録済みです。replaceで新版を登録してください'), {
        status: 409,
      });
    if (options.expected !== undefined && (!prev || prev.updatedAt !== options.expected))
      throw Object.assign(new Error('別の操作で更新されました。取得し直してください'), {
        status: 409,
      });
    if (prev) {
      asset.name = prev.name;
      asset.description = prev.description;
      asset.tags = prev.tags;
      asset.collections = prev.collections;
      asset.license = prev.license;
      asset.category = prev.category;
      asset.kind = prev.kind;
      if (prev.revision === asset.revision) asset.behavior = prev.behavior;
      else delete asset.behavior;
      asset.importedAt = prev.importedAt;
      asset.updatedAt = nextTimestamp(prev.updatedAt);
    }
    const snapshot = path.join(root, 'catalog/revisions', asset.id, asset.revision + '.json');
    await atomicJson(
      path.join(root, 'catalog/import-events', asset.id, asset.revision, randomUUID() + '.json'),
      { schema: 1, recordedAt: new Date().toISOString(), asset },
    );
    if (await exists(snapshot)) {
      const fixed = assetSchema.parse(JSON.parse(await readFile(snapshot, 'utf8')));
      if (fixed.id !== asset.id || fixed.revision !== asset.revision)
        throw new Error('固定版のIDまたはハッシュが一致しません');
      // Discovery/inspection changes are import events; fixed revision fields stay immutable.
      for (const key of ['source', 'file', 'metrics', 'qa', 'importWarnings', 'vfx'] as const)
        Object.assign(asset, { [key]: fixed[key] });
    } else await atomicJson(snapshot, asset);
    await atomicJson(assetPath(asset.id), asset);
    return asset;
  });
}
export function nextTimestamp(previous: string) {
  return new Date(Math.max(Date.now(), Date.parse(previous) + 1)).toISOString();
}
const holdingLock = new AsyncLocalStorage<boolean>();
let queue: Promise<unknown> = Promise.resolve();
export const libraryLockPath = path.join(root, '.cache/locks/library.lock');
// One process-shared write lock also gives backups a consistent library snapshot.
export function withLibraryLock<T>(fn: () => Promise<T>): Promise<T> {
  if (holdingLock.getStore()) return fn();
  const next = queue
    .catch(() => {})
    .then(async () => {
      await mkdir(path.dirname(libraryLockPath), { recursive: true });
      const started = Date.now();
      while (true) {
        try {
          await mkdir(libraryLockPath);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          if (Date.now() - started > 10000)
            throw Object.assign(
              new Error(
                `保存ロックを取得できません: ${libraryLockPath}。実行中の処理を確認してください`,
              ),
              { status: 409 },
            );
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
      try {
        await writeFile(
          path.join(libraryLockPath, 'owner.json'),
          JSON.stringify({
            pid: process.pid,
            host: os.hostname(),
            startedAt: new Date().toISOString(),
          }),
        );
        return await holdingLock.run(true, fn);
      } finally {
        await rm(libraryLockPath, { recursive: true });
      }
    });
  queue = next;
  return next;
}
