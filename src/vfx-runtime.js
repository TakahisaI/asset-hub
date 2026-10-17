import * as THREE from 'three';
import { ImprovedNoise } from 'three/addons/math/ImprovedNoise.js';

/** @typedef {{material:number, color:[number,number,number], noiseScale:number, threshold:number, density:number[]}} Smoke */
/** @typedef {{material:number, color:[number,number,number], strength:number[]}} Emission */
/** @typedef {{schema:1, clip:number, posterTime:number, times:number[], smoke:Smoke[], emission:Emission[]}} Vfx */
const applied = new WeakSet();

// shortcut: smoke uses a noise volume without scene lighting or shadows; use an engine-specific volume renderer for physical matching.
function smokeTexture() {
  const size = 48;
  const data = new Uint8Array(size ** 3);
  const noise = new ImprovedNoise();
  for (let z = 0; z < size; z++)
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++)
        data[x + size * (y + size * z)] = Math.round(
          255 * (0.5 + 0.5 * noise.noise(x / 6, y / 6, z / 6)),
        );
  const texture = new THREE.Data3DTexture(data, size, size, size);
  texture.format = THREE.RedFormat;
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.wrapS = texture.wrapT = texture.wrapR = THREE.RepeatWrapping;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

/** @param {Smoke} spec @param {THREE.Data3DTexture} texture */
function smokeMaterial(spec, texture) {
  const material = new THREE.ShaderMaterial({
    name: 'Asset Hub smoke',
    glslVersion: THREE.GLSL3,
    transparent: true,
    depthWrite: false,
    side: THREE.BackSide,
    uniforms: {
      noiseMap: { value: texture },
      smokeColor: { value: new THREE.Color().fromArray(spec.color) },
      density: { value: spec.density[0] },
      noiseScale: { value: spec.noiseScale },
      threshold: { value: spec.threshold },
    },
    vertexShader: `
      varying vec3 origin;
      varying vec3 direction;
      varying float worldScale;
      void main() {
        origin = (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz;
        direction = position - origin;
        worldScale = pow(length(modelMatrix[0].xyz) * length(modelMatrix[1].xyz) * length(modelMatrix[2].xyz), 1.0 / 3.0);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      precision highp sampler3D;
      out vec4 fragmentColor;
      #define gl_FragColor fragmentColor
      uniform sampler3D noiseMap;
      uniform vec3 smokeColor;
      uniform float density;
      uniform float noiseScale;
      uniform float threshold;
      varying vec3 origin;
      varying vec3 direction;
      varying float worldScale;
      void main() {
        vec3 ray = normalize(direction);
        float b = dot(origin, ray);
        float d = b * b - dot(origin, origin) + 1.0;
        if (d <= 0.0 || density <= 0.0) discard;
        float start = max(0.0, -b - sqrt(d));
        float end = -b + sqrt(d);
        if (end <= start) discard;
        float stepSize = (end - start) / 32.0;
        float alpha = 0.0;
        for (int i = 0; i < 32; i++) {
          vec3 p = origin + ray * (start + (float(i) + 0.5) * stepSize);
          float n = texture(noiseMap, (p + 1.0) * noiseScale / 16.0).r;
          float radial = max(0.0, 1.0 - dot(p, p));
          float amount = max(0.0, n - threshold) * radial;
          float opacity = 1.0 - exp(-amount * density * stepSize * worldScale);
          alpha += (1.0 - alpha) * opacity;
        }
        if (alpha < 0.001) discard;
        gl_FragColor = vec4(smokeColor, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  // AnimationMixer can bind Material.opacity; the shader treats it as density.
  material.opacity = spec.density[0];
  material.onBeforeRender = () => {
    material.uniforms.density.value = material.opacity;
  };
  return material;
}

/** Add Asset Hub's recorded material tracks to the existing GLB clip. Call once after GLTFLoader.loadAsync.
 * @param {import('three/addons/loaders/GLTFLoader.js').GLTF} gltf
 */
export function applyVfx(gltf) {
  /** @type {Vfx | undefined} */
  const data = gltf.parser.json.extras?.assetHubVfx;
  if (!data) return;
  if (data.schema !== 1 || !gltf.animations[data.clip])
    throw new Error('対応していないVFXデータです');
  if (applied.has(gltf)) return data;
  /** @type {Map<number, {mesh: THREE.Mesh, slot: number, material: THREE.Material}[]>} */
  const targets = new Map();
  gltf.scene.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    (Array.isArray(object.material) ? object.material : [object.material]).forEach(
      (material, slot) => {
        const index = gltf.parser.associations.get(material)?.materials;
        if (index === undefined) return;
        if (!targets.has(index)) targets.set(index, []);
        targets.get(index)?.push({ mesh: object, slot, material });
      },
    );
  });
  for (const spec of [...data.smoke, ...data.emission])
    if (!targets.get(spec.material)?.length) throw new Error('VFXの対象材質がありません');
  const clip = gltf.animations[data.clip].clone();
  const texture = data.smoke.length ? smokeTexture() : null;
  let users = data.smoke.length;
  for (const spec of [...data.smoke, ...data.emission]) {
    const slots = targets.get(spec.material);
    if (!slots) continue;
    const smoke = 'density' in spec;
    const replacement = smoke && texture ? smokeMaterial(spec, texture) : null;
    if (replacement)
      replacement.addEventListener('dispose', () => {
        if (--users === 0) texture?.dispose();
      });
    const animated = new Set();
    for (const { mesh, slot, material } of slots) {
      const target = replacement ?? material;
      if (replacement) {
        if (Array.isArray(mesh.material)) mesh.material[slot] = replacement;
        else mesh.material = replacement;
      } else if (target instanceof THREE.MeshStandardMaterial) {
        target.emissive.fromArray(spec.color);
        if ('strength' in spec) target.emissiveIntensity = spec.strength[0];
      } else throw new Error('発光材質を再生できません');
      if (animated.has(target)) continue;
      animated.add(target);
      const path = `${mesh.uuid}.material${Array.isArray(mesh.material) ? '[' + slot + ']' : ''}.${smoke ? 'opacity' : 'emissiveIntensity'}`;
      clip.tracks.push(
        new THREE.NumberKeyframeTrack(path, data.times, smoke ? spec.density : spec.strength),
      );
    }
    if (replacement)
      for (const material of new Set(slots.map((s) => s.material))) material.dispose();
  }
  gltf.animations[data.clip] = clip;
  applied.add(gltf);
  return data;
}
