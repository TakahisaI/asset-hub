import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { assetSchema, idSchema, hashSchema } from '../src/schema.ts';
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
  const current = new Set(assets.map((a) => a.file.hash));
  const references = new Map<string, Set<string>>();
  function retain(hash: string, reference: string) {
    if (!references.has(hash)) references.set(hash, new Set());
    references.get(hash)!.add(reference);
  }
  for (const asset of assets) retain(asset.file.hash, `asset:${asset.id}`);
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
  const files: { file: string; hash: string; kind: string; bytes: number }[] = [];
  const otherFiles: string[] = [];
  for (const entry of await directoryEntries(storeDir)) {
    const match = /^([a-f0-9]{64})\.(glb|png)$/.exec(entry.name);
    if (!match) {
      otherFiles.push(entry.name);
      continue;
    }
    try {
      const info = await fileStat(path.join(storeDir, entry.name));
      if (!info) {
        otherFiles.push(entry.name);
        continue;
      }
      files.push({
        file: entry.name,
        hash: hashSchema.parse(match[1]),
        kind: match[2],
        bytes: info.size,
      });
    } catch (error) {
      problems.push(recordProblem(path.join(storeDir, entry.name), error));
    }
  }
  const blobs = files.filter((f) => f.kind === 'glb');
  const present = new Set(blobs.map((f) => f.hash));
  const missing = [...references]
    .filter(([hash]) => !present.has(hash))
    .map(([hash, refs]) => ({ hash, references: [...refs].sort() }));
  const sum = (items: typeof files) => items.reduce((total, f) => total + f.bytes, 0);
  // Fail closed: malformed records may contain references we could not read.
  const candidates = problems.length
    ? []
    : files.filter((f) => !references.has(f.hash)).sort((a, b) => a.file.localeCompare(b.file));
  return {
    schema: 1,
    dryRun: true,
    complete: problems.length === 0,
    scannedAt: new Date().toISOString(),
    summary: {
      glbFiles: blobs.length,
      glbBytes: sum(blobs),
      currentBytes: sum(blobs.filter((f) => current.has(f.hash))),
      retainedHistoryBytes: sum(
        blobs.filter((f) => !current.has(f.hash) && references.has(f.hash)),
      ),
      thumbnailBytes: sum(files.filter((f) => f.kind === 'png')),
      candidateBytes: sum(candidates),
    },
    candidates,
    missing,
    otherFiles: otherFiles.sort(),
    problems,
    note: '現在の台帳・全固定版・解決済みを含む全メモを参照として保持。ファイルは削除しません。外部lockは走査対象外です。',
  };
}
