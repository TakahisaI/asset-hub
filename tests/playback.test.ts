import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Playback, bindMotion } from '../src/playback.ts';
import { behaviorSchema } from '../src/schema.ts';
import { describeGlb, motionMap } from '../tools/glb.ts';
import { animatedGlb } from './fixtures.ts';

test('one clip at a time, deterministic seek, speed and once/loop playback', () => {
  const root = new THREE.Group(),
    wheel = new THREE.Object3D();
  wheel.name = 'Wheel';
  root.add(wheel);
  const turn = new THREE.AnimationClip('turn', 2, [
    new THREE.NumberKeyframeTrack('Wheel.position[x]', [0, 2], [0, 2]),
  ]);
  const lift = new THREE.AnimationClip('lift', 2, [
    new THREE.NumberKeyframeTrack('Wheel.position[y]', [0, 2], [0, 4]),
  ]);
  const p = new Playback(root, new Map([[1, wheel]]), [turn, lift]);
  p.select(0);
  p.seek(1);
  assert.equal(wheel.position.x, 1);
  assert.equal(wheel.position.y, 0);
  p.select(1);
  p.seek(1);
  assert.equal(wheel.position.x, 0);
  assert.equal(wheel.position.y, 2);
  p.loop = false;
  p.speed = 2;
  p.playing = true;
  p.advance(1);
  assert.equal(p.time, 2);
  assert.equal(p.playing, false);
  assert.equal(wheel.position.y, 4);
  p.loop = true;
  p.playing = true;
  p.advance(0.5);
  assert.equal(p.time, 1);
  p.select();
  assert.deepEqual(wheel.position.toArray(), [0, 0, 0]);
  p.dispose();
});
test('procedural rotations and light presets restore original state', () => {
  const root = new THREE.Group(),
    wheel = new THREE.Object3D(),
    lamp = new THREE.PointLight(0xffffff, 3);
  root.add(wheel, lamp);
  const p = new Playback(
    root,
    new Map([
      [0, wheel],
      [1, lamp],
    ]),
    [],
  );
  const b = behaviorSchema.parse({
    schema: 1,
    assetId: 'test.model',
    modelRevision: 'a'.repeat(64),
    presets: [
      {
        id: 'wind',
        name: 'wind',
        rotations: [{ node: 0, axis: [0, 0, 1], rpm: 15 }],
        lights: [{ node: 1, intensity: 20 }],
      },
    ],
  });
  p.select(undefined, b.presets[0]);
  p.seek(1);
  assert.ok(Math.abs(wheel.quaternion.z - Math.SQRT1_2) < 1e-6);
  assert.equal(lamp.intensity, 20);
  p.seek(9.9);
  p.playing = true;
  p.advance(0.2);
  assert.ok(Math.abs(p.time - 0.1) < 1e-6);
  assert.ok(Math.abs(p.rotationTime - 10.1) < 1e-6);
  const expected = new THREE.Quaternion().setFromAxisAngle(
    new THREE.Vector3(0, 0, 1),
    (10.1 * Math.PI) / 2,
  );
  assert.ok(wheel.quaternion.angleTo(expected) < 1e-6);
  const state = { time: p.time, rotationTime: p.rotationTime };
  p.seek(0);
  p.seek(state.time, state.rotationTime);
  assert.ok(wheel.quaternion.angleTo(expected) < 1e-6);
  p.select();
  assert.equal(wheel.quaternion.z, 0);
  assert.equal(lamp.intensity, 3);
  p.dispose();
});
test('shared motion checks rest pose and hierarchy, then binds to target UUIDs', () => {
  const a = describeGlb(animatedGlb(false)),
    b = describeGlb(animatedGlb(true));
  const map = motionMap(a, b, 0);
  assert.equal(map['1'], 1);
  assert.throws(() => motionMap(a, describeGlb(animatedGlb(true, 1)), 0), /基準姿勢/);
  const inactive = structuredClone(a);
  inactive.nodes[1].active = false;
  assert.throws(() => motionMap(inactive, b, 0), /既定シーン/);
  const source = new THREE.Object3D();
  source.name = 'Wheel';
  const root = new THREE.Group(),
    target = new THREE.Object3D();
  root.add(target);
  const clip = new THREE.AnimationClip('motion', 2, [
    new THREE.VectorKeyframeTrack('Wheel.position', [0, 2], [0, 0, 0, 2, 0, 0]),
  ]);
  const bound = bindMotion(clip, new Map([[1, source]]), new Map([[1, target]]), { '1': 1 });
  const p = new Playback(root, new Map([[1, target]]), []);
  p.select(undefined, undefined, bound);
  p.seek(1);
  assert.equal(target.position.x, 1);
  p.dispose();
});
