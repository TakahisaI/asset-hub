import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { applyVfx } from '../src/vfx-runtime.js';
import { vfxSchema } from '../src/vfx-schema.ts';
import { Playback } from '../src/playback.ts';

function fixture() {
  const material = new THREE.MeshStandardMaterial();
  const glow = new THREE.MeshStandardMaterial();
  const first = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 8), material);
  const second = new THREE.Mesh(first.geometry, [material, glow]);
  const scene = new THREE.Group();
  scene.add(first, second);
  const data = vfxSchema.parse({
    schema: 1,
    clip: 0,
    posterTime: 1,
    runtime: 'a'.repeat(64),
    source: { name: 'source.blend', hash: 'b'.repeat(64) },
    limitations: 'Approximate smoke',
    times: [0, 1, 2],
    smoke: [
      { material: 0, color: [0.3, 0.3, 0.3], noiseScale: 5, threshold: 0.35, density: [0, 4, 0] },
    ],
    emission: [{ material: 1, color: [0.2, 0.5, 1], strength: [0.3, 10, 0.3] }],
  });
  const gltf = {
    scene,
    scenes: [scene],
    animations: [new THREE.AnimationClip('VFX', 2, [])],
    userData: {},
    parser: {
      json: { extras: { assetHubVfx: data } },
      associations: new Map([
        [material, { materials: 0 }],
        [glow, { materials: 1 }],
      ]),
    },
  } as unknown as GLTF;
  return { gltf, first, second, material, glow, data };
}

test('VFX follows the existing mixer, including shared materials, material arrays, seeking and resets', () => {
  const { gltf, first, second, glow, data } = fixture();
  gltf.userData.assetHubVfxApplied = true;
  assert.equal(applyVfx(gltf), data);
  const clip = gltf.animations[0];
  applyVfx(gltf);
  assert.equal(gltf.animations[0], clip);
  assert.equal(first.material, second.material[0]);
  assert.equal(clip.tracks.length, 2);
  const playback = new Playback(gltf.scene, new Map(), gltf.animations);
  playback.select(0);
  playback.seek(1);
  assert.equal(first.material.opacity, 4);
  assert.equal(glow.emissiveIntensity, 10);
  playback.seek(0.5);
  assert.equal(first.material.opacity, 2);
  assert.ok(Math.abs(glow.emissiveIntensity - 5.15) < 0.00001);
  playback.reset();
  assert.equal(first.material.opacity, 0);
  assert.ok(Math.abs(glow.emissiveIntensity - 0.3) < 0.00001);
  const shader = first.material as unknown as THREE.ShaderMaterial;
  let disposed = 0;
  shader.uniforms.noiseMap.value.addEventListener('dispose', () => disposed++);
  shader.dispose();
  assert.equal(disposed, 1);
  playback.dispose();
  first.geometry.dispose();
  glow.dispose();
});

test('bad material targets fail before replacing any materials', () => {
  const { gltf, first, material, data } = fixture();
  data.smoke[0].material = 999;
  assert.throws(() => applyVfx(gltf), /対象材質/);
  assert.equal(first.material, material);
});

test('VFX rejects malformed timelines, duplicate material targets and unsafe filenames', () => {
  const { data } = fixture();
  for (const bad of [
    { ...data, times: [0, 1, 1] },
    { ...data, smoke: [{ ...data.smoke[0], density: [1, 2] }] },
    { ...data, emission: [{ ...data.emission[0], material: 0 }] },
    { ...data, source: { ...data.source, name: '../outside.blend' } },
  ])
    assert.equal(vfxSchema.safeParse(bad).success, false);
});
