"""Record Blender material timing into an existing GLB without changing its geometry or source."""
import argparse
import hashlib
import json
import pathlib
import struct
import sys

import bpy


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def record_vfx(source, model, destination, runtime, preview=None):
    source, model, destination, runtime = [pathlib.Path(p).resolve() for p in [source, model, destination, runtime]]
    report_file = destination.with_suffix('.json')
    if destination.suffix.lower() != '.glb' or destination.exists() or report_file.exists():
        raise ValueError('Use a new GLB destination')
    data = model.read_bytes()
    if data[:4] != b'glTF' or struct.unpack_from('<II', data, 4) != (2, len(data)):
        raise ValueError('Invalid input GLB')
    length, kind = struct.unpack_from('<II', data, 12)
    if kind != 0x4E4F534A:
        raise ValueError('Missing GLB JSON')
    gltf = json.loads(data[20:20 + length])
    if 'assetHubVfx' in gltf.get('extras', {}):
        raise ValueError('Input already contains VFX data')
    bpy.ops.wm.open_mainfile(filepath=str(source), use_scripts=False)
    scene = bpy.context.scene
    poster_frame = scene.frame_current
    start, end = scene.frame_start, scene.frame_end
    if not 1 <= end - start < 10000:
        raise ValueError('VFX needs 2 to 10000 frames')
    fps = scene.render.fps / scene.render.fps_base
    clips = gltf.get('animations', [])
    if len(clips) != 1:
        raise ValueError('VFX recording requires one existing scene clip')
    duration = max(gltf['accessors'][s['input']]['max'][0] for s in clips[0]['samplers'])
    first_time = min(gltf['accessors'][s['input']]['min'][0] for s in clips[0]['samplers'])
    times = [first_time + (frame - start) / fps for frame in range(start, end + 1)]
    if first_time < 0 or abs(duration - times[-1]) > 1e-4:
        raise ValueError(f'Blender and GLB timelines do not match: GLB {duration}s, Blender {times[-1]}s')
    smoke, emission, sockets = [], [], []
    for index, definition in enumerate(gltf.get('materials', [])):
        material = bpy.data.materials.get(definition.get('name', ''))
        if not material or not material.use_nodes:
            continue
        nodes = material.node_tree.nodes
        output = next((n for n in nodes if n.type == 'OUTPUT_MATERIAL' and n.is_active_output), None)
        if not output:
            continue
        if output.inputs['Volume'].is_linked:
            volume = output.inputs['Volume'].links[0].from_node
            if volume.type != 'PRINCIPLED_VOLUME' or volume.inputs['Color'].is_linked:
                raise ValueError('Unsupported volume: ' + material.name)
            density = volume.inputs['Density']
            if not density.is_linked:
                raise ValueError('Volume needs a noise multiplier: ' + material.name)
            multiply = density.links[0].from_node
            if multiply.type != 'MATH' or multiply.operation != 'MULTIPLY' or not multiply.inputs[0].is_linked or multiply.inputs[1].is_linked:
                raise ValueError('Unsupported density expression: ' + material.name)
            noise = multiply.inputs[0].links[0].from_node
            threshold = 0
            if noise.type == 'MATH' and noise.operation == 'SUBTRACT' and noise.use_clamp and not noise.inputs[1].is_linked:
                if not noise.inputs[0].is_linked:
                    raise ValueError('Unsupported smoke noise: ' + material.name)
                threshold = float(noise.inputs[1].default_value)
                noise = noise.inputs[0].links[0].from_node
            if noise.type != 'TEX_NOISE' or noise.inputs['Scale'].is_linked:
                raise ValueError('Unsupported smoke noise: ' + material.name)
            for obj in scene.objects:
                if obj.type == 'MESH' and any(slot.material == material for slot in obj.material_slots):
                    if any(abs(vertex.co.length - 1) > 0.01 for vertex in obj.data.vertices):
                        raise ValueError('Smoke requires a unit sphere mesh: ' + obj.name)
            entry = {'material': index, 'color': list(volume.inputs['Color'].default_value[:3]),
                     'noiseScale': float(noise.inputs['Scale'].default_value), 'threshold': threshold, 'density': []}
            smoke.append(entry)
            sockets.append((multiply.inputs[1], entry['density']))
        if output.inputs['Surface'].is_linked:
            shader = output.inputs['Surface'].links[0].from_node
            if shader.type != 'BSDF_PRINCIPLED':
                continue
            strength = shader.inputs['Emission Strength']
            color = shader.inputs['Emission Color']
            if strength.is_linked or color.is_linked:
                raise ValueError('Bake linked emission before VFX recording: ' + material.name)
            entry = {'material': index, 'color': list(color.default_value[:3]), 'strength': []}
            emission.append(entry)
            sockets.append((strength, entry['strength']))
    for frame in range(start, end + 1):
        scene.frame_set(frame)
        for socket, values in sockets:
            values.append(float(socket.default_value))
    # Static emission already travels in standard glTF; record only changing strengths.
    emission = [entry for entry in emission if max(entry['strength']) - min(entry['strength']) > 1e-6]
    info = {'runtime': sha(runtime), 'source': {'name': source.name, 'hash': sha(source)},
            'limitations': 'Three.js向けのVFX。移動・拡縮は元のGLBクリップ、煙密度・発光強度はBlenderからフレームごとに収録。煙はノイズを使う近似ボリュームで、Blenderのノイズ、照明・影、ブルームの完全再現ではありません。'}
    if preview:
        preview = pathlib.Path(preview).resolve()
        if preview.parent != source.parent or preview.suffix.lower() != '.mp4':
            raise ValueError('Preview must be an MP4 beside the preserved source')
        info['preview'] = {'name': preview.name, 'hash': sha(preview)}
    vfx = {**info, 'schema': 1, 'clip': 0, 'posterTime': max(0, min(times[-1], first_time + (poster_frame - start) / fps)),
           'times': times, 'smoke': smoke, 'emission': emission}
    gltf.setdefault('extras', {})['assetHubVfx'] = vfx
    encoded = json.dumps(gltf, separators=(',', ':'), ensure_ascii=False).encode()
    encoded += b' ' * (-len(encoded) % 4)
    tail = data[20 + length:]
    result = struct.pack('<4sIIII', b'glTF', 2, 20 + len(encoded) + len(tail), len(encoded), 0x4E4F534A) + encoded + tail
    assert result[20 + len(encoded):] == tail
    destination.parent.mkdir(parents=True, exist_ok=True)
    report = {'sourceHash': info['source']['hash'], 'inputGlbHash': sha(model), 'glbHash': hashlib.sha256(result).hexdigest(),
              'exporterHash': sha(pathlib.Path(__file__)), 'runtimeHash': info['runtime'], 'blender': bpy.app.version_string,
              'frames': len(times), 'fps': fps, 'smokeMaterials': len(smoke), 'animatedEmissionMaterials': len(emission),
              'limitations': info['limitations']}
    with destination.open('xb') as file:
        file.write(result)
    with report_file.open('x') as file:
        json.dump(report, file, ensure_ascii=False, indent=2)
        file.write('\n')
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source')
    parser.add_argument('model')
    parser.add_argument('destination')
    parser.add_argument('--runtime', required=True)
    parser.add_argument('--preview')
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:])
    print(json.dumps(record_vfx(args.source, args.model, args.destination, args.runtime, args.preview), ensure_ascii=False))
