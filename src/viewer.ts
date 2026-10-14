import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { Playback, bindMotion } from './playback.ts';
import type { Behavior, Preset, ReviewNote } from './schema.ts';
function modelLoader() {
  return new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).register((parser) => ({
    name: 'AssetHubNodeIndices',
    async loadNode(index) {
      const node = await parser.loadNode(index);
      // Keep the index when the loader prunes associations or clones nodes between scenes.
      node.userData.assetHubNodeIndex = index;
      return node;
    },
  }));
}
function nodeMap(gltf: GLTF) {
  const nodes = new Map<number, THREE.Object3D>();
  gltf.scene.traverse((object) => {
    const index = object.userData.assetHubNodeIndex;
    if (index !== undefined) nodes.set(index, object);
  });
  return nodes;
}
export type CameraState = { position: [number, number, number]; target: [number, number, number] };
export class AssetViewer {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(38, 1, 0.01, 10000);
  controls: OrbitControls;
  model: THREE.Group | null = null;
  box: THREE.Box3Helper | null = null;
  grid: THREE.GridHelper | null = null;
  axes: THREE.AxesHelper | null = null;
  normal = new THREE.MeshNormalMaterial();
  originals = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  animation: THREE.AnimationMixer | null = null;
  playback: Playback | null = null;
  behavior?: Behavior;
  behaviorHash?: string;
  private selection = 0;
  ground: THREE.Mesh | null = null;
  motionRig: THREE.LineSegments | null = null;
  rigNodes: THREE.Object3D[] = [];
  clips: THREE.AnimationClip[] = [];
  light = new THREE.DirectionalLight(0xffeddb, 3.2);
  fill = new THREE.HemisphereLight(0xe5efff, 0x77725d, 2.5);
  rim = new THREE.DirectionalLight(0xffffff, 1.3);
  frame = 0;
  disposed = false;
  generation = 0;
  resize: ResizeObserver;
  last = performance.now();
  size = new THREE.Vector3();
  center = new THREE.Vector3();
  constructor(public host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0xeae9e2);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;
    this.renderer.domElement.setAttribute(
      'aria-label',
      'アセットの3D表示。ドラッグで回転、ホイールで拡大',
    );
    host.append(this.renderer.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.light.position.set(5, 9, 6);
    this.scene.add(this.light, this.fill);
    this.rim.position.set(-6, 4, -6);
    this.scene.add(this.rim);
    this.resize = new ResizeObserver(() => {
      const w = host.clientWidth,
        h = host.clientHeight;
      if (w && h) {
        this.renderer.setSize(w, h);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
      }
    });
    this.resize.observe(host);
    const tick = () => {
      if (this.disposed) return;
      const now = performance.now();
      this.playback?.advance(Math.min((now - this.last) / 1000, 0.1));
      if (this.motionRig) {
        const positions = this.motionRig.geometry.getAttribute('position');
        const point = new THREE.Vector3();
        this.rigNodes.forEach((node, i) => {
          node.parent!.getWorldPosition(point);
          positions.setXYZ(i * 2, point.x, point.y, point.z);
          node.getWorldPosition(point);
          positions.setXYZ(i * 2 + 1, point.x, point.y, point.z);
        });
        positions.needsUpdate = true;
      }
      this.last = now;
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      this.frame = requestAnimationFrame(tick);
    };
    tick();
  }
  async load(url: string) {
    const gen = ++this.generation;
    this.clearModel();
    const loader = modelLoader();
    const gltf = await loader.loadAsync(url);
    if (this.disposed || gen !== this.generation) {
      this.disposeObject(gltf.scene);
      return;
    }
    this.model = gltf.scene;
    this.scene.add(this.model);
    this.model.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(this.model);
    if (bounds.isEmpty()) {
      this.model.traverse((o) => bounds.expandByPoint(o.getWorldPosition(new THREE.Vector3())));
      if (bounds.isEmpty())
        bounds.set(new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 1, 0.5));
      this.rigNodes = [...nodeMap(gltf).values()].filter(
        (n) => n.parent && n.parent !== gltf.scene,
      );
      const geometry = new THREE.BufferGeometry().setAttribute(
        'position',
        new THREE.Float32BufferAttribute(new Float32Array(this.rigNodes.length * 6), 3),
      );
      this.motionRig = new THREE.LineSegments(
        geometry,
        new THREE.LineBasicMaterial({ color: 0xad5931 }),
      );
      this.motionRig.frustumCulled = false;
      this.scene.add(this.motionRig);
    }
    bounds.getSize(this.size);
    bounds.getCenter(this.center);
    this.box = new THREE.Box3Helper(bounds, 0xbd6f38);
    this.box.visible = false;
    this.scene.add(this.box);
    const span = Math.max(...this.size.toArray(), 0.1);
    this.grid = new THREE.GridHelper(span * 2, 20, 0xbdbdaf, 0xd5d6cb);
    this.grid.position.set(this.center.x, bounds.min.y - 0.005 * span, this.center.z);
    this.scene.add(this.grid);
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(span * 3, span * 3),
      new THREE.MeshStandardMaterial({ color: 0xc8c7bf, roughness: 1, side: THREE.DoubleSide }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.copy(this.grid.position).add(new THREE.Vector3(0, -0.001 * span, 0));
    this.ground.visible = false;
    this.scene.add(this.ground);
    this.axes = new THREE.AxesHelper(span * 0.2);
    this.axes.visible = false;
    this.scene.add(this.axes);
    this.model.traverse((o) => {
      if (o instanceof THREE.Mesh) this.originals.set(o, o.material);
    });
    this.clips = gltf.animations;
    this.playback = new Playback(this.model, nodeMap(gltf), this.clips);
    this.animation = this.playback.mixer;
    this.fit();
  }
  async selectPreset(preset?: Preset, clip?: number) {
    const generation = this.generation,
      selection = ++this.selection;
    if (!this.playback) return;
    let external: THREE.AnimationClip | undefined;
    if (preset?.clip?.source) {
      const loader = modelLoader();
      const source = await loader.loadAsync('/api/files/' + preset.clip.source.revision);
      try {
        if (this.disposed || generation !== this.generation || selection !== this.selection) return;
        const animation = source.animations[preset.clip.index];
        if (!animation) throw new Error('参照モーションがありません');
        external = bindMotion(
          animation,
          nodeMap(source),
          this.playback.nodes,
          preset.clip.nodeMap ?? {},
        );
      } finally {
        this.disposeObject(source.scene);
      }
    }
    this.playback.select(preset?.clip?.index ?? clip, preset, external);
  }
  playbackState(): ReviewNote['playback'] {
    const p = this.playback;
    if (!p || (!p.preset && p.clip === undefined)) return undefined;
    return {
      ...(p.preset ? { behavior: this.behaviorHash, preset: p.preset.id } : { clip: p.clip }),
      time: p.time,
      ...(p.preset?.rotations.length ? { rotationTime: p.rotationTime } : {}),
      speed: p.speed,
      loop: p.loop,
    };
  }
  async restorePlayback(state: NonNullable<ReviewNote['playback']>) {
    if (state.preset && state.behavior !== this.behaviorHash)
      throw new Error('現在とは異なる動作設定へのメモです');
    const preset = state.preset
      ? this.behavior?.presets.find((p) => p.id === state.preset)
      : undefined;
    if (state.preset && !preset) throw new Error('動作プリセットがありません');
    await this.selectPreset(preset, state.clip);
    if (this.playback) {
      this.playback.speed = state.speed;
      this.playback.loop = state.loop;
      this.playback.seek(state.time, state.rotationTime);
    }
  }
  fitMotion() {
    if (!this.playback || !this.model) return;
    const time = this.playback.time,
      rotationTime = this.playback.rotationTime,
      bounds = new THREE.Box3();
    for (let frame = 0; frame <= 32; frame++) {
      this.playback.seek((this.playback.duration * frame) / 32);
      bounds.union(new THREE.Box3().setFromObject(this.model, true));
    }
    this.playback.seek(time, rotationTime);
    if (!bounds.isEmpty()) {
      this.fit('perspective', bounds);
    }
  }
  fit(view: 'perspective' | 'front' | 'top' | 'side' = 'perspective', bounds?: THREE.Box3) {
    if (!bounds && this.model) bounds = new THREE.Box3().setFromObject(this.model, true);
    if (bounds && !bounds.isEmpty()) {
      bounds.getSize(this.size);
      bounds.getCenter(this.center);
      const span = Math.max(...this.size.toArray(), 0.1);
      this.grid?.position.set(this.center.x, bounds.min.y - 0.005 * span, this.center.z);
      if (this.ground && this.grid)
        this.ground.position.copy(this.grid.position).add(new THREE.Vector3(0, -0.001 * span, 0));
      this.box?.box.copy(bounds);
    }
    const span = Math.max(...this.size.toArray(), 0.1),
      distance =
        ((span / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)))) * 1.35) /
        Math.min(this.camera.aspect, 1);
    const direction = new THREE.Vector3(
      ...((view === 'front'
        ? [0, 0.1, 1]
        : view === 'top'
          ? [0.001, 1, 0]
          : view === 'side'
            ? [1, 0.1, 0]
            : [1, 0.72, 1.25]) as [number, number, number]),
    ).normalize();
    this.controls.target.copy(this.center);
    this.camera.position.copy(this.center).addScaledVector(direction, distance);
    this.camera.near = span / 10000;
    this.camera.far = span * 100;
    this.controls.minDistance = span * 0.015;
    this.controls.maxDistance = span * 20;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }
  mode(mode: string) {
    for (const [mesh, material] of this.originals) {
      mesh.material = mode === 'normal' ? this.normal : material;
      for (const mat of Array.isArray(material) ? material : [material])
        if ('wireframe' in mat)
          (mat as THREE.MeshStandardMaterial).wireframe = mode === 'wireframe';
    }
  }
  lighting(mode: string) {
    this.rim.intensity = mode === 'night' ? 0.05 : 1.3;
    this.fill.intensity = mode === 'night' ? 0.65 : mode === 'flat' ? 3.7 : 2.5;
    this.light.intensity = mode === 'night' ? 0.7 : mode === 'flat' ? 1 : 3.2;
    this.renderer.setClearColor(mode === 'night' ? 0x202b35 : 0xeae9e2);
  }
  cameraState(): CameraState {
    return { position: this.camera.position.toArray(), target: this.controls.target.toArray() };
  }
  restore(state: CameraState) {
    this.camera.position.fromArray(state.position);
    this.controls.target.fromArray(state.target);
    this.controls.update();
  }
  capture() {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }
  disposeObject(object: THREE.Object3D) {
    const materials = new Set<THREE.Material>(),
      textures = new Set<THREE.Texture>(),
      geometries = new Set<THREE.BufferGeometry>();
    object.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Line || o instanceof THREE.Points) {
        geometries.add(o.geometry);
        for (const m of Array.isArray(o.material) ? o.material : [o.material])
          if (m !== this.normal) {
            materials.add(m);
            for (const v of Object.values(m)) if (v instanceof THREE.Texture) textures.add(v);
          }
      }
    });
    geometries.forEach((g) => g.dispose());
    materials.forEach((m) => m.dispose());
    textures.forEach((t) => {
      t.dispose();
      if (t.source.data instanceof ImageBitmap) t.source.data.close();
    });
  }
  clearModel() {
    ++this.selection;
    this.playback?.dispose();
    this.playback = null;
    this.clips = [];
    this.behavior = undefined;
    this.behaviorHash = undefined;
    this.animation?.stopAllAction();
    this.animation = null;
    if (this.model) {
      for (const [m, mat] of this.originals) m.material = mat;
      this.disposeObject(this.model);
      this.model.removeFromParent();
      this.model = null;
    }
    this.originals.clear();
    if (this.ground) {
      this.ground.removeFromParent();
      this.ground.geometry.dispose();
      (this.ground.material as THREE.Material).dispose();
      this.ground = null;
    }
    if (this.motionRig) {
      this.motionRig.removeFromParent();
      this.motionRig.geometry.dispose();
      (this.motionRig.material as THREE.Material).dispose();
      this.motionRig = null;
    }
    this.rigNodes = [];
    for (const helper of [this.box, this.grid, this.axes])
      if (helper) {
        helper.removeFromParent();
        helper.dispose();
      }
    this.box = null;
    this.grid = null;
    this.axes = null;
  }
  dispose() {
    this.disposed = true;
    ++this.generation;
    cancelAnimationFrame(this.frame);
    this.resize.disconnect();
    this.controls.dispose();
    this.clearModel();
    this.normal.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
