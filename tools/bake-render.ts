import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createServer } from 'vite';
import { root } from '../server/store.ts';
import { browser } from './browser.ts';
import type { BakeRecipe } from '../src/bake-schema.ts';
import type { Behavior } from '../src/schema.ts';

export async function compareBake(
  source: Uint8Array,
  output: Uint8Array,
  recipe: BakeRecipe,
  behavior?: Behavior,
  motions: Record<string, Uint8Array> = {},
) {
  const app = express();
  app.get('/__bake/source.glb', (_req, res) =>
    res.type('model/gltf-binary').send(Buffer.from(source)),
  );
  app.get('/__bake/output.glb', (_req, res) =>
    res.type('model/gltf-binary').send(Buffer.from(output)),
  );
  app.get('/api/files/:hash', (req, res) => {
    const bytes = motions[req.params.hash];
    if (!bytes) return res.sendStatus(404);
    res.type('model/gltf-binary').send(Buffer.from(bytes));
  });
  const vite = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    cacheDir: path.join(root, '.cache/bake-vite'),
    logLevel: 'silent',
    server: { middlewareMode: true },
    appType: 'spa',
  });
  app.use(vite.middlewares);
  const server = app.listen(0, '127.0.0.1');
  let b: Awaited<ReturnType<typeof browser>> | undefined;
  try {
    await once(server, 'listening');
    b = await browser();
    const page = await b.newPage({ viewport: { width: 768, height: 288 }, deviceScaleFactor: 1 });
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.addInitScript('window.__name = (fn) => fn');
    const address = server.address() as { port: number };
    await page.goto(`http://127.0.0.1:${address.port}/tools/blank.html`);
    const result = await page.evaluate(
      async ({ behavior, checks }) => {
        const url = '/src/viewer.ts';
        const { AssetViewer } = await import(/* @vite-ignore */ url);
        document.body.style.cssText = 'margin:0;display:flex';
        const viewers = [];
        for (const path of ['source', 'output']) {
          const host = document.createElement('div');
          host.style.cssText = 'width:384px;height:288px';
          document.body.append(host);
          const v = new AssetViewer(host);
          await v.load(`/__bake/${path}.glb`);
          cancelAnimationFrame(v.frame);
          v.controls.enableDamping = false;
          v.renderer.setPixelRatio(1);
          v.renderer.setSize(384, 288);
          v.camera.aspect = 384 / 288;
          if (v.grid) v.grid.visible = false;
          if (v.axes) v.axes.visible = false;
          if (v.box) v.box.visible = false;
          viewers.push(v);
        }
        const [a, b] = viewers;
        type Pose = { clip?: number; preset?: number; time: number };
        const poses: Pose[] = [{ time: 0 }];
        a.clips.forEach((clip: { tracks: { times: ArrayLike<number> }[] }, index: number) => {
          const times = [...new Set<number>(clip.tracks.flatMap((t) => Array.from(t.times)))].sort(
            (x, y) => x - y,
          );
          for (const [i, time] of times.entries()) {
            poses.push({ clip: index, time });
            if (i) poses.push({ clip: index, time: (times[i - 1] + time) / 2 });
          }
        });
        for (const [index, preset] of (behavior?.presets ?? []).entries()) {
          await a.selectPreset(preset);
          const duration = a.playback.duration;
          const clip = a.playback.action?.getClip();
          const times = [
            ...new Set<number>([
              0,
              duration / 2,
              duration,
              ...(clip?.tracks.flatMap((t: { times: ArrayLike<number> }) => Array.from(t.times)) ??
                []),
            ]),
          ].sort((x, y) => x - y);
          for (const [i, time] of times.entries()) {
            poses.push({ preset: index, time });
            if (i) poses.push({ preset: index, time: (times[i - 1] + time) / 2 });
          }
        }
        const images: { name: string; data: string }[] = [];
        const samples: {
          pose: number;
          mode: string;
          view: number;
          maxError: number;
          changedRatio: number;
        }[] = [];
        const directions = [
          [0, 0.1, 1],
          [0, 0.1, -1],
          [1, 0.1, 0],
          [-1, 0.1, 0],
          [0.001, 1, 0],
          [0.001, -1, 0],
          [1, 0.72, 1.25],
          [-1, 0.72, -1.25],
        ];
        const pixels = (v: any) => {
          v.renderer.render(v.scene, v.camera);
          const gl = v.renderer.getContext();
          const data = new Uint8Array(384 * 288 * 4);
          gl.readPixels(0, 0, 384, 288, gl.RGBA, gl.UNSIGNED_BYTE, data);
          return data;
        };
        try {
          for (const [poseIndex, pose] of poses.entries()) {
            for (const v of viewers) {
              if (pose.preset !== undefined) await v.selectPreset(behavior!.presets[pose.preset]);
              else if (pose.clip !== undefined) await v.selectPreset(undefined, pose.clip);
              else v.playback?.reset();
              v.playback?.seek(pose.time, pose.time);
              v.model.updateMatrixWorld(true);
            }
            a.fit();
            const center = a.controls.target.clone();
            const distance = a.camera.position.distanceTo(center);
            const near = Math.max(...a.size.toArray(), 0.1) / 200;
            for (const mode of ['pbr', 'normal', 'wireframe'])
              for (const [view, d] of directions.entries()) {
                for (const v of viewers) {
                  v.mode(mode);
                  v.camera.position.copy(center).addScaledVector(
                    center
                      .clone()
                      .set(...d)
                      .normalize(),
                    distance,
                  );
                  v.controls.target.copy(center);
                  v.camera.near = near;
                  v.camera.far = a.camera.far;
                  v.camera.updateProjectionMatrix();
                  v.controls.update();
                }
                const pa = pixels(a),
                  pb = pixels(b);
                let maxError = 0,
                  changed = 0;
                for (let i = 0; i < pa.length; i += 4) {
                  let error = 0;
                  for (let c = 0; c < 3; c++)
                    error = Math.max(error, Math.abs(pa[i + c] - pb[i + c]));
                  maxError = Math.max(maxError, error);
                  if (error) changed++;
                }
                const changedRatio = changed / (pa.length / 4);
                const sample = { pose: poseIndex, mode, view, maxError, changedRatio };
                samples.push(sample);
                for (const [i, v] of viewers.entries())
                  images.push({
                    name: `${poseIndex}-${mode}-${view}-${i === 0 ? 'source' : 'output'}.png`,
                    data: v.capture().split(',')[1],
                  });
                if (
                  maxError > checks.imageMaxChannelError ||
                  changedRatio > Number(checks.imageMaxChangedPixelRatio)
                )
                  return {
                    width: 384,
                    height: 288,
                    near: 'span/200',
                    poses,
                    samples,
                    images,
                    failure: sample,
                  };
              }
          }
        } finally {
          viewers.forEach((v) => v.dispose());
        }
        return { width: 384, height: 288, near: 'span/200', poses, samples, images };
      },
      { behavior, checks: recipe.checks },
    );
    assert.deepEqual(pageErrors, [], 'レンダー中のブラウザエラー');
    return { ...result, browser: b.version() };
  } finally {
    await b?.close();
    await vite.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
