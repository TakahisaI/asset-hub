import path from 'node:path';
import {
  scanAssets,
  directoryEntries,
  fileStat,
  storeDir,
  root,
  getNotes,
  recordProblem,
} from './store.ts';
import { blobAvailable } from './blobs.ts';
import type { CatalogAsset } from '../src/schema.ts';
import { getProfile, profilePath } from './profiles.ts';

export async function getCatalog() {
  const [catalog, files, reviews] = await Promise.all([
    scanAssets(),
    directoryEntries(storeDir),
    directoryEntries(path.join(root, 'catalog/reviews')),
  ]);
  const stored = new Set<string>();
  const reviewFiles = new Set(reviews.map((f) => f.name));
  const problems = [...catalog.problems];
  for (const file of files) {
    try {
      if (
        file.isFile() ||
        (file.isSymbolicLink() && (await fileStat(path.join(storeDir, file.name))))
      )
        stored.add(file.name);
    } catch (error) {
      problems.push(recordProblem(path.join(storeDir, file.name), error));
    }
  }
  const assets: CatalogAsset[] = await Promise.all(
    catalog.assets.map(async (asset) => {
      let notesCount = 0;
      let profileError = '';
      const profile = await getProfile(asset.revision).catch((error) => {
        profileError = (error as Error).message;
        problems.push(recordProblem(profilePath(asset.revision), error));
        return null;
      });
      if (reviewFiles.has(asset.id + '.json')) {
        try {
          notesCount = (await getNotes(asset.id)).filter((n) => !n.resolved).length;
        } catch (error) {
          problems.push(
            recordProblem(path.join(root, 'catalog/reviews', asset.id + '.json'), error),
          );
        }
      }
      return {
        ...asset,
        available: await blobAvailable(asset.file.hash).catch((error) => {
          problems.push(
            recordProblem(path.join(storeDir, 'blobs', asset.file.hash + '.json'), error),
          );
          return false;
        }),
        thumbnail: stored.has(asset.file.hash + '.png'),
        notesCount,
        profile,
        profileError,
      };
    }),
  );
  return { schema: 1, assets, problems: problems.sort((a, b) => a.file.localeCompare(b.file)) };
}
