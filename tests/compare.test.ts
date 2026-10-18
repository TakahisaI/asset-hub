import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ComparisonProfiles, compareUrl, type ComparedRevision } from '../src/compare.tsx';
import { fixtureAsset, triangleGlb } from './fixtures.ts';
import { profileGlb } from '../tools/profile.ts';

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
