import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  assetSchema,
  editSchema,
  noteInput,
  behaviorSchema,
  hashSchema,
  idSchema,
  downloadSchema,
  type Asset,
} from '../src/schema.ts';
import { inspectGlb } from '../tools/inspect.ts';
import { describeGlb, motionMap } from '../tools/glb.ts';
import { putBlob, readBlob, assertStorageReady } from './blobs.ts';
import {
  root,
  directoryEntries,
  getAsset,
  registerAsset,
  withLibraryLock,
  atomicJson,
  assetPath,
  nextTimestamp,
  getNotes,
  saveNotes,
  exists,
  digest,
} from './store.ts';

export function conflict() {
  return Object.assign(new Error('別の操作で更新されました。取得し直してから保存してください'), {
    status: 409,
  });
}
export async function editAsset(id: string, raw: unknown, expected: string) {
  const edit = editSchema.parse(raw);
  return withLibraryLock(async () => {
    const current = await getAsset(id);
    if (expected !== current.updatedAt) throw conflict();
    const updated = { ...current, ...edit, updatedAt: nextTimestamp(current.updatedAt) };
    await atomicJson(assetPath(id), updated);
    return updated;
  });
}
export async function changeMembership(
  id: string,
  field: 'tags' | 'collections',
  add: string[],
  remove: string[],
  expected?: string,
) {
  return withLibraryLock(async () => {
    const current = await getAsset(id);
    if (expected !== undefined && expected !== current.updatedAt) throw conflict();
    const edit = editSchema.parse({
      [field]: [...new Set([...current[field], ...add])].filter((v) => !remove.includes(v)),
    });
    const updated = { ...current, ...edit, updatedAt: nextTimestamp(current.updatedAt) };
    await atomicJson(assetPath(id), updated);
    return updated;
  });
}
export const importInput = editSchema
  .extend({
    id: idSchema,
    kind: z.enum(['model', 'motion']).optional(),
    source: assetSchema.shape.source.optional(),
    download: downloadSchema.optional(),
  })
  .strict();
export async function importGlb(
  bytes: Uint8Array,
  filename: string,
  raw: unknown,
  expected?: string,
) {
  return withLibraryLock(async () => {
    await assertStorageReady();
    const input = importInput.parse(raw),
      inspection = await inspectGlb(bytes);
    // Incomplete assets remain registrable; conformance findings belong in the catalog.
    if (!inspection.metrics.meshes && !inspection.metrics.animations)
      throw Object.assign(new Error('メッシュまたはアニメーションを含むGLBが必要です'), {
        status: 400,
      });
    const previous = (await exists(assetPath(input.id))) ? await getAsset(input.id) : null;
    if (previous && expected === undefined)
      throw Object.assign(new Error('このIDは登録済みです。replaceで新版を登録してください'), {
        status: 409,
      });
    if (expected !== undefined && previous?.updatedAt !== expected) throw conflict();
    const hash = await putBlob(bytes, previous?.revision),
      now = new Date().toISOString();
    return registerAsset(
      {
        schema: 1,
        id: input.id,
        name: input.name ?? path.basename(filename),
        description: input.description ?? '',
        category: input.category ?? 'other',
        kind: input.kind ?? (inspection.metrics.meshes ? 'model' : 'motion'),
        tags: input.tags ?? [],
        collections: input.collections ?? [],
        license: input.license ?? '未確認',
        source: input.source ?? {
          repository: 'local',
          commit: '',
          path: filename,
          kind: 'other',
          upstreamId: input.id,
          scope: 'GLBに含まれるモデル・アニメーション・照明',
          integrationNote: '制作ソースは別途保管してください。',
        },
        revision: hash,
        file: {
          hash,
          bytes: bytes.length,
          name: path.basename(filename),
          ...(input.download ? { download: input.download } : {}),
        },
        ...inspection,
        importedAt: now,
        updatedAt: now,
      },
      { createOnly: expected === undefined, expected },
    );
  });
}
export async function getRevision(id: string, revision: string) {
  const a = assetSchema.parse(
    JSON.parse(
      await readFile(
        path.join(
          root,
          'catalog/revisions',
          idSchema.parse(id),
          hashSchema.parse(revision) + '.json',
        ),
        'utf8',
      ),
    ),
  );
  if (a.id !== id || a.revision !== revision || a.file.hash !== revision)
    throw new Error('固定版のID・ハッシュが一致しません');
  return a;
}
export async function revisionDownloads(id: string, revision: string) {
  const fixed = await getRevision(id, revision);
  const records = [fixed];
  const dir = path.join(root, 'catalog/import-events', id, revision);
  for (const entry of await directoryEntries(dir)) {
    if (!entry.name.endsWith('.json')) continue;
    const event = z
      .object({ schema: z.literal(1), recordedAt: z.iso.datetime(), asset: assetSchema })
      .strict()
      .parse(JSON.parse(await readFile(path.join(dir, entry.name), 'utf8')));
    if (event.asset.id !== id || event.asset.revision !== revision)
      throw new Error('取込記録のID・版が一致しません');
    records.push(event.asset);
  }
  return records.flatMap((asset) =>
    asset.file.download
      ? [asset.file.download]
      : asset.file.upstreamPath && asset.source.repository !== 'local'
        ? [
            downloadSchema.parse({
              repository: asset.source.repository,
              commit: asset.source.commit,
              path: asset.file.upstreamPath,
            }),
          ]
        : [],
  );
}
export async function inspectAsset(id: string, revision?: string) {
  const a = revision ? await getRevision(id, revision) : await getAsset(id);
  const bytes = await readBlob(a.revision);
  if (digest(bytes) !== a.revision) throw new Error('SHA-256が一致しません');
  return describeGlb(bytes);
}
export function behaviorPath(hash: string) {
  return path.join(root, 'catalog/behaviors', hashSchema.parse(hash) + '.json');
}
export async function getBehavior(hash: string) {
  const behavior = behaviorSchema.parse(JSON.parse(await readFile(behaviorPath(hash), 'utf8')));
  if (digest(Buffer.from(JSON.stringify(behavior))) !== hash)
    throw new Error('動作設定のSHA-256が一致しません');
  return behavior;
}
export async function setBehavior(id: string, raw: unknown, expected: string) {
  const behavior = behaviorSchema.parse(raw);
  if (behavior.assetId !== id) throw new Error('動作設定のアセットIDが一致しません');
  const structure = await inspectAsset(id, behavior.modelRevision);
  for (const preset of behavior.presets) {
    const node = (index: number) => {
      if (!structure.nodes[index]?.active)
        throw new Error(`対象ノードがシーンにありません: ${index}`);
      return structure.nodes[index];
    };
    const rotations = new Set<number>();
    for (const rotation of preset.rotations) {
      node(rotation.node);
      if (rotations.has(rotation.node)) throw new Error('同じノードの回転指定が重複しています');
      rotations.add(rotation.node);
    }
    for (const light of preset.lights) {
      const target = node(light.node);
      if (!light.type && target.light === undefined)
        throw new Error('指定ノードには照明がありません');
    }
    if (preset.clip) {
      const { source, index } = preset.clip;
      const origin = source ? await inspectAsset(source.id, source.revision) : structure;
      if (!origin.clips[index]) throw new Error('クリップがありません');
      if (!source && preset.clip.nodeMap)
        throw new Error('nodeMapは外部モーションのみに指定できます');
      if (source) preset.clip.nodeMap = motionMap(origin, structure, index, preset.clip.nodeMap);
      for (const channel of origin.clips[index].channels) {
        const target =
          channel.node === undefined
            ? undefined
            : source
              ? preset.clip.nodeMap![channel.node]
              : channel.node;
        if (target === undefined)
          throw new Error('対象ノードを持たないアニメーションには未対応です');
        node(target);
        if (channel.path === 'rotation' && rotations.has(target))
          throw new Error('クリップと連続回転が同じノードを操作しています');
      }
    }
  }
  return withLibraryLock(async () => {
    const asset = await getAsset(id);
    if (asset.updatedAt !== expected) throw conflict();
    if (asset.revision !== behavior.modelRevision)
      throw new Error('動作設定は現在のGLBリビジョンに紐付けてください');
    const hash = digest(Buffer.from(JSON.stringify(behavior)));
    if (!(await exists(behaviorPath(hash)))) await atomicJson(behaviorPath(hash), behavior);
    const updated = { ...asset, behavior: hash, updatedAt: nextTimestamp(asset.updatedAt) };
    await atomicJson(assetPath(id), updated);
    return updated;
  });
}
export async function clearBehavior(id: string, expected: string) {
  return withLibraryLock(async () => {
    const asset = await getAsset(id);
    if (asset.updatedAt !== expected) throw conflict();
    delete asset.behavior;
    asset.updatedAt = nextTimestamp(asset.updatedAt);
    await atomicJson(assetPath(id), asset);
    return asset;
  });
}
export async function addNote(id: string, raw: unknown) {
  const input = noteInput.parse(raw);
  await getAsset(id);
  try {
    await getRevision(id, input.revision);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw Object.assign(new Error('登録されていないリビジョンです'), { status: 400 });
    throw error;
  }
  if (input.playback?.behavior) {
    const b = await getBehavior(input.playback.behavior);
    if (
      b.assetId !== id ||
      b.modelRevision !== input.revision ||
      (input.playback.preset && !b.presets.some((p) => p.id === input.playback!.preset))
    )
      throw new Error('メモの動作設定が対象の版と一致しません');
  }
  if (input.playback?.preset && !input.playback.behavior)
    throw new Error('プリセットへのメモには動作設定のハッシュが必要です');
  if (input.playback?.clip !== undefined) {
    if (input.playback.preset)
      throw new Error('クリップとプリセットはどちらか一つを指定してください');
    const structure = await inspectAsset(id, input.revision);
    if (!structure.clips[input.playback.clip]) throw new Error('メモのクリップがありません');
  }
  const note = {
    ...input,
    id: randomUUID(),
    assetId: id,
    createdAt: new Date().toISOString(),
    resolved: false,
  };
  await withLibraryLock(async () => {
    const notes = await getNotes(id);
    notes.push(note);
    await saveNotes(id, notes);
  });
  return note;
}
export async function resolveNote(id: string, noteId: string, resolved: boolean) {
  await getAsset(id);
  return withLibraryLock(async () => {
    const notes = await getNotes(id),
      note = notes.find((n) => n.id === noteId);
    if (!note) throw Object.assign(new Error('メモが見つかりません'), { status: 404 });
    note.resolved = resolved;
    await saveNotes(id, notes);
    return note;
  });
}
