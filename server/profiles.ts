import path from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  renderProfileSchema,
  renderProfileTool,
  type RenderProfile,
} from '../src/render-profile-schema.ts';
import { hashSchema, type Asset } from '../src/schema.ts';
import {
  atomicJson,
  digest,
  exists,
  getAsset,
  listAssets,
  root,
  withLibraryLock,
} from './store.ts';
import { readBlob } from './blobs.ts';
import { getRevision } from './operations.ts';
import { profileGlb } from '../tools/profile.ts';
// Profiles are keyed by GLB content hash, never by asset ID.
// That keeps fixed revisions untouched and lets old revisions be measured after the fact.
export function profilePath(hash: string) {
  return path.join(root, 'catalog/profiles', hashSchema.parse(hash) + '.json');
}
export async function getProfile(hash: string): Promise<RenderProfile | null> {
  const file = profilePath(hash);
  if (!(await exists(file))) return null;
  const raw = JSON.parse(await readFile(file, 'utf8'));
  if (typeof raw?.tool === 'string' && raw.tool !== renderProfileTool)
    throw new Error(
      `計測方法の版が異なります（${raw.tool} / ${renderProfileTool}）。比較には同じ版での再計測が必要です。`,
    );
  const profile = renderProfileSchema.parse(raw);
  if (profile.glb.hash !== hash) throw new Error('描写プロファイルのGLBハッシュが一致しません');
  return profile;
}
export async function measureAsset(id: string, revision?: string) {
  const asset: Asset = revision ? await getRevision(id, revision) : await getAsset(id);
  const bytes = await readBlob(asset.revision);
  if (digest(bytes) !== asset.revision) throw new Error('SHA-256が一致しません');
  return profileGlb(bytes);
}
export async function saveProfiles(profiles: RenderProfile[]) {
  return withLibraryLock(async () => {
    for (const profile of profiles)
      await atomicJson(profilePath(profile.glb.hash), renderProfileSchema.parse(profile));
    return profiles.length;
  });
}
// Backfill reuses measurements taken by the same tool, so a rerun only fills gaps.
export async function measureAll(refresh = false) {
  const results: { id: string; revision: string; profile: RenderProfile; reused: boolean }[] = [];
  for (const asset of await listAssets()) {
    const existing = refresh ? null : await getProfile(asset.revision);
    if (existing?.tool === renderProfileTool) {
      results.push({ id: asset.id, revision: asset.revision, profile: existing, reused: true });
      continue;
    }
    results.push({
      id: asset.id,
      revision: asset.revision,
      profile: await measureAsset(asset.id, asset.revision),
      reused: false,
    });
  }
  return results;
}
