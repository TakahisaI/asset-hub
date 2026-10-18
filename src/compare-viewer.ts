import { Color, Light, Mesh, REVISION, type Group } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { AssetViewer } from './viewer.ts';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { ComparisonSettings } from './comparison-settings.ts';

// Both models share one camera and drawing buffer; switching never fits or moves either model.
export class CompareViewer extends AssetViewer {
  other: Group | null = null;
  private savedAspect?: number;
  onResize?: () => void;
  constructor(host: HTMLElement) {
    super(host);
    this.resize.disconnect();
    this.resize = new ResizeObserver(() => {
      const width = host.clientWidth,
        height = host.clientHeight;
      if (!width || !height) return;
      this.renderer.setSize(width, height);
      this.camera.aspect = this.savedAspect ?? width / height;
      this.camera.updateProjectionMatrix();
      this.onResize?.();
    });
    this.resize.observe(host);
  }
  restoreConditions(settings: ComparisonSettings) {
    const c = settings.camera;
    this.savedAspect = c.aspect;
    this.camera.up.fromArray(c.up);
    this.controls.dispose();
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false;
    this.camera.fov = c.fov;
    this.camera.near = c.near;
    this.camera.far = c.far;
    this.camera.aspect = c.aspect;
    this.camera.updateProjectionMatrix();
    this.restore(c);
    this.renderer.setPixelRatio(settings.viewport.pixelRatio);
    this.renderer.setSize(this.host.clientWidth, this.host.clientHeight);
    this.mode(settings.mode);
    this.lighting(settings.lighting);
    this.renderer.setClearColor(settings.background);
    this.renderer.toneMappingExposure = settings.exposure;
    if (this.grid) this.grid.visible = settings.grid;
    this.show(settings.displayed === 'A' ? 0 : 1);
  }
  async loadPair(left: string, right: string) {
    await this.load(left);
    if (this.disposed) return;
    const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(right);
    if (this.disposed) {
      this.disposeObject(gltf.scene);
      return;
    }
    this.other = gltf.scene;
    this.other.visible = false;
    this.scene.add(this.other);
    this.other.traverse((object) => {
      if (object instanceof Mesh) this.originals.set(object, object.material);
    });
    this.playback?.reset();
    for (const model of [this.model!, this.other])
      model.traverse((object) => {
        // Exclude the lamp itself without hiding meshes parented to it.
        if (object instanceof Light) object.layers.disableAll();
      });
    this.controls.enableDamping = false;
    this.camera.near = Math.max(...this.size.toArray(), 0.1) / 200;
    this.camera.updateProjectionMatrix();
    this.show(0);
  }
  show(side: number) {
    if (!this.model || !this.other) return;
    this.model.visible = side === 0;
    this.other.visible = side === 1;
    this.renderer.render(this.scene, this.camera);
  }
  conditions() {
    const canvas = this.renderer.domElement;
    return {
      camera: {
        ...this.cameraState(),
        up: this.camera.up.toArray(),
        fov: this.camera.fov,
        near: this.camera.near,
        far: this.camera.far,
        aspect: this.camera.aspect,
      },
      viewport: {
        width: canvas.clientWidth,
        height: canvas.clientHeight,
        pixelRatio: this.renderer.getPixelRatio(),
        bufferWidth: canvas.width,
        bufferHeight: canvas.height,
      },
      background: '#' + this.renderer.getClearColor(new Color()).getHexString(),
      embeddedLights: false,
      three: REVISION,
      outputColorSpace: this.renderer.outputColorSpace,
      toneMapping: this.renderer.toneMapping,
      exposure: this.renderer.toneMappingExposure,
    };
  }
  override dispose() {
    this.mode('pbr');
    if (this.other) {
      this.other.removeFromParent();
      this.disposeObject(this.other);
      this.other = null;
    }
    super.dispose();
  }
}
