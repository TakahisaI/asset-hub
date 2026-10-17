import {
  readFile,
  writeFile,
  mkdir,
  link,
  rename,
  unlink,
  mkdtemp,
  copyFile,
  rm,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { parseArgs } from 'node:util';
import {
  assetSchema,
  editSchema,
  behaviorSchema,
  noteInput,
  hashSchema,
  idSchema,
} from '../src/schema.ts';
import { root, getAsset, listAssets, exists, atomicJson } from '../server/store.ts';
import {
  importGlb,
  importInput,
  editAsset,
  changeMembership,
  inspectAsset,
  getRevision,
  getBehavior,
  setBehavior,
  clearBehavior,
  revisionDownloads,
  addNote,
  resolveNote,
} from '../server/operations.ts';
import { getNotes, directoryEntries } from '../server/store.ts';
import { ghFile } from './github.ts';
import { inspectStorage } from './storage.ts';
import { putBlob, withBlob, manifestPath, fileDigest } from '../server/blobs.ts';
import { backupLibrary, verifyBackup, restoreBackup } from './backup.ts';
import { doctor, migrateStorage } from './maintenance.ts';
export const lockSchema = z.object({
  schema: z.literal(1),
  assets: z
    .array(
      z.object({
        id: idSchema,
        revision: hashSchema,
        variant: z.literal('glb'),
        behavior: hashSchema.optional(),
        sha256: hashSchema,
        file: z.string().optional(),
        source: z.unknown().optional(),
      }),
    )
    .min(1)
    .refine(
      (items) => new Set(items.map((a) => a.id + ':' + a.revision)).size === items.length,
      '固定版の指定が重複しています',
    ),
});
export async function syncLock(raw: unknown, out: string, force = false) {
  const lock = lockSchema.parse(raw);
  const staging = await mkdtemp(path.join(os.tmpdir(), 'asset-hub-sync-'));
  try {
    const plan: { staged: string; target: string; hash: string; cache: boolean }[] = [];
    const runtimeFiles = new Map<string, string>();
    for (const item of lock.assets)
      if (item.behavior) {
        const behavior = await getBehavior(item.behavior);
        if (behavior.assetId !== item.id || behavior.modelRevision !== item.revision)
          throw new Error('動作設定と固定GLBが一致しません');
        for (const preset of behavior.presets)
          if (
            preset.clip?.source &&
            !lock.assets.some(
              (a) =>
                a.id === preset.clip!.source!.id && a.revision === preset.clip!.source!.revision,
            )
          )
            throw new Error('lockに参照モーションがありません');
        const staged = path.join(staging, item.behavior + '.behavior.json');
        const target = path.join(path.resolve(out), item.behavior + '.behavior.json');
        await writeFile(staged, JSON.stringify(behavior, null, 2) + '\n');
        if (await exists(target)) {
          if ((await fileDigest(target)) === (await fileDigest(staged))) continue;
          if (!force)
            throw new Error(`異なる内容のファイルがあります: ${target} (--force で上書き)`);
        }
        if (!plan.some((p) => p.target === target))
          plan.push({ staged, target, hash: item.behavior, cache: false });
      }
    // Stage verified files on disk before publishing any destination. RAM usage does not
    // grow with the total lock size; GitHub downloads hold at most one GLB at a time.
    for (const item of lock.assets) {
      if (item.revision !== item.sha256) throw new Error('revision と sha256 が一致しません');
      const revision = assetSchema.parse(
        JSON.parse(
          await readFile(
            path.join(root, 'catalog/revisions', item.id, item.revision + '.json'),
            'utf8',
          ),
        ),
      );
      if (
        revision.id !== item.id ||
        revision.revision !== item.revision ||
        revision.file.hash !== item.sha256
      )
        throw new Error('登録済みの固定版と一致しません');
      if (revision.vfx) {
        const hash = revision.vfx.runtime;
        const target = path.join(path.resolve(out), 'asset-hub-vfx.' + hash.slice(0, 12) + '.js');
        runtimeFiles.set(item.id + ':' + item.revision, path.basename(target));
        if (!plan.some((p) => p.target === target)) {
          const staged = path.join(staging, hash + '.js');
          await withBlob(hash, (file) => copyFile(file, staged));
          if (await exists(target)) {
            if ((await fileDigest(target)) !== hash) {
              if (!force)
                throw new Error(`異なる内容のファイルがあります: ${target} (--force で上書き)`);
              plan.push({ staged, target, hash, cache: false });
            }
          } else plan.push({ staged, target, hash, cache: false });
        }
      }
      const staged = path.join(staging, item.sha256 + '.glb');
      const cache = !(await exists(manifestPath(item.sha256)));
      if (!(await exists(staged))) {
        if (!cache) await withBlob(item.sha256, (file) => copyFile(file, staged));
        else {
          const downloads = await revisionDownloads(item.id, item.revision);
          const failures = [];
          let fetched = false;
          for (const download of downloads) {
            try {
              await writeFile(
                staged,
                await ghFile(download.repository, download.commit, download.path),
              );
              if ((await fileDigest(staged)) !== item.sha256)
                throw new Error('SHA-256が一致しません');
              fetched = true;
              break;
            } catch (error) {
              failures.push((error as Error).message);
            }
          }
          if (!fetched)
            throw new Error(
              `GLBが未取得です: ${item.id}。バックアップから復元してください。${failures.join('; ')}`,
            );
        }
        if ((await fileDigest(staged)) !== item.sha256)
          throw new Error(`SHA-256が一致しません: ${item.id}`);
      }
      const filename = item.id + '.' + item.revision.slice(0, 12) + '.glb';
      const target = path.join(path.resolve(out), filename);
      if (await exists(target)) {
        if ((await fileDigest(target)) === item.sha256) continue;
        if (!force) throw new Error(`異なる内容のファイルがあります: ${target} (--force で上書き)`);
      }
      plan.push({ staged, target, hash: item.sha256, cache });
    }
    await mkdir(out, { recursive: true });
    await rm(path.join(out, 'asset-hub-sync-manifest.json'), { force: true });
    for (const item of plan) {
      const temp = item.target + '.' + randomUUID() + '.tmp';
      try {
        await copyFile(item.staged, temp);
        if (force) await rename(temp, item.target);
        else await link(temp, item.target);
      } finally {
        if (await exists(temp)) await unlink(temp);
      }
      if (item.cache) await putBlob(await readFile(item.staged));
    }
    await atomicJson(path.join(out, 'asset-hub-sync-manifest.json'), lock);
    return lock.assets.map((item) => ({
      id: item.id,
      revision: item.revision,
      file: item.id + '.' + item.revision.slice(0, 12) + '.glb',
      ...(item.behavior ? { behaviorFile: item.behavior + '.behavior.json' } : {}),
      ...(runtimeFiles.has(item.id + ':' + item.revision)
        ? { runtimeFile: runtimeFiles.get(item.id + ':' + item.revision) }
        : {}),
    }));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
export async function createLock(ids: string[]) {
  const assets: z.infer<typeof lockSchema>['assets'] = [];
  for (const id of ids) {
    const a = await getAsset(id);
    const entry = {
      id,
      revision: a.revision,
      variant: 'glb' as const,
      sha256: a.revision,
      ...(a.behavior ? { behavior: a.behavior } : {}),
    };
    const existing = assets.find((x) => x.id === id && x.revision === a.revision);
    if (existing) Object.assign(existing, entry);
    else assets.push(entry);
    if (a.behavior) {
      const b = await getBehavior(a.behavior);
      if (b.assetId !== id || b.modelRevision !== a.revision)
        throw new Error('GLB更新後の動作設定を再設定してください: ' + id);
      for (const preset of b.presets)
        if (preset.clip?.source) {
          const source = preset.clip.source;
          await getRevision(source.id, source.revision);
          if (!assets.some((a) => a.id === source.id && a.revision === source.revision))
            assets.push({
              id: source.id,
              revision: source.revision,
              sha256: source.revision,
              variant: 'glb',
            });
        }
    }
  }
  return lockSchema.parse({ schema: 1, assets });
}
export const importManifestSchema = z
  .object({
    schema: z.literal(1),
    assets: z.array(importInput.extend({ file: z.string().min(1) }).strict()).min(1),
  })
  .strict();
async function jsonInput(file: string) {
  if (file !== '-') return JSON.parse(await readFile(file, 'utf8'));
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return JSON.parse(text);
}
const help = {
  usage: 'ASSET_HUB_ROOT=/path/to/library node --import tsx tools/assetctl.ts <command>',
  output: 'stdout: JSON / stderr: {error:{code,message}} / failure: exit 1',
  commands: [
    'search [query] [--tag value] [--collection value] [--category value] [--kind model|motion]',
    'get <id> [--revision sha256]',
    'inspect <id> [--revision sha256]',
    'revisions <id>',
    'add <file.glb> --id <id> [--name name] [--metadata file.json|-]',
    'update <id> --json file.json|- --if-match updatedAt',
    'replace <id> <file.glb> --if-match updatedAt [--metadata file.json|-]',
    'tag add|remove <id> <tag>... [--if-match updatedAt]',
    'collection add|remove <id> <collection>... [--if-match updatedAt]',
    'import --manifest file.json [--update]',
    'behavior get <id> | behavior set <id> --json file.json|- --if-match updatedAt | behavior clear <id> --if-match updatedAt',
    'note list <id> | note add <id> --json file.json|- | note resolve|reopen <id> <note-id>',
    'lock <id>...',
    'sync --lock file.json --out directory [--force]',
    'gc --dry-run',
    'doctor',
    'backup --out new-directory | backup verify directory',
    'restore --from backup-directory --into new-library-directory',
    'storage migrate --backup new-directory',
    'schema asset|edit|behavior|import|note',
  ],
};
async function main() {
  const [command = 'help', ...argv] = process.argv.slice(2);
  const options: Record<string, { type: 'string' | 'boolean' }> = Object.fromEntries(
    [
      'id',
      'name',
      'description',
      'license',
      'tag',
      'collection',
      'category',
      'kind',
      'metadata',
      'json',
      'if-match',
      'revision',
      'manifest',
      'lock',
      'out',
      'from',
      'into',
      'backup',
    ].map((k) => [k, { type: 'string' }]),
  );
  for (const key of ['force', 'dry-run', 'update', 'help']) options[key] = { type: 'boolean' };
  const { values: v, positionals: args } = parseArgs({
    args: argv,
    options,
    strict: true,
    allowPositionals: true,
  });
  const allowed: Record<string, string[]> = {
    help: [],
    schema: [],
    search: ['tag', 'collection', 'category', 'kind'],
    get: ['revision'],
    inspect: ['revision'],
    revisions: [],
    add: [
      'id',
      'name',
      'description',
      'license',
      'category',
      'kind',
      'metadata',
      'tag',
      'collection',
    ],
    replace: ['if-match', 'metadata'],
    update: ['json', 'if-match'],
    tag: ['if-match'],
    collection: ['if-match'],
    behavior: args[0] === 'set' ? ['json', 'if-match'] : args[0] === 'clear' ? ['if-match'] : [],
    note: args[0] === 'add' ? ['json'] : [],
    import: ['manifest', 'update'],
    lock: [],
    sync: ['lock', 'out', 'force'],
    gc: ['dry-run'],
    doctor: [],
    backup: ['out'],
    restore: ['from', 'into'],
    storage: ['backup'],
  };
  for (const key of Object.keys(v))
    if (key !== 'help' && !(allowed[command] ?? []).includes(key))
      throw new Error(`このコマンドでは --${key} を使えません`);
  const value = (key: string, fallback = '') =>
    typeof v[key] === 'string' ? (v[key] as string) : fallback;
  const required = (key: string) => {
    const result = value(key);
    if (!result) throw new Error('--' + key + ' が必要です');
    return result;
  };
  const count = (min: number, max = min) => {
    if (args.length < min || args.length > max)
      throw new Error('引数の数が違います。helpで確認してください');
  };
  let result: unknown;
  if (command === 'help' || v.help) result = help;
  else if (command === 'schema') {
    count(1);
    const schemas = {
      asset: assetSchema,
      edit: editSchema,
      behavior: behaviorSchema,
      import: importManifestSchema,
      note: noteInput,
    };
    if (!(args[0] in schemas)) throw new Error('不明なスキーマ');
    result = z.toJSONSchema(schemas[args[0] as keyof typeof schemas]);
  } else if (command === 'search') {
    const q = args.join(' ').toLowerCase();
    result = (await listAssets()).filter(
      (a) =>
        [a.id, a.name, a.description, ...a.tags, ...a.collections]
          .join(' ')
          .toLowerCase()
          .includes(q) &&
        (!v.tag || a.tags.includes(value('tag'))) &&
        (!v.collection || a.collections.includes(value('collection'))) &&
        (!v.category || a.category === v.category) &&
        (!v.kind || (a.kind ?? 'model') === v.kind),
    );
  } else if (command === 'get') {
    count(1);
    result = v.revision ? await getRevision(args[0], value('revision')) : await getAsset(args[0]);
  } else if (command === 'inspect') {
    count(1);
    result = await inspectAsset(args[0], value('revision') || undefined);
  } else if (command === 'revisions') {
    count(1);
    await getAsset(args[0]);
    result = await Promise.all(
      (await directoryEntries(path.join(root, 'catalog/revisions', args[0])))
        .filter((f) => f.name.endsWith('.json'))
        .map((f) => getRevision(args[0], f.name.slice(0, -5))),
    );
  } else if (command === 'add' || command === 'replace') {
    count(command === 'add' ? 1 : 2);
    const file = path.resolve(args[command === 'add' ? 0 : 1]),
      id = command === 'add' ? required('id') : args[0];
    const metadata = v.metadata ? await jsonInput(value('metadata')) : {};
    result = await importGlb(
      await readFile(file),
      file,
      {
        ...metadata,
        id,
        ...Object.fromEntries(
          ['name', 'description', 'license', 'category', 'kind']
            .filter((k) => v[k] !== undefined)
            .map((k) => [k, v[k]]),
        ),
        ...(v.collection ? { collections: [v.collection] } : {}),
        ...(v.tag ? { tags: [v.tag] } : {}),
      },
      command === 'replace' ? required('if-match') : undefined,
    );
  } else if (command === 'update') {
    count(1);
    result = await editAsset(args[0], await jsonInput(required('json')), required('if-match'));
  } else if (command === 'tag' || command === 'collection') {
    count(3, Infinity);
    if (!['add', 'remove'].includes(args[0]))
      throw new Error('add または remove を指定してください');
    result = await changeMembership(
      args[1],
      command === 'tag' ? 'tags' : 'collections',
      args[0] === 'add' ? args.slice(2) : [],
      args[0] === 'remove' ? args.slice(2) : [],
      value('if-match') || undefined,
    );
  } else if (command === 'behavior') {
    count(2);
    if (args[0] === 'get') {
      const a = await getAsset(args[1]);
      result = a.behavior ? { hash: a.behavior, data: await getBehavior(a.behavior) } : null;
    } else if (args[0] === 'set')
      result = await setBehavior(args[1], await jsonInput(required('json')), required('if-match'));
    else if (args[0] === 'clear') result = await clearBehavior(args[1], required('if-match'));
    else throw new Error('get、set、clear を指定してください');
  } else if (command === 'note') {
    count(['resolve', 'reopen'].includes(args[0]) ? 3 : 2);
    if (args[0] === 'list') {
      await getAsset(args[1]);
      result = await getNotes(args[1]);
    } else if (args[0] === 'add')
      result = await addNote(args[1], await jsonInput(required('json')));
    else if (['resolve', 'reopen'].includes(args[0]) && args[2])
      result = await resolveNote(args[1], args[2], args[0] === 'resolve');
    else throw new Error('note の引数が違います');
  } else if (command === 'import') {
    count(0);
    const manifestPath = path.resolve(required('manifest'));
    const manifest = importManifestSchema.parse(await jsonInput(manifestPath));
    const results = [];
    for (const { file, ...metadata } of manifest.assets) {
      try {
        let expected: string | undefined;
        if (v.update) {
          try {
            expected = (await getAsset(metadata.id)).updatedAt;
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
          }
        }
        const remote = metadata.download;
        const bytes = remote
          ? await ghFile(remote.repository, remote.commit, remote.path)
          : await readFile(path.resolve(path.dirname(manifestPath), file));
        results.push({ id: metadata.id, asset: await importGlb(bytes, file, metadata, expected) });
      } catch (e) {
        results.push({ id: metadata.id, error: (e as Error).message });
        process.exitCode = 1;
      }
    }
    result = { results };
  } else if (command === 'lock') {
    count(1, Infinity);
    result = await createLock(args);
  } else if (command === 'sync') {
    count(0);
    result = await syncLock(await jsonInput(required('lock')), required('out'), !!v.force);
  } else if (command === 'doctor') {
    count(0);
    result = await doctor();
    if (!(result as Awaited<ReturnType<typeof doctor>>).ok) process.exitCode = 1;
  } else if (command === 'backup') {
    if (args[0] === 'verify') {
      count(2);
      const manifest = await verifyBackup(args[1]);
      result = { verified: true, files: manifest.files.length, createdAt: manifest.createdAt };
    } else {
      count(0);
      result = await backupLibrary(required('out'));
    }
  } else if (command === 'restore') {
    count(0);
    result = await restoreBackup(required('from'), required('into'));
  } else if (command === 'storage') {
    count(1);
    if (args[0] !== 'migrate') throw new Error('storage migrate を指定してください');
    result = await migrateStorage(required('backup'));
  } else if (command === 'gc') {
    count(0);
    if (!v['dry-run']) throw new Error('gc は --dry-run のみ対応しています');
    const report = await inspectStorage();
    result = report;
    if (!report.complete || report.missing.length) process.exitCode = 1;
  } else throw new Error('不明なコマンド: ' + command);
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((e) => {
    console.error(
      JSON.stringify({
        error: {
          code: e.status === 409 ? 'CONFLICT' : (e.code ?? 'INVALID_OPERATION'),
          message: e.message,
        },
      }),
    );
    process.exitCode = 1;
  });
