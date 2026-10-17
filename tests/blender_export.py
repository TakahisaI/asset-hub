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
    bpy.ops.wm.read_factory_settings(use_empty=True)
    pbr_material = bpy.data.materials.new('procedural roughness bump')
    pbr_material.use_nodes = True
    pbr_nodes, pbr_links = pbr_material.node_tree.nodes, pbr_material.node_tree.links
    pbr_shader = pbr_nodes.get('Principled BSDF')
    pbr_shader.inputs['Base Color'].default_value = (0.4, 0.1, 0.05, 1)
    noise = pbr_nodes.new('ShaderNodeTexNoise')
    noise.inputs['Scale'].default_value = 8
    pbr_links.new(noise.outputs['Fac'], pbr_shader.inputs['Roughness'])
    pbr_links.new(noise.outputs['Fac'], pbr_shader.inputs['Metallic'])
    bump = pbr_nodes.new('ShaderNodeBump')
    bump.inputs['Strength'].default_value = 0.5
    bump.inputs['Distance'].default_value = 0.02
    pbr_links.new(noise.outputs['Fac'], bump.inputs['Height'])
    pbr_links.new(bump.outputs['Normal'], pbr_shader.inputs['Normal'])
    bpy.ops.mesh.primitive_cylinder_add(vertices=7, radius=1, depth=2, location=(0, 0, 1))
    bpy.context.object.data.materials.append(pbr_material)
    pbr_source, pbr_target = directory / 'pbr.blend', directory / 'pbr.glb'
    bpy.ops.wm.save_as_mainfile(filepath=str(pbr_source))
    original_pbr = pbr_source.read_bytes()
    pbr_report = export_blend(pbr_source, pbr_target, size=512)
    assert pbr_source.read_bytes() == original_pbr
    assert pbr_report['triangulatedMeshes'] == 1
    assert pbr_report['bakedRoughnessMaterials'] == ['procedural roughness bump']
    assert pbr_report['bakedMetallicMaterials'] == ['procedural roughness bump']
    assert pbr_report['bakedNormalMaterials'] == ['procedural roughness bump']
    pbr_data = pbr_target.read_bytes()
    pbr_gltf = json.loads(pbr_data[20:20 + struct.unpack_from('<I', pbr_data, 12)[0]])
    pbr_exported = next(m for m in pbr_gltf['materials'] if m['name'] == 'procedural roughness bump')
    assert 'metallicRoughnessTexture' in pbr_exported['pbrMetallicRoughness'], pbr_exported
    assert 'normalTexture' in pbr_exported, pbr_exported
    for mesh in pbr_gltf['meshes']:
        for primitive in mesh['primitives']:
            if 'normalTexture' in pbr_gltf['materials'][primitive['material']]:
                assert 'TANGENT' in primitive['attributes'], primitive
    # Baked maps must carry spatial variation, not a flat fill.
    for image_name in ['Asset Hub roughness', 'Asset Hub normal']:
        values = np.array(bpy.data.images[image_name].pixels[:]).reshape(-1, 4)[:, :3]
        assert float(values.std()) > 0.01, (image_name, float(values.std()))
    print('PASS: procedural roughness, metallic and bump survive export as PBR textures')
    bpy.ops.wm.read_factory_settings(use_empty=True)
    expected = {}
    for index, procedural in enumerate(['Roughness', 'Metallic', 'Both']):
        material = bpy.data.materials.new('scalar ' + procedural)
        material.use_nodes = True
        nodes, links = material.node_tree.nodes, material.node_tree.links
        shader = nodes.get('Principled BSDF')
        ramp = nodes.new('ShaderNodeValToRGB')
        for element in ramp.color_ramp.elements:
            element.color = (1, 0, 0, 1) if procedural == 'Both' else (0.9, 0.9, 0.9, 1)
        for name in ['Roughness', 'Metallic']:
            if procedural in [name, 'Both']:
                links.new(ramp.outputs['Color'], shader.inputs[name])
            else:
                # A patterned source image sampled from a small, off-center part of its UVs.
                image = bpy.data.images.new('source ' + name, width=8, height=8)
                image.colorspace_settings.name = 'Non-Color'
                pixels = np.zeros((8, 8, 4), dtype=np.float32)
                pixels[:, 4:, :3] = 0.7
                pixels[:, :, 3] = 1
                image.pixels[:] = pixels.ravel()
                image.pack()
                texture = nodes.new('ShaderNodeTexImage')
                texture.image = image
                links.new(texture.outputs['Color'], shader.inputs[name])
        bpy.ops.mesh.primitive_plane_add(location=(index * 3, 0, 0))
        obj = bpy.context.object
        obj.name = material.name
        obj.data.materials.append(material)
        obj.data.materials.append(None)
        for loop in obj.data.uv_layers.active.data:
            loop.uv = (0.7 + loop.uv.x * 0.1, 0.4 + loop.uv.y * 0.1)
        # The default scene uses Rec.709 luminance for RGB-to-float conversion.
        expected[obj.name] = (0.2126, 0.2126) if procedural == 'Both' else (
            (0.9, 0.7) if procedural == 'Roughness' else (0.7, 0.9)
        )
    scalar_source, scalar_target = directory / 'scalars.blend', directory / 'scalars.glb'
    bpy.ops.wm.save_as_mainfile(filepath=str(scalar_source))
    scalar_report = export_blend(scalar_source, scalar_target, size=512)
    assert set(scalar_report['bakedRoughnessMaterials']) == set(expected)
    assert set(scalar_report['bakedMetallicMaterials']) == set(expected)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(scalar_target))
    for name, values in expected.items():
        obj = bpy.data.objects[name]
        texture = next(n for n in obj.data.materials[0].node_tree.nodes if n.type == 'TEX_IMAGE')
        uv_node = texture.inputs['Vector'].links[0].from_node
        uv = obj.data.uv_layers[uv_node.uv_map]
        pixels = np.array(texture.image.pixels[:]).reshape(512, 512, 4)
        for face in obj.data.polygons:
            center = sum((uv.data[i].uv for i in face.loop_indices), Vector((0, 0))) / len(face.loop_indices)
            sample = pixels[int(center.y * 512), int(center.x * 512), 1:3]
            assert max(abs(sample - values)) < 0.01, (name, sample, values)
    print('PASS: packed scalar texels preserve source UVs and color conversion; empty slots export')

    bpy.ops.wm.read_factory_settings(use_empty=True)
    material = bpy.data.materials.new('constant scalars')
    material.use_nodes = True
    nodes, links = material.node_tree.nodes, material.node_tree.links
    shader = nodes.get('Principled BSDF')
    for name, value in [('Roughness', 0.25), ('Metallic', 0.75)]:
        constant = nodes.new('ShaderNodeValue')
        constant.outputs[0].default_value = value
        links.new(constant.outputs[0], shader.inputs[name])
    for kind in ['shape keys', 'armature']:
        bpy.ops.mesh.primitive_cube_add()
        obj = bpy.context.object
        obj.data.materials.append(material)
        if kind == 'shape keys':
            obj.shape_key_add(name='Basis')
            obj.shape_key_add(name='Raised').data[0].co.z += 0.5
        else:
            rig = bpy.data.objects.new('rig', bpy.data.armatures.new('rig'))
            bpy.context.collection.objects.link(rig)
            obj.modifiers.new('rig', 'ARMATURE').object = rig
    constant_source, constant_target = directory / 'constant.blend', directory / 'constant.glb'
    bpy.ops.wm.save_as_mainfile(filepath=str(constant_source))
    constant_report = export_blend(constant_source, constant_target, size=512)
    assert not constant_report['bakedRoughnessMaterials']
    assert not constant_report['bakedMetallicMaterials']
    data = constant_target.read_bytes()
    gltf = json.loads(data[20:20 + struct.unpack_from('<I', data, 12)[0]])
    pbr = gltf['materials'][0]['pbrMetallicRoughness']
    assert pbr['roughnessFactor'] == 0.25 and pbr['metallicFactor'] == 0.75, pbr
    assert 'metallicRoughnessTexture' not in pbr
    assert any('targets' in p for m in gltf['meshes'] for p in m['primitives'])
    print('PASS: constant Value scalars export directly on shape-key and armature meshes')

    bpy.ops.wm.read_factory_settings(use_empty=True)
    material = bpy.data.materials.new('scaled linear bump')
    material.use_nodes = True
    nodes, links = material.node_tree.nodes, material.node_tree.links
    shader = nodes.get('Principled BSDF')
    coord = nodes.new('ShaderNodeTexCoord')
    separate = nodes.new('ShaderNodeSeparateXYZ')
    links.new(coord.outputs['Object'], separate.inputs[0])
    bump = nodes.new('ShaderNodeBump')
    bump.inputs['Distance'].default_value = 0.5
    height = nodes.new('ShaderNodeMath')
    height.operation = 'ADD'
    links.new(separate.outputs['X'], height.inputs[0])
    links.new(separate.outputs['Y'], height.inputs[1])
    links.new(height.outputs[0], bump.inputs['Height'])
    links.new(bump.outputs['Normal'], shader.inputs['Normal'])
    # Force the color helper path too, so normals cannot accidentally reuse its transforms.
    links.new(separate.outputs['X'], shader.inputs['Base Color'])
    for i, scale in enumerate([(1, 1, 1), (4, 1, 1), (4, 1, 1)]):
        bpy.ops.mesh.primitive_plane_add(location=(i * 10, 0, 0))
        obj = bpy.context.object
        obj.name = 'scaled ' + str(i)
        obj.scale = scale
        obj.rotation_euler.z = 0.4
        part_material = material.copy()
        next(n for n in part_material.node_tree.nodes if n.type == 'BUMP').inputs['Distance'].default_value = 0.05 if i == 0 else 0.9
        obj.data.materials.append(part_material)
    bpy.context.scene.render.bake.normal_r = 'NEG_X'
    bpy.context.scene.render.bake.normal_g = 'NEG_Y'
    bpy.context.scene.render.bake.normal_b = 'NEG_Z'
    normal_source = directory / 'normals.blend'
    bpy.ops.wm.save_as_mainfile(filepath=str(normal_source))
    export_blend(normal_source, directory / 'normals.glb', size=512)
    actual = np.array(bpy.data.images['Asset Hub normal'].pixels[:]).reshape(512, 512, 4)
    # Independent reference: bake each original with its transform and the exported atlas UVs.
    atlas = {o.name: [loop.uv.copy() for loop in o.data.uv_layers['AssetHubBaseColor'].data]
             for o in bpy.context.scene.objects if o.type == 'MESH'}
    bpy.ops.wm.open_mainfile(filepath=str(normal_source), use_scripts=False)
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 1
    scene.render.bake.use_clear = True
    scene.render.bake.use_selected_to_active = False
    scene.render.bake.normal_space = 'TANGENT'
    scene.render.bake.normal_r, scene.render.bake.normal_g, scene.render.bake.normal_b = 'POS_X', 'POS_Y', 'POS_Z'
    reference = bpy.data.images.new('reference', width=512, height=512, alpha=False)
    reference.colorspace_settings.name = 'Non-Color'
    reference_pixels = {}
    for name, coords in atlas.items():
        obj = bpy.data.objects[name]
        material = obj.data.materials[0]
        texture = material.node_tree.nodes.new('ShaderNodeTexImage')
        texture.image = reference
        material.node_tree.nodes.active = texture
        uv = obj.data.uv_layers.new(name='reference')
        obj.data.uv_layers.active = uv
        for loop, point in zip(uv.data, coords):
            loop.uv = point
        export_blender.select([obj])
        bpy.ops.object.bake(type='NORMAL', uv_layer=uv.name)
        reference_pixels[name] = np.array(reference.pixels[:]).reshape(512, 512, 4)
    for name, coords in atlas.items():
        center = sum(coords, Vector((0, 0))) / len(coords)
        for point in [center, *[center * 0.03 + coord * 0.97 for coord in coords]]:
            x, y = int(point.x * 512), int(point.y * 512)
            assert max(abs(actual[y, x, :3] - reference_pixels[name][y, x, :3])) < 0.008, (
                name, actual[y, x, :3], reference_pixels[name][y, x, :3]
            )
    print('PASS: nonuniform object scales and saved normal-axis settings match individual +XYZ bakes')

    bpy.ops.wm.read_factory_settings(use_empty=True)
    normal_cases = ['RGB', 'Constant', 'Strength', 'OBJECT', 'WORLD', 'Image', 'Neutral']
    for i, case in enumerate(normal_cases):
        material = bpy.data.materials.new(case)
        material.use_nodes = True
        nodes, links = material.node_tree.nodes, material.node_tree.links
        normal = nodes.new('ShaderNodeNormalMap')
        links.new(normal.outputs['Normal'], nodes.get('Principled BSDF').inputs['Normal'])
        color = (0.8, 0.7, 1, 1)
        if case == 'RGB':
            rgb = nodes.new('ShaderNodeRGB')
            rgb.outputs[0].default_value = color
            links.new(rgb.outputs[0], normal.inputs['Color'])
        elif case == 'Constant':
            normal.inputs['Color'].default_value = color
        elif case != 'Neutral':
            image = bpy.data.images.new('source normal ' + case, width=4, height=4)
            image.colorspace_settings.name = 'Non-Color'
            image.pixels[:] = list(color) * 16
            image.pack()
            texture = nodes.new('ShaderNodeTexImage')
            texture.image = image
            links.new(texture.outputs['Color'], normal.inputs['Color'])
            if case == 'Strength':
                noise = nodes.new('ShaderNodeTexNoise')
                links.new(noise.outputs['Fac'], normal.inputs['Strength'])
            elif case in ['OBJECT', 'WORLD']:
                normal.space = case
            else:
                normal.inputs['Strength'].default_value = 0.4
        bpy.ops.mesh.primitive_plane_add(location=(i * 3, 0, 0))
        obj = bpy.context.object
        obj.name = case
        obj.data.materials.append(material)
        if case == 'RGB':
            for loop in obj.data.uv_layers.active.data:
                loop.uv = (loop.uv.y, 1 - loop.uv.x)
        if case in ['Image', 'Neutral']:
            obj.shape_key_add(name='Basis')
            obj.shape_key_add(name='Raised').data[0].co.z += 0.5
    maps_source, maps_target = directory / 'normal-maps.blend', directory / 'normal-maps.glb'
    bpy.ops.wm.save_as_mainfile(filepath=str(maps_source))
    maps_report = export_blend(maps_source, maps_target, size=512)
    assert set(maps_report['bakedNormalMaterials']) == set(normal_cases) - {'Image', 'Neutral'}
    data = maps_target.read_bytes()
    gltf = json.loads(data[20:20 + struct.unpack_from('<I', data, 12)[0]])
    for material in gltf['materials']:
        if material['name'] == 'Neutral':
            assert 'normalTexture' not in material
        else:
            assert 'normalTexture' in material, material
            expected_scale = 0.4 if material['name'] == 'Image' else 1
            assert abs(material['normalTexture'].get('scale', 1) - expected_scale) < 1e-6
    pixels = np.array(bpy.data.images['Asset Hub normal'].pixels[:]).reshape(512, 512, 4)
    for case in set(normal_cases) - {'Image', 'Neutral'}:
        obj = bpy.data.objects[case]
        coords = [loop.uv for loop in obj.data.uv_layers['AssetHubBaseColor'].data]
        center = sum(coords, Vector((0, 0))) / len(coords)
        sample = pixels[int(center.y * 512), int(center.x * 512), :3]
        assert max(abs(sample - [0.5, 0.5, 1])) > 0.05, (case, sample)
    print('PASS: constant normal colors, procedural strength and object/world maps bake; direct tangent images pass through')

    # A baked normal atlas must use its own UV basis, even when another UV map exists.
    primitive = gltf['meshes'][next(n['mesh'] for n in gltf['nodes'] if n.get('name') == 'RGB')]['primitives'][0]
    assert 'TANGENT' in primitive['attributes'], primitive
    binary = data[28 + struct.unpack_from('<I', data, 12)[0]:]

    accessor = gltf['accessors'][primitive['attributes']['TANGENT']]
    view = gltf['bufferViews'][accessor['bufferView']]
    assert accessor['type'] == 'VEC4' and accessor['componentType'] == 5126
    tangents = np.ndarray(
        (accessor['count'], 4), dtype='<f4', buffer=binary,
        offset=view.get('byteOffset', 0) + accessor.get('byteOffset', 0),
        strides=(view.get('byteStride', 16), 4),
    )
    obj = bpy.data.objects['RGB']
    shader = obj.data.materials[0].node_tree.nodes.get('Principled BSDF')
    normal_map = shader.inputs['Normal'].links[0].from_node
    obj.data.calc_tangents(uvmap=normal_map.uv_map)
    reference = obj.data.loops[0]
    # The flat plane's reference basis is constant; convert Blender Z-up to glTF Y-up.
    expected_tangent = np.array([reference.tangent.x, reference.tangent.z, -reference.tangent.y])
    assert np.all(tangents[:, :3] @ expected_tangent > 0.999), (tangents, expected_tangent)
    assert np.all(tangents[:, 3] == reference.bitangent_sign), tangents
    print('PASS: serialized tangents follow the normal texture UV basis')
