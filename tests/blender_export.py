"""Isolated regression: blender -b -t 2 --python-exit-code 1 --python tests/blender_export.py."""

import hashlib
import json
from pathlib import Path
import struct
import sys
import tempfile

import bpy
import numpy as np
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
from export_blender import export_blend
import export_blender


with tempfile.TemporaryDirectory(prefix='asset-hub-color-test-') as directory:
    directory = Path(directory)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    material = bpy.data.materials.new('height-dependent sandstone')
    material.use_nodes = True
    nodes, links = material.node_tree.nodes, material.node_tree.links
    shader = nodes.get('Principled BSDF')
    shader.inputs['Metallic'].default_value = 0.6
    position = nodes.new('ShaderNodeNewGeometry')
    separate = nodes.new('ShaderNodeSeparateXYZ')
    links.new(position.outputs['Position'], separate.inputs[0])
    height = nodes.new('ShaderNodeMapRange')
    height.inputs['From Min'].default_value = 0
    height.inputs['From Max'].default_value = 2
    height.inputs['To Min'].default_value = 0.5
    height.inputs['To Max'].default_value = 1
    links.new(separate.outputs['Z'], height.inputs[0])
    multiply = nodes.new('ShaderNodeMixRGB')
    multiply.blend_type = 'MULTIPLY'
    multiply.inputs[0].default_value = 1
    multiply.inputs[1].default_value = (0.2, 0.1, 0.05, 1)
    links.new(height.outputs[0], multiply.inputs[2])
    links.new(multiply.outputs[0], shader.inputs['Base Color'])
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0.5))
    low = bpy.context.object
    low.name = 'low'
    low.data.materials.append(material)
    high = low.copy()
    high.name = 'high'
    high.location = (2, 0, 2.5)
    bpy.context.collection.objects.link(high)
    blue = material.copy()
    blue.name = 'blue height'
    next(n for n in blue.node_tree.nodes if n.type == 'MIX_RGB').inputs[1].default_value = (0.02, 0.1, 0.2, 1)
    high.material_slots[0].link = 'OBJECT'
    high.material_slots[0].material = blue
    high.keyframe_insert(data_path='location', frame=1)
    high.location.x += 1
    high.keyframe_insert(data_path='location', frame=25)
    bpy.context.scene.frame_end = 25
    for kind in ['Generated', 'Object']:
        grain = bpy.data.materials.new(kind + ' grain')
        grain.use_nodes = True
        n, l = grain.node_tree.nodes, grain.node_tree.links
        noise = n.new('ShaderNodeTexNoise')
        noise.inputs['Scale'].default_value = 2
        if kind == 'Object':
            coord = n.new('ShaderNodeTexCoord')
            l.new(coord.outputs['Object'], noise.inputs['Vector'])
        ramp = n.new('ShaderNodeValToRGB')
        ramp.color_ramp.elements[0].color = (0.03, 0.01, 0.005, 1)
        ramp.color_ramp.elements[1].color = (0.4, 0.2, 0.1, 1)
        l.new(noise.outputs['Fac'], ramp.inputs[0])
        l.new(ramp.outputs[0], n.get('Principled BSDF').inputs['Base Color'])
        for i in range(2):
            bpy.ops.mesh.primitive_cube_add(size=1, location=(i * 2, 3 if kind == 'Generated' else 6, 0))
            cube = bpy.context.object
            cube.data.materials.append(grain)
            cube.scale = (0.8, 1.4, 1)
            cube.rotation_euler.z = i * 0.5
            bevel = cube.modifiers.new('bevel', 'BEVEL')
            bevel.width = 0.03
            bevel.segments = 2
    studio = bpy.data.collections.new('STUDIO test')
    bpy.context.scene.collection.children.link(studio)
    bpy.ops.mesh.primitive_cube_add(location=(100, 0, 0))
    excluded = bpy.context.object
    excluded.name = 'excluded'
    for collection in list(excluded.users_collection):
        collection.objects.unlink(excluded)
    studio.objects.link(excluded)
    source, target = directory / 'source.blend', directory / 'result.glb'
    bpy.ops.wm.save_as_mainfile(filepath=str(source))
    original = source.read_bytes()
    report = export_blend(source, target, ['STUDIO'], size=512)
    assert source.read_bytes() == original, 'Original .blend was modified'
    assert report['sourceHash'] == hashlib.sha256(original).hexdigest()
    assert set(report['bakedBaseColorMaterials']) == {'height-dependent sandstone', 'blue height', 'Generated grain', 'Object grain'}
    data = target.read_bytes()
    gltf = json.loads(data[20:20 + struct.unpack_from('<I', data, 12)[0]])
    assert len(gltf['images']) == 1
    assert len(gltf['animations']) >= 1
    assert 'excluded' not in {n.get('name') for n in gltf['nodes']}
    pbr = next(m for m in gltf['materials'] if m['name'] == 'height-dependent sandstone')['pbrMetallicRoughness']
    assert 'baseColorTexture' in pbr
    assert abs(pbr['metallicFactor'] - 0.6) < 1e-5
    try:
        export_blend(source, target, ['STUDIO'], size=512)
        raise AssertionError('Existing export was overwritten')
    except ValueError:
        pass
    assert target.read_bytes() == data
    # The faster, temporary joined bake must match baking each original object separately.
    fast_image = np.array(bpy.data.images['Asset Hub base color'].pixels[:])
    joined = export_blender.joined_bake_mesh
    export_blender.joined_bake_mesh = lambda meshes: None
    export_blend(source, directory / 'reference.glb', ['STUDIO'], size=512)
    slow_image = np.array(bpy.data.images['Asset Hub base color'].pixels[:])
    export_blender.joined_bake_mesh = joined
    # Compare surface interiors; margin dilation can differ outside the UV islands.
    for obj in bpy.context.scene.objects:
        if obj.type != 'MESH' or not obj.data.uv_layers.get('AssetHubBaseColor'):
            continue
        uv = obj.data.uv_layers['AssetHubBaseColor']
        for face in obj.data.polygons:
            coords = [uv.data[i].uv for i in face.loop_indices]
            center = sum(coords, Vector((0, 0))) / len(coords)
            for point in [center, *[(center + coord) * 0.5 for coord in coords]]:
                offset = (int(point.y * 512) * 512 + int(point.x * 512)) * 4
                difference = max(abs(fast_image[offset:offset+3] - slow_image[offset:offset+3]))
                assert difference < 0.008, (obj.name, difference)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(target))
    # Check actual exported texels in linear color, not merely the presence of a texture.
    for name in ['low', 'high']:
        obj = bpy.data.objects[name]
        tex = next(n for n in obj.data.materials[0].node_tree.nodes if n.type == 'TEX_IMAGE')
        pixels = list(tex.image.pixels)
        width, height = tex.image.size
        uv_map = tex.inputs['Vector'].links[0].from_node
        uv = obj.data.uv_layers[uv_map.uv_map]
        for face in obj.data.polygons:
            coords = [uv.data[i].uv for i in face.loop_indices]
            center = sum(coords, Vector((0, 0))) / len(coords)
            ix, iy = int(center.x * width), int(center.y * height)
            sample = pixels[(iy * width + ix) * 4: (iy * width + ix) * 4 + 3]
            sample = [v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in sample]
            world = obj.matrix_world @ face.center
            # Blender's glTF import restores Z-up.
            factor = 0.5 + min(max(world.z, 0), 2) * 0.25
            expected = [v * factor for v in ((0.2, 0.1, 0.05) if name == 'low' else (0.02, 0.1, 0.2))]
            assert max(abs(a - b) for a, b in zip(sample, expected)) < 0.012, (name, sample, expected)
    print('PASS: baked colors, world-space shading, shared meshes, animation, exclusion and source preservation')
    bpy.ops.wm.open_mainfile(filepath=str(source), use_scripts=False)
    prototype = bpy.data.collections.new('prototype')
    low = bpy.data.objects['low']
    for collection in list(low.users_collection):
        collection.objects.unlink(low)
    prototype.objects.link(low)
    for i in range(10):
        duplicate = low.copy()
        duplicate.location.x += (i + 1) * 2
        prototype.objects.link(duplicate)
    for obj in list(bpy.context.scene.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    curve = bpy.data.curves.new('prototype pipe', 'CURVE')
    curve.dimensions = '3D'
    curve.bevel_depth = 0.03
    spline = curve.splines.new('POLY')
    spline.points.add(1)
    spline.points[0].co = (0,0,0,1)
    spline.points[1].co = (0,0,1,1)
    pipe = bpy.data.objects.new('prototype pipe', curve)
    prototype.objects.link(pipe)
    curve.materials.append(bpy.data.materials['height-dependent sandstone'])
    for i in range(2):
        instance = bpy.data.objects.new('instance ' + str(i), None)
        instance.instance_type = 'COLLECTION'
        instance.instance_collection = prototype
        instance.location = (i * 2, 0, i * 2)
        bpy.context.scene.collection.objects.link(instance)
    instanced = directory / 'instanced.blend'
    bpy.ops.wm.save_as_mainfile(filepath=str(instanced))
    result = export_blend(instanced, directory / 'instanced.glb', size=512)
    assert result['realizedInstances'] == 2
    assert result['convertedCurves'] == 2
    instance_data = (directory / 'instanced.glb').read_bytes()
    instance_gltf = json.loads(instance_data[20:20 + struct.unpack_from('<I', instance_data, 12)[0]])
    assert sum('mesh' in node for node in instance_gltf['nodes']) == 24
    assert result['bakedBaseColorMaterials'] == ['height-dependent sandstone']
    bpy.ops.wm.open_mainfile(filepath=str(instanced), use_scripts=False)
    bpy.data.objects['instance 0'].keyframe_insert(data_path='location', frame=1)
    animated = directory / 'animated-instance.blend'
    bpy.ops.wm.save_as_mainfile(filepath=str(animated))
    try:
        export_blend(animated, directory / 'unsupported.glb', size=512)
        raise AssertionError('Animated instance silently flattened')
    except ValueError as error:
        assert 'animated collection' in str(error)
    assert not (directory / 'unsupported.glb').exists()
    print('PASS: static instances baked; unsupported animated instances rejected before export')
    bpy.ops.wm.open_mainfile(filepath=str(instanced), use_scripts=False)
    nested = bpy.data.objects.new('nested', None)
    nested.instance_type = 'COLLECTION'
    nested.instance_collection = bpy.data.collections.new('nested prototype')
    bpy.data.collections['prototype'].objects.link(nested)
    nested_source = directory / 'nested.blend'
    bpy.ops.wm.save_as_mainfile(filepath=str(nested_source))
    try:
        export_blend(nested_source, directory / 'nested.glb', size=512)
        raise AssertionError('Nested instances silently flattened')
    except ValueError as error:
        assert 'nested collection' in str(error)
    bpy.ops.wm.open_mainfile(filepath=str(source), use_scripts=False)
    mesh = bpy.data.objects['low'].data.copy()
    for vertex in mesh.vertices:
        vertex.co *= 0.02
    for obj in list(bpy.context.scene.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for i in range(250):
        obj = bpy.data.objects.new('small part ' + str(i), mesh)
        obj.location = ((i % 25) * 0.04, (i // 25) * 0.04, 3)
        bpy.context.scene.collection.objects.link(obj)
    dense = directory / 'many-small-parts.blend'
    bpy.ops.wm.save_as_mainfile(filepath=str(dense))
    export_blend(dense, directory / 'many-small-parts.glb', size=512)
    pixels = np.array(bpy.data.images['Asset Hub base color'].pixels[:]).reshape(512,512,4)
    for obj in bpy.context.scene.objects:
        uv = obj.data.uv_layers['AssetHubBaseColor']
        for face in obj.data.polygons:
            center = sum((uv.data[i].uv for i in face.loop_indices), Vector((0,0))) / len(face.loop_indices)
            color = pixels[min(int(center.y*512),511),min(int(center.x*512),511),:3]
            linear = np.where(color <= 0.04045, color / 12.92, ((color+0.055)/1.055)**2.4)
            assert np.max(abs(linear - [0.2,0.1,0.05])) < 0.01, (obj.name,color)
    print('PASS: dense small parts retain color instead of collapsing into empty atlas pixels')
