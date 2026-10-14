import { realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanAssets, digest, root, atomicJson } from '../server/store.ts';
import { readBlob } from '../server/blobs.ts';
import { inspectGlb } from './inspect.ts';
import { getBehavior, inspectAsset } from '../server/operations.ts';
// Validation is observational. Import metadata and pinned snapshots are never rewritten.
export async function validateAssets() {
  const { assets, problems } = await scanAssets();
  const results: {
    id: string;
    revision: string;
    inspection?: Awaited<ReturnType<typeof inspectGlb>>;
    problem?: string;
  }[] = [];
  for (const asset of assets) {
    try {
      const bytes = await readBlob(asset.file.hash);
      if (digest(bytes) !== asset.file.hash) throw new Error('SHA-256が一致しません');
      if (asset.behavior) {
        const behavior = await getBehavior(asset.behavior);
        if (behavior.assetId !== asset.id || behavior.modelRevision !== asset.revision)
          throw new Error('動作設定が現在のGLB版と一致しません');
        for (const preset of behavior.presets)
          if (preset.clip?.source)
            await inspectAsset(preset.clip.source.id, preset.clip.source.revision);
      }
      results.push({ id: asset.id, revision: asset.revision, inspection: await inspectGlb(bytes) });
    } catch (error) {
      results.push({
        id: asset.id,
        revision: asset.revision,
        problem:
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? 'GLBが見つかりません'
            : (error as Error).message,
      });
    }
  }
  return {
    schema: 1,
    checkedAt: new Date().toISOString(),
    scope: 'current-assets',
    summary: {
      assets: assets.length,
      failed: results.filter((r) => r.problem || r.inspection?.qa.errors).length + problems.length,
      errors: results.reduce((sum, r) => sum + (r.inspection?.qa.errors ?? 0), 0),
      warnings: results.reduce((sum, r) => sum + (r.inspection?.qa.warnings ?? 0), 0),
    },
    problems,
    results,
  };
}

async function resolveReportPath(file: string): Promise<string> {
  try {
    return await realpath(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || path.dirname(file) === file)
      throw error;
    const entry = await lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    if (entry) throw error; // A dangling symlink must not be treated as a new path.
    return path.join(await resolveReportPath(path.dirname(file)), path.basename(file));
  }
}

async function main() {
  const args = process.argv.slice(2);
  let report: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') json = true;
    else if (args[i] === '--report' && args[i + 1] && !args[i + 1].startsWith('--'))
      report = path.resolve(args[++i]);
    else throw new Error('使い方: validate:assets [--json] [--report .cache/validation.json]');
  }
  const result = await validateAssets();
  if (report) {
    const destination = path.join(
      await resolveReportPath(path.dirname(report)),
      path.basename(report),
    );
    const resolved = await resolveReportPath(report);
    for (const dir of ['catalog', '.store']) {
      for (const protectedDir of [
        path.join(root, dir),
        await resolveReportPath(path.join(root, dir)),
      ]) {
        for (const target of [report, destination, resolved]) {
          const relative = path.relative(protectedDir.toLowerCase(), target.toLowerCase());
          if (
            !relative ||
            (!relative.startsWith('..' + path.sep) &&
              relative !== '..' &&
              !path.isAbsolute(relative))
          )
            throw new Error('検証レポートは catalog/ と .store/ の外に保存してください');
        }
      }
    }
    await atomicJson(destination, result);
  }
  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    for (const problem of result.problems) console.error(`${problem.file}: ${problem.message}`);
    for (const item of result.results) {
      if (item.problem) console.error(`${item.id}: ${item.problem}`);
      else if (item.inspection!.qa.errors || item.inspection!.qa.warnings)
        console.log(
          `${item.id}: ${item.inspection!.qa.errors} errors, ${item.inspection!.qa.warnings} warnings`,
        );
    }
    console.log(
      `GLB検証: ${result.summary.assets} assets, ${result.summary.failed} failed, ${result.summary.errors} errors, ${result.summary.warnings} warnings（台帳は変更しません）`,
    );
    if (report) console.log('レポート: ' + report);
  }
  if (result.summary.failed) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
