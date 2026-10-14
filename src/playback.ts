import * as THREE from 'three';
import type { Preset } from './schema.ts';

export class Playback {
  mixer: THREE.AnimationMixer;
  action?: THREE.AnimationAction;
  time = 0;
  // Clip loops must not reset continuous mechanical rotation.
  rotationTime = 0;
  speed = 1;
  loop = true;
  duration = 0;
  playing = false;
  clip?: number;
  preset?: Preset;
  private rest = new Map<
    THREE.Object3D,
    { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 }
  >();
  private intensities = new Map<THREE.Light, number>();
  private addedLights: THREE.Light[] = [];
  constructor(
    public root: THREE.Object3D,
    public nodes: Map<number, THREE.Object3D>,
    public clips: THREE.AnimationClip[],
  ) {
    this.mixer = new THREE.AnimationMixer(root);
    root.traverse((o) => {
      this.rest.set(o, {
        position: o.position.clone(),
        quaternion: o.quaternion.clone(),
        scale: o.scale.clone(),
      });
      if (o instanceof THREE.Light) this.intensities.set(o, o.intensity);
    });
  }
  reset() {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.root);
    for (const [object, rest] of this.rest) {
      object.position.copy(rest.position);
      object.quaternion.copy(rest.quaternion);
      object.scale.copy(rest.scale);
    }
    for (const [light, intensity] of this.intensities) light.intensity = intensity;
    this.addedLights.forEach((light) => {
      light.removeFromParent();
      light.dispose();
    });
    this.addedLights = [];
    this.action = undefined;
    this.preset = undefined;
    this.clip = undefined;
    this.time = 0;
    this.rotationTime = 0;
    this.duration = 0;
    this.playing = false;
  }
  select(clip?: number, preset?: Preset, externalClip?: THREE.AnimationClip) {
    this.reset();
    this.clip = clip;
    this.preset = preset;
    this.speed = preset?.speed ?? 1;
    this.loop = preset?.loop ?? true;
    const animation = externalClip ?? (clip === undefined ? undefined : this.clips[clip]);
    if (clip !== undefined && !animation) throw new Error('クリップが見つかりません');
    this.duration = animation?.duration ?? (preset ? preset.duration : 0);
    if (animation) this.action = this.mixer.clipAction(animation).play();
    for (const light of preset?.lights ?? []) {
      const node = this.node(light.node);
      if (light.type) {
        const added =
          light.type === 'spot'
            ? new THREE.SpotLight(light.color, light.intensity, light.range, light.angle)
            : new THREE.PointLight(light.color, light.intensity, light.range);
        if (added instanceof THREE.SpotLight) {
          added.target.position.set(0, 0, -1);
          node.add(added.target);
          // The target is removed with the light when switching presets.
          const dispose = added.dispose.bind(added);
          added.dispose = () => {
            added.target.removeFromParent();
            dispose();
          };
        }
        node.add(added);
        this.addedLights.push(added);
      } else {
        const otherNodes = new Set(this.nodes.values());
        const lights =
          node instanceof THREE.Light
            ? [node]
            : node.children.filter(
                (o): o is THREE.Light => o instanceof THREE.Light && !otherNodes.has(o),
              );
        if (!lights.length) throw new Error('対象ノードに照明がありません');
        lights.forEach((l) => {
          l.intensity = light.intensity;
        });
      }
    }
    this.seek(0);
  }
  node(index: number) {
    const node = this.nodes.get(index);
    if (!node) throw new Error('ノードがありません: ' + index);
    return node;
  }
  seek(seconds: number, rotationTime?: number) {
    this.time = Math.max(0, Math.min(seconds, this.duration));
    this.rotationTime = rotationTime ?? this.time;
    if (this.action) {
      this.action.setLoop(THREE.LoopOnce, 1);
      this.action.clampWhenFinished = true;
      this.action.reset().play();
      this.mixer.setTime(this.time);
    }
    for (const rotation of this.preset?.rotations ?? []) {
      const node = this.node(rotation.node),
        rest = this.rest.get(node)!;
      const turn = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(...rotation.axis).normalize(),
        (this.rotationTime * rotation.rpm * Math.PI) / 30,
      );
      node.quaternion.copy(rest.quaternion).multiply(turn);
    }
    this.root.updateMatrixWorld(true);
  }
  advance(delta: number) {
    if (!this.playing || this.duration <= 0) return;
    const next = this.time + delta * this.speed;
    const step = this.loop
      ? delta * this.speed
      : Math.min(delta * this.speed, this.duration - this.time);
    this.seek(
      this.loop ? next % this.duration : Math.min(next, this.duration),
      this.rotationTime + step,
    );
    if (!this.loop && next >= this.duration) this.playing = false;
  }
  dispose() {
    this.reset();
    this.rest.clear();
    this.intensities.clear();
  }
}

export function bindMotion(
  clip: THREE.AnimationClip,
  sourceNodes: Map<number, THREE.Object3D>,
  targetNodes: Map<number, THREE.Object3D>,
  mapping: Record<string, number>,
) {
  const names = new Map<string, string>();
  for (const [from, to] of Object.entries(mapping)) {
    const source = sourceNodes.get(Number(from)),
      target = targetNodes.get(to);
    if (!source || !target) throw new Error('モーションのノード対応が欠けています');
    names.set(source.uuid, target.uuid);
    if (source.name) names.set(source.name, target.uuid);
  }
  return new THREE.AnimationClip(
    clip.name,
    clip.duration,
    clip.tracks.map((track) => {
      const binding = THREE.PropertyBinding.parseTrackName(track.name);
      const target = names.get(binding.nodeName);
      if (
        !target ||
        !['position', 'quaternion', 'scale'].includes(binding.propertyName) ||
        binding.objectName ||
        binding.propertyIndex
      )
        throw new Error('共有できないモーショントラック: ' + track.name);
      const copy = track.clone();
      copy.name = target + '.' + binding.propertyName;
      return copy;
    }),
  );
}
