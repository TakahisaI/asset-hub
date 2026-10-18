import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ProfilePanel, ProfileSummary } from '../src/render-profile.tsx';
import { profileGlb } from '../tools/profile.ts';
import { profiledGlb } from './fixtures.ts';

test('small measured bytes and zero stay distinct from an unmeasured profile', () => {
  const profile = profileGlb(profiledGlb());
  assert.match(renderToStaticMarkup(createElement(ProfileSummary, { profile })), />4 B</);
  profile.textures.decodedBytes = 0;
  const zero = renderToStaticMarkup(createElement(ProfileSummary, { profile }));
  assert.match(zero, />0 B</);
  assert.doesNotMatch(zero, /未計測/);
  assert.match(renderToStaticMarkup(createElement(ProfileSummary, { profile: null })), /未計測/);
});

test('positive and negative byte differences are visible below one kilobyte', () => {
  const current = profileGlb(profiledGlb());
  const profile = structuredClone(current);
  profile.textures.decodedBytes += 4;
  profile.geometry.vertexBytes -= 4;
  const html = renderToStaticMarkup(
    createElement(ProfilePanel, { profile, current, compare: true }),
  );
  assert.match(html, />\+4 B</);
  assert.match(html, />−4 B</);
  assert.doesNotMatch(html, /[+−]0 KB/);
});
