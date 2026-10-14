import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { hashSchema } from '../src/schema.ts';
import { root, atomicJson, withLibraryLock } from '../server/store.ts';
import { fileDigest } from '../server/blobs.ts';

const backupSchema = z
  .object({
    schema: z.literal(1),
    createdAt: z.iso.datetime(),
    files: z
      .array(
        z
          .object({
            path: z
              .string()
              .refine(
                (p) =>
                  /^(catalog|\.store)\//.test(p) &&
                  !p.includes('\\') &&
                  !p.includes(':') &&
                  p.split('/').every((v) => v !== '' && v !== '.' && v !== '..'),
              ),
            bytes: z.number().int().nonnegative(),
            sha256: hashSchema,
          })
          .strict(),
      )
      .refine((files) => new Set(files.map((f) => f.path)).size === files.length),
  })
  .strict();

export async function resolvedPath(file: string): Promise<string> {
  try {
    return await realpath(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || path.dirname(file) === file)
      throw error;
    const entry = await lstat(file).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e;
    });
    if (entry) throw error;
    return path.join(await resolvedPath(path.dirname(file)), path.basename(file));
  }
}
function contains(parent: string, child: string) {
  const relative = path.relative(parent.toLowerCase(), child.toLowerCase());
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
  );
}
async function newDestination(destination: string, source: string) {
  const target = await resolvedPath(path.resolve(destination));
  const origin = await resolvedPath(source);
  if (contains(origin, target) || contains(target, origin))
    throw new Error('保存先と元ライブラリを重ねることはできません');
  // The catalog/store roots can themselves point outside the library.
  for (const dir of ['catalog', '.store']) {
    const actual = await resolvedPath(path.join(source, dir));
    if (contains(actual, target) || contains(target, actual))
      throw new Error('保存先と元ライブラリを重ねることはできません');
  }
  try {
    await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return target;
    throw error;
  }
  throw new Error('保存先は未作成のディレクトリを指定してください: ' + target);
}
export async function libraryInventory(
  base: string,
  links: boolean,
  directories = ['catalog', '.store'],
) {
  const files: { path: string; bytes: number; stamp: string }[] = [];
  async function walk(relative: string, ancestors: Set<string>) {
    const file = path.join(base, relative),
      entry = await lstat(file);
    if (!links && entry.isSymbolicLink())
      throw new Error('バックアップ内のリンクは許可されていません: ' + relative);
    const info = await stat(file, { bigint: true });
    if (info.isDirectory()) {
      const physical = await realpath(file);
      if (ancestors.has(physical)) throw new Error('循環リンクがあります: ' + relative);
      const visited = new Set([...ancestors, physical]);
      for (const name of (await readdir(file)).sort()) await walk(relative + '/' + name, visited);
    } else if (info.isFile())
      files.push({
        path: relative,
        bytes: Number(info.size),
        stamp: [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':'),
      });
    else throw new Error('通常ファイルではありません: ' + relative);
  }
  for (const dir of directories) {
    try {
      await lstat(path.join(base, dir));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    await walk(dir, new Set());
  }
  return files;
}
export async function verifyBackup(from: string) {
  const base = path.resolve(from);
  const manifest = backupSchema.parse(
    JSON.parse(await readFile(path.join(base, 'manifest.json'), 'utf8')),
  );
  const found = await libraryInventory(base, false);
  if (
    found.length !== manifest.files.length ||
    found.some((f, i) => f.path !== manifest.files[i].path || f.bytes !== manifest.files[i].bytes)
  )
    throw new Error('バックアップのファイル一覧・サイズが一致しません');
  for (const file of manifest.files)
    if ((await fileDigest(path.join(base, file.path))) !== file.sha256)
      throw new Error('バックアップのSHA-256が一致しません: ' + file.path);
  return manifest;
}
export async function backupLibrary(out: string) {
  return withLibraryLock(async () => {
    const target = await newDestination(out, root);
    await mkdir(path.dirname(target), { recursive: true });
    const staging = await mkdtemp(path.join(path.dirname(target), '.asset-hub-backup-'));
    try {
      const before = await libraryInventory(root, true),
        files = [];
      for (const file of before) {
        const destination = path.join(staging, file.path);
        await mkdir(path.dirname(destination), { recursive: true });
        await copyFile(path.join(root, file.path), destination);
        files.push({ path: file.path, bytes: file.bytes, sha256: await fileDigest(destination) });
      }
      if (JSON.stringify(before) !== JSON.stringify(await libraryInventory(root, true)))
        throw new Error('バックアップ中に外部からライブラリが変更されました');
      const manifest = backupSchema.parse({
        schema: 1,
        createdAt: new Date().toISOString(),
        files,
      });
      await atomicJson(path.join(staging, 'manifest.json'), manifest);
      await verifyBackup(staging);
      await newDestination(target, root);
      await rename(staging, target);
      const result = {
        path: target,
        createdAt: manifest.createdAt,
        files: files.length,
        bytes: files.reduce((sum, f) => sum + f.bytes, 0),
      };
      await atomicJson(path.join(root, '.cache/last-backup.json'), result);
      return result;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  });
}
export async function restoreBackup(from: string, into: string) {
  const source = path.resolve(from),
    target = await newDestination(into, source);
  const manifest = await verifyBackup(source);
  await mkdir(path.dirname(target), { recursive: true });
  const staging = await mkdtemp(path.join(path.dirname(target), '.asset-hub-restore-'));
  try {
    for (const file of manifest.files) {
      const destination = path.join(staging, file.path);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(path.join(source, file.path), destination);
      if ((await fileDigest(destination)) !== file.sha256)
        throw new Error('復元ファイルのSHA-256が一致しません: ' + file.path);
    }
    await newDestination(target, source);
    await rename(staging, target);
    return {
      path: target,
      files: manifest.files.length,
      bytes: manifest.files.reduce((sum, f) => sum + f.bytes, 0),
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
