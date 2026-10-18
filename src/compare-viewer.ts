import { Color, Light, Mesh, REVISION, type Group } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { AssetViewer } from './viewer.ts';

// Both models share one camera and drawing buffer; switching never fits or moves either model.
export class CompareViewer extends AssetViewer {
  other: Group | null = null;
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
