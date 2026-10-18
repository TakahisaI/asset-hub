import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ComparisonProfiles, compareUrl, type ComparedRevision } from '../src/compare.tsx';
import { fixtureAsset, triangleGlb } from './fixtures.ts';
import { profileGlb } from '../tools/profile.ts';
import { readComparisonSettings } from '../src/comparison-settings.ts';

const asset = await fixtureAsset();
const left: ComparedRevision = { ...asset, available: true, profile: profileGlb(triangleGlb()) };
test('fixed comparison URLs pin both IDs and full revisions', () => {
  const right = { id: 'test.other', revision: 'b'.repeat(64) };
  const params = new URLSearchParams(compareUrl(left, right));
  assert.equal(params.get('left'), left.id);
  assert.equal(params.get('leftRevision'), left.revision);
  assert.equal(params.get('right'), right.id);
  assert.equal(params.get('rightRevision'), right.revision);
});
test('comparison preserves measured zero and small byte differences', () => {
  const right = structuredClone(left);
  right.profile!.geometry.vertexBytes += 4;
  const html = renderToStaticMarkup(createElement(ComparisonProfiles, { left, right }));
  assert.match(html, />0 B</);
  assert.match(html, />\+4 B</);
  assert.doesNotMatch(html, /未計測/);
});
test('missing and incompatible measurements never produce a comparable difference', () => {
  const missing = renderToStaticMarkup(
    createElement(ComparisonProfiles, { left, right: { ...left, profile: null } }),
  );
  assert.match(missing, /未計測/);
  assert.match(missing, /<td>—<\/td>/);
  const right = structuredClone(left);
  Object.assign(right.profile!, { tool: 'render-profile/0' });
  const incompatible = renderToStaticMarkup(createElement(ComparisonProfiles, { left, right }));
  assert.match(incompatible, /計測方法の版が異なるため比較できません/);
  assert.match(incompatible, /<td>—<\/td>/);
});

test('saved comparison settings validate the entire document and reject invalid cameras', () => {
  const settings = {
    schema: 1,
    left: { id: 'test.left', revision: 'a'.repeat(64) },
    right: { id: 'test.right', revision: 'b'.repeat(64) },
    displayed: 'B',
    pose: 'rest',
    mode: 'normal',
    lighting: 'dark',
    grid: false,
    camera: {
      position: [1, 2, 3],
      target: [0, 0, 0],
      up: [0, 1, 0],
      fov: 38,
      near: 0.01,
      far: 100,
      aspect: 4 / 3,
    },
    viewport: { width: 400, height: 300, pixelRatio: 1, bufferWidth: 400, bufferHeight: 300 },
    background: '#202b35',
    embeddedLights: false,
    three: '186',
    outputColorSpace: 'srgb',
    toneMapping: 4,
    exposure: 1.2,
    profiles: [null, null],
  };
  assert.deepEqual(readComparisonSettings(JSON.stringify(settings)), settings);
  for (const sign of [1, -1]) {
    const pole = {
      ...settings,
      camera: { ...settings.camera, position: [0, sign * Math.cos(1e-6), Math.sin(1e-6)] },
    };
    assert.deepEqual(readComparisonSettings(JSON.stringify(pole)), pole);
  }
  assert.throws(() => readComparisonSettings('{'), /JSON/);
  assert.throws(() => readComparisonSettings(JSON.stringify({ ...settings, schema: 2 })), /schema/);
  for (const camera of [
    { ...settings.camera, position: [0, 0, 0] },
    { ...settings.camera, up: [0, 0, 0] },
    { ...settings.camera, up: [1, 2, 3] },
    { ...settings.camera, near: 200 },
    { ...settings.camera, far: -1 },
    { ...settings.camera, fov: 180 },
    { ...settings.camera, position: [Infinity, 2, 3] },
  ])
    assert.throws(() => readComparisonSettings(JSON.stringify({ ...settings, camera })), /camera/);
  assert.throws(
    () => readComparisonSettings(JSON.stringify(settings).replace('"near":0.01', '"near":1e999')),
    /camera/,
  );
});
