import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { assetSchema } from '../src/schema.ts';
import {
  root,
  storeDir,
  scanAssets,
  directoryEntries,
  fileStat,
  atomicJson,
  withLibraryLock,
  libraryLockPath,
  assetPath,
} from '../server/store.ts';
import { blobDir, fileDigest, getBlobRecord, putBlobFile, verifyBlob } from '../server/blobs.ts';
import { getBehavior, getRevision } from '../server/operations.ts';
import { backupLibrary } from './backup.ts';
import { inspectStorage } from './storage.ts';

export async function doctor() {
  const storage = await inspectStorage(),
    corrupt: { hash: string; error: string }[] = [];
  for (const entry of await directoryEntries(blobDir)) {
    if (!/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
    const hash = entry.name.slice(0, -5);
    try {
      await verifyBlob(hash);
    } catch (error) {
      corrupt.push({ hash, error: (error as Error).message });
    }
  }
  const locks = [];
  for (const entry of await directoryEntries(path.dirname(libraryLockPath))) {
    const file = path.join(path.dirname(libraryLockPath), entry.name);
    let owner: { pid?: number; host?: string; startedAt?: string } | undefined;
    try {
      owner = JSON.parse(await readFile(path.join(file, 'owner.json'), 'utf8'));
    } catch {
      /* A crashed process can leave an empty lock. */
    }
    let state = 'unknown';
    if (owner?.host === os.hostname() && Number.isInteger(owner.pid) && owner.pid! > 0) {
      try {
        process.kill(owner.pid!, 0);
        state = 'active';
      } catch (error) {
        state = (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'stale' : 'unknown';
      }
    }
    locks.push({ path: file, state, owner });
  }
  let lastBackup: unknown = null;
  try {
    lastBackup = JSON.parse(await readFile(path.join(root, '.cache/last-backup.json'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return {
    ok:
      storage.complete &&
      !storage.missing.length &&
      !corrupt.length &&
      !locks.some((l) => l.state !== 'active'),
    storage,
    corrupt,
    locks,
    lastBackup,
  };
}

export async function migrateStorage(backup: string) {
  return withLibraryLock(async () => {
    const rawFiles = (await directoryEntries(storeDir)).filter((f) =>
      /^[a-f0-9]{64}\.glb$/.test(f.name),
    );
    if (!rawFiles.length) return { migrated: 0, message: '旧形式のGLBはありません' };
    const saved = await backupLibrary(backup);
    const { assets, problems } = await scanAssets();
    if (problems.length) throw new Error(JSON.stringify(problems));
    const raw = new Map<string, string>(),
      encoded = new Set<string>();
    let originalBytes = 0;
    for (const entry of rawFiles) {
      const file = path.join(storeDir, entry.name),
        hash = entry.name.slice(0, -4);
      if ((await fileDigest(file)) !== hash)
        throw new Error('元GLBのSHA-256が一致しません: ' + entry.name);
      originalBytes += (await fileStat(file))!.size;
      raw.set(hash, file);
    }
    // Register chronological versions of each asset against the same full base where useful.
    for (const entry of await directoryEntries(path.join(root, 'catalog/revisions'))) {
      const revisions = [];
      for (const file of await directoryEntries(path.join(root, 'catalog/revisions', entry.name)))
        if (file.name.endsWith('.json'))
          revisions.push(await getRevision(entry.name, file.name.slice(0, -5)));
      revisions.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
      let previous: string | undefined;
      for (const revision of revisions) {
        const file = raw.get(revision.revision);
        if (file && !encoded.has(revision.revision)) {
          await putBlobFile(file, previous);
          encoded.add(revision.revision);
        } else await getBlobRecord(revision.revision);
        previous = revision.revision;
      }
    }
    for (const [hash, file] of raw) if (!encoded.has(hash)) await putBlobFile(file);
    for (const hash of raw.keys()) await verifyBlob(hash);
    // Preserve the pre-migration head as an event before aligning immutable fields.
    for (const asset of assets) {
      const fixed = await getRevision(asset.id, asset.revision);
      const updated = structuredClone(asset);
      for (const key of ['source', 'file', 'metrics', 'qa', 'importWarnings'] as const)
        Object.assign(updated, { [key]: fixed[key] });
      if (
        updated.behavior &&
        (await getBehavior(updated.behavior)).modelRevision !== updated.revision
      )
        delete updated.behavior;
      if (JSON.stringify(updated) !== JSON.stringify(asset)) {
        await atomicJson(
          path.join(
            root,
            'catalog/import-events',
            asset.id,
            asset.revision,
            randomUUID() + '.json',
          ),
          { schema: 1, recordedAt: new Date().toISOString(), asset },
        );
        await atomicJson(assetPath(asset.id), assetSchema.parse(updated));
      }
    }
    const report = await inspectStorage();
    if (!report.complete || report.missing.length)
      throw new Error(
        '移行後の参照検証に失敗しました: ' +
          JSON.stringify(
            report.problems.concat(report.missing.map((m) => ({ file: m.hash, message: '欠落' }))),
          ),
      );
    // Only redundant raw copies are removed; every revision and its archive remain.
    for (const [hash, file] of raw)
      if ((await fileDigest(file)) !== hash)
        throw new Error('移行中に元GLBが変更されました: ' + file);
    for (const file of raw.values()) await rm(file);
    return {
      migrated: raw.size,
      originalBytes,
      compressedBytes: report.summary.glbBytes,
      backup: saved,
    };
  });
}
