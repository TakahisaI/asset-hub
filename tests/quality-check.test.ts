import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QualityCheck } from '../src/quality-check.tsx';
import type { Asset } from '../src/schema.ts';

test('tangent findings share one Japanese explanation while original details and totals remain', () => {
  const qa: Asset['qa'] = {
    errors: 0,
    warnings: 100,
    messages: [0, 1].map((index) => ({
      code: 'MESH_PRIMITIVE_GENERATED_TANGENT_SPACE',
      severity: 1,
      message: 'Runtime-generated tangent space may be non-portable across implementations.',
      pointer: `/meshes/${index}/primitives/0/material`,
    })),
  };
  const before = structuredClone(qa);
  const html = renderToStaticMarkup(createElement(QualityCheck, { qa }));
  assert.equal((html.match(/class="qa-group"/g) ?? []).length, 1);
  assert.equal((html.match(/別の表示環境で凹凸や陰影/g) ?? []).length, 1);
  assert.match(html, /100 警告/);
  assert.match(html, /記録済み2件/);
  assert.match(html, /全件ではない場合/);
  for (const message of qa.messages) {
    assert.ok(html.includes(message.message));
    assert.ok(html.includes(message.pointer!));
  }
  assert.deepEqual(qa, before);
});

test('unknown codes stay visible and different severities are never combined', () => {
  const html = renderToStaticMarkup(
    createElement(QualityCheck, {
      qa: {
        errors: 1,
        warnings: 1,
        messages: [0, 1].map((severity) => ({
          code: 'FUTURE_VALIDATOR_CODE',
          severity,
          message: '<untrusted message>',
        })),
      },
    }),
  );
  assert.equal((html.match(/class="qa-group"/g) ?? []).length, 2);
  assert.match(html, /qa-error/);
  assert.match(html, /FUTURE_VALIDATOR_CODE/);
  assert.match(html, /&lt;untrusted message&gt;/);
  assert.equal(html.includes('<untrusted message>'), false);
});

test('an empty report shows counts and the conformance limit without empty details', () => {
  const html = renderToStaticMarkup(
    createElement(QualityCheck, { qa: { errors: 0, warnings: 0, messages: [] } }),
  );
  assert.match(html, /qa-pass/);
  assert.match(html, /見た目や用途への適合/);
  assert.equal(html.includes('<details>'), false);
});
