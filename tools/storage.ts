import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { assetSchema, idSchema, hashSchema } from '../src/schema.ts';
import { blobDir, getBlobRecord, blobAvailable, cacheDir, cacheLimit } from '../server/blobs.ts';
import { getBehavior } from '../server/operations.ts';
import {
  directoryEntries,
  fileStat,
  getNotes,
  recordProblem,
  root,
  scanAssets,
  storeDir,
} from '../server/store.ts';

/** A read-only inventory, not an instruction to delete: other processes can add references. */
export async function inspectStorage() {
  const { assets, problems } = await scanAssets();
  const current = new Set(
    assets.flatMap((a) => [
      a.file.hash,
      ...(a.vfx
        ? [a.vfx.runtime, a.vfx.source.hash, ...(a.vfx.preview ? [a.vfx.preview.hash] : [])]
        : []),
    ]),
  );
  const vfxFiles = new Set<string>();
  const references = new Map<string, Set<string>>();
  function retain(hash: string, reference: string) {
    if (!references.has(hash)) references.set(hash, new Set());
    references.get(hash)!.add(reference);
  }
  function retainVfx(asset: import('../src/schema.ts').Asset, reference: string) {
    if (!asset.vfx) return;
    for (const hash of [asset.vfx.runtime, asset.vfx.source.hash, asset.vfx.preview?.hash])
      if (hash) {
        retain(hash, reference);
        vfxFiles.add(hash);
      }
  }
  for (const asset of assets) {
    retain(asset.file.hash, `asset:${asset.id}`);
    retainVfx(asset, `vfx:${asset.id}`);
  }
  const revisionsDir = path.join(root, 'catalog/revisions');
  for (const entry of await directoryEntries(revisionsDir)) {
    const dir = path.join(revisionsDir, entry.name);
    try {
      if (!entry.isDirectory()) throw new Error('固定版の保存先がディレクトリではありません');
      const id = idSchema.parse(entry.name);
      for (const file of await directoryEntries(dir)) {
        if (!file.name.endsWith('.json')) continue;
        const filename = path.join(dir, file.name);
        try {
          const asset = assetSchema.parse(JSON.parse(await readFile(filename, 'utf8')));
          if (
            asset.id !== id ||
            asset.revision + '.json' !== file.name ||
            asset.file.hash !== asset.revision
          )
            throw new Error('固定版のIDまたはハッシュが一致しません');
          retain(asset.file.hash, `revision:${id}`);
          retainVfx(asset, `vfx-revision:${id}`);
        } catch (error) {
          problems.push(recordProblem(filename, error));
        }
      }
    } catch (error) {
      problems.push(recordProblem(dir, error));
    }
  }
  const reviewsDir = path.join(root, 'catalog/reviews');
  const behaviorsDir = path.join(root, 'catalog/behaviors');
  for (const entry of await directoryEntries(behaviorsDir)) {
    if (!entry.name.endsWith('.json')) continue;
    try {
      const behavior = await getBehavior(entry.name.slice(0, -5));
      retain(behavior.modelRevision, `behavior:${entry.name}`);
      for (const preset of behavior.presets)
        if (preset.clip?.source)
          retain(preset.clip.source.revision, `motion:${entry.name}/${preset.id}`);
    } catch (error) {
      problems.push(recordProblem(path.join(behaviorsDir, entry.name), error));
    }
  }
  for (const entry of await directoryEntries(reviewsDir)) {
    if (!entry.name.endsWith('.json')) continue;
    try {
      const id = idSchema.parse(entry.name.slice(0, -5));
      // Resolved notes still refer to the original GLB, including notes without a current asset.
      for (const note of await getNotes(id)) retain(note.revision, `note:${id}/${note.id}`);
    } catch (error) {
      problems.push(recordProblem(path.join(reviewsDir, entry.name), error));
    }
  }
  const files: { file: string; hash: string; kind: string; bytes: number; logicalBytes: number }[] =
    [];
  const otherFiles: string[] = [];
  let indexBytes = 0;
  for (const entry of await directoryEntries(blobDir)) {
    if (!/^[a-f0-9]{64}\.json$/.test(entry.name)) {
      if (!/^[a-f0-9]{64}\.zst$/.test(entry.name)) otherFiles.push('blobs/' + entry.name);
      continue;
    }
    try {
      const record = await getBlobRecord(entry.name.slice(0, -5));
      indexBytes += (await fileStat(path.join(blobDir, entry.name)))!.size;
      if (record.base) retain(record.base, 'base:' + record.hash);
      const info = await fileStat(path.join(blobDir, record.hash + '.zst'));
      if (info)
        files.push({
          file: 'blobs/' + record.hash + '.zst',
          hash: record.hash,
          kind: vfxFiles.has(record.hash) ? 'vfx' : 'glb',
          bytes: info.size,
          logicalBytes: record.bytes,
        });
    } catch (error) {
      problems.push(recordProblem(path.join(blobDir, entry.name), error));
    }
  }
  for (const entry of await directoryEntries(storeDir)) {
    if (entry.name === 'blobs') continue;
    const match = /^([a-f0-9]{64})\.png$/.exec(entry.name);
    const info = await fileStat(path.join(storeDir, entry.name));
    if (!match || !info) {
      otherFiles.push(entry.name);
      continue;
    }
    files.push({
      file: entry.name,
      hash: match[1],
      kind: 'png',
      bytes: info.size,
      logicalBytes: info.size,
    });
  }
  const missing = [];
  for (const [hash, refs] of references) {
    try {
      if (await blobAvailable(hash)) continue;
    } catch (error) {
      problems.push(recordProblem(path.join(blobDir, hash + '.json'), error));
    }
    missing.push({ hash, references: [...refs].sort() });
  }
  const blobs = files.filter((f) => f.kind !== 'png');
  const glbs = blobs.filter((f) => f.kind === 'glb');
  const media = blobs.filter((f) => f.kind === 'vfx');
  const sum = (items: typeof files) => items.reduce((total, f) => total + f.bytes, 0);
  // Fail closed: malformed records may contain references we could not read.
  const candidates = problems.length
    ? []
    : files.filter((f) => !references.has(f.hash)).sort((a, b) => a.file.localeCompare(b.file));
  const { libraryInventory } = await import('./backup.ts');
  let catalogBytes = 0;
  try {
    catalogBytes = (await libraryInventory(root, true, ['catalog']))
      .filter((f) => f.path.startsWith('catalog/'))
      .reduce((sum, f) => sum + f.bytes, 0);
  } catch (error) {
    problems.push(recordProblem(path.join(root, 'catalog'), error));
  }
  let materializedBytes = 0;
  for (const entry of await directoryEntries(cacheDir))
    materializedBytes += (await fileStat(path.join(cacheDir, entry.name)))?.size ?? 0;
  return {
    schema: 1,
    root,
    dryRun: true,
    complete: problems.length === 0,
    scannedAt: new Date().toISOString(),
    summary: {
      glbFiles: glbs.length,
      glbBytes: sum(glbs),
      vfxFiles: media.length,
      vfxBytes: sum(media),
      logicalBytes: blobs.reduce((sum, f) => sum + f.logicalBytes, 0),
      currentBytes: sum(blobs.filter((f) => current.has(f.hash))),
      retainedHistoryBytes: sum(
        blobs.filter((f) => !current.has(f.hash) && references.has(f.hash)),
      ),
      thumbnailBytes: sum(files.filter((f) => f.kind === 'png')),
      candidateBytes: sum(candidates),
      indexBytes,
      catalogBytes,
      materializedBytes,
      cacheLimitBytes: cacheLimit(),
      libraryBytes: sum(files) + indexBytes + catalogBytes,
    },
    candidates: problems.length ? [] : candidates,
    missing,
    otherFiles: otherFiles.sort(),
    problems,
  };
}
