"""Run with Blender: --background --python tools/export_blender.py -- source.blend output.glb."""

import argparse
import hashlib
import json
import pathlib
import sys
import tempfile

import bpy
from mathutils import Matrix


def realize_instances(instances):
    depsgraph = bpy.context.evaluated_depsgraph_get()
    curves = 0
    for instance in instances:
        collection = instance.instance_collection
        transform = instance.matrix_world @ Matrix.Translation(-collection.instance_offset)
        copies, worlds = {}, {}
        for original in list(collection.all_objects):
            evaluated = original.evaluated_get(depsgraph)
            if original.type in {'MESH', 'CURVE', 'SURFACE', 'FONT'}:
                mesh = bpy.data.meshes.new_from_object(evaluated, preserve_all_data_layers=True, depsgraph=depsgraph)
                copy = bpy.data.objects.new(original.name, mesh)
                for index, slot in enumerate(copy.material_slots):
                    slot.material = original.material_slots[index].material
                curves += original.type != 'MESH'
            else:
                copy = original.copy()
            copy.parent = None
            copy.constraints.clear()
            copy.hide_render = original.hide_render
            bpy.context.scene.collection.objects.link(copy)
            worlds[original] = transform @ evaluated.matrix_world
            copy.matrix_world = worlds[original]
            copies[original] = copy
        for original, copy in copies.items():
            copy.parent = copies.get(original.parent, instance)
            parent_world = worlds.get(original.parent, instance.matrix_world)
            copy.matrix_parent_inverse = parent_world.inverted()
            copy.matrix_basis = worlds[original]
        instance.instance_type = 'NONE'
        instance.instance_collection = None
    return curves


def joined_bake_mesh(meshes):
    """Use a disposable mesh to avoid scanning an entire atlas once per small part."""
    materials = {slot.material for obj in meshes for slot in obj.material_slots if slot.material}
    for material in materials:
        for node in material.node_tree.nodes:
            if node.type in {'OBJECT_INFO', 'GROUP'} or (node.type == 'TEX_COORD' and any(
                node.outputs[name].is_linked for name in ['Normal', 'Camera', 'Reflection']
            )):
                return None
    copies = {m: m.copy() for m in materials}
    for material in copies.values():
        nodes, links = material.node_tree.nodes, material.node_tree.links
        attributes = {}
        for name in ['Generated', 'Object']:
            attr = nodes.new('ShaderNodeAttribute')
            attr.attribute_name = 'AssetHub' + name
            attributes[name] = attr.outputs['Vector']
        uv = nodes.new('ShaderNodeUVMap')
        uv.uv_map = 'AssetHubSourceUV'
        for node in list(nodes):
            if node.type == 'TEX_COORD':
                for name in ['Generated', 'Object', 'UV']:
                    if name == 'Object' and node.object:
                        continue
                    for link in list(node.outputs[name].links):
                        links.new(uv.outputs[0] if name == 'UV' else attributes[name], link.to_socket)
            elif node.type.startswith('TEX_') and 'Vector' in node.inputs and not node.inputs['Vector'].is_linked:
                links.new(uv.outputs[0] if node.type == 'TEX_IMAGE' else attributes['Generated'], node.inputs['Vector'])
    depsgraph = bpy.context.evaluated_depsgraph_get()
    helpers = []
    for obj in meshes:
        # Generated coordinates must be captured before modifiers and joining change the bounds.
        location, size = obj.data.texspace_location.copy(), obj.data.texspace_size.copy()
        mesh = bpy.data.meshes.new_from_object(obj.evaluated_get(depsgraph), preserve_all_data_layers=True, depsgraph=depsgraph)
        generated = mesh.attributes.new('AssetHubGenerated', 'FLOAT_VECTOR', 'POINT')
        for vertex, value in zip(mesh.vertices, generated.data):
            value.vector = [(vertex.undeformed_co[i] - location[i]) / (2 * size[i] or 1) + 0.5 for i in range(3)]
        local = mesh.attributes.new('AssetHubObject', 'FLOAT_VECTOR', 'POINT')
        for vertex, value in zip(mesh.vertices, local.data):
            value.vector = vertex.co
        original_uv = next(layer for layer in mesh.uv_layers if layer.active_render)
        original_coords = [loop.uv.copy() for loop in original_uv.data]
        source_uv = mesh.uv_layers.new(name='AssetHubSourceUV')
        for value, coord in zip(source_uv.data, original_coords):
            value.uv = coord
        helper = bpy.data.objects.new('Asset Hub bake part', mesh)
        bpy.context.scene.collection.objects.link(helper)
        helper.matrix_world = obj.matrix_world.copy()
        for index, slot in enumerate(helper.material_slots):
            material = obj.material_slots[index].material
            if material:
                slot.material = copies[material]
        helpers.append(helper)
    select(helpers)
    bpy.ops.object.join()
    return bpy.context.object


def select(objects):
    bpy.ops.object.select_all(action='DESELECT')
    for obj in objects:
        obj.hide_set(False)
        obj.hide_select = False
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]


def needs_color_bake(socket):
    if not socket.is_linked:
        return False
    node = socket.links[0].from_node
    if socket.type == 'RGBA' and node.type in {'RGB', 'VERTEX_COLOR'}:
        return False
    if socket.type == 'VALUE' and node.type == 'VALUE':
        return False
    if node.type == 'TEX_IMAGE':
        vector = node.inputs['Vector']
        if not vector.is_linked:
            return False
        link = vector.links[0]
        if link.from_node.type == 'UVMAP' or (
            link.from_node.type == 'TEX_COORD' and link.from_socket.name == 'UV'
        ):
            return False
    return True


def needs_normal_bake(socket):
    if not socket.is_linked:
        return False
    node = socket.links[0].from_node
    if node.type == 'NORMAL_MAP':
        color = node.inputs['Color']
        if node.space == 'TANGENT' and not color.is_linked and tuple(color.default_value[:3]) == (0.5, 0.5, 1):
            return False
        return (node.space != 'TANGENT' or node.inputs['Strength'].is_linked
                or not color.is_linked or color.links[0].from_node.type != 'TEX_IMAGE'
                or needs_color_bake(color))
    return True


CHANNEL_SOCKETS = {'color': 'Base Color', 'roughness': 'Roughness', 'metallic': 'Metallic'}
CHANNEL_IMAGES = {
    'color': ('Asset Hub base color', 'sRGB'),
    'roughness': ('Asset Hub roughness', 'Non-Color'),
    'metallic': ('Asset Hub metallic', 'Non-Color'),
    'normal': ('Asset Hub normal', 'Non-Color'),
}


def principled_shader(material):
    if not material.use_nodes:
        return None, None
    nodes = material.node_tree.nodes
    output = next((n for n in nodes if n.type == 'OUTPUT_MATERIAL' and n.is_active_output), None)
    if not output or not output.inputs['Surface'].is_linked:
        return None, None
    shader = output.inputs['Surface'].links[0].from_node
    return (output, shader) if shader.type == 'BSDF_PRINCIPLED' else (None, None)


def baked_channels(material):
    _, shader = principled_shader(material)
    if not shader:
        return set()
    channels = set()
    if needs_color_bake(shader.inputs['Base Color']):
        channels.add('color')
    if needs_color_bake(shader.inputs['Roughness']):
        channels.add('roughness')
    if needs_color_bake(shader.inputs['Metallic']):
        channels.add('metallic')
    # glTF packs both scalars into one texture, so linked images must share its UVs.
    if channels & {'roughness', 'metallic'}:
        for channel in ['roughness', 'metallic']:
            socket = shader.inputs[CHANNEL_SOCKETS[channel]]
            if socket.is_linked and socket.links[0].from_node.type != 'VALUE':
                channels.add(channel)
    if needs_normal_bake(shader.inputs['Normal']):
        channels.add('normal')
    return channels


def bake_base_colors(objects, size):
    materials = {slot.material for obj in objects for slot in obj.material_slots if slot.material}
    targets = {}
    for material in sorted(materials, key=lambda m: m.name):
        channels = baked_channels(material)
        if channels:
            targets[material] = channels
    if not targets:
        return {channel: [] for channel in CHANNEL_IMAGES}
    meshes = [o for o in objects if o.type == 'MESH' and any(s.material in targets for s in o.material_slots)]
    if not meshes:
        raise ValueError('Procedural materials have no directly bakeable meshes')
    uv_name = 'AssetHubBaseColor'
    for obj in meshes:
        if obj.data.shape_keys or any(m.type == 'ARMATURE' for m in obj.modifiers):
            raise ValueError('Bake rigged procedural materials in the authoring pipeline: ' + obj.name)
        obj.data = obj.data.copy()
        if obj.data.uv_layers.get(uv_name):
            raise ValueError('Reserved UV layer already exists: ' + uv_name)
        layer = obj.data.uv_layers.new(name=uv_name)
        obj.data.uv_layers.active = layer
    select(meshes)
    print('Unwrapping', len(meshes), 'meshes for', len(targets), 'materials', flush=True)
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=1.1519, margin_method='FRACTION', island_margin=2 / size)
    bpy.ops.object.mode_set(mode='OBJECT')

    needed = set().union(*targets.values())
    images = {}
    for channel in needed:
        name, colorspace = CHANNEL_IMAGES[channel]
        image = bpy.data.images.new(name, width=size, height=size, alpha=False)
        image.colorspace_settings.name = colorspace
        images[channel] = image
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 1
    scene.render.bake.use_clear = False
    scene.render.bake.use_selected_to_active = False
    scene.render.bake.margin = 16
    scene.render.bake.margin_type = 'EXTEND'

    involved = {s.material for o in meshes for s in o.material_slots if s.material}
    for material in involved:
        if not material.use_nodes:
            raise ValueError('Mixed non-node material cannot be baked: ' + material.name)
    # Every material on the baked meshes needs an active bake target per pass.
    textures = {}
    for material in involved:
        for channel, image in images.items():
            texture = material.node_tree.nodes.new('ShaderNodeTexImage')
            texture.image = image
            textures[(material, channel)] = texture
    helper = joined_bake_mesh(meshes) if needed - {'normal'} else None
    bake_materials = [m for m in helper.data.materials if m] if helper else list(involved)

    def set_active(channel, materials):
        for material in materials:
            for node in material.node_tree.nodes:
                if node.type == 'TEX_IMAGE' and node.image == images[channel]:
                    material.node_tree.nodes.active = node
                    break

    try:
        for channel in ['color', 'roughness', 'metallic']:
            if channel not in images:
                continue
            print('Baking', channel, size, 'px', flush=True)
            set_active(channel, bake_materials)
            saved = []
            # Emission bakes the channel expression itself, without lighting.
            for material in bake_materials:
                if channel not in baked_channels(material):
                    continue
                output, shader = principled_shader(material)
                nodes, links = material.node_tree.nodes, material.node_tree.links
                emission = nodes.new('ShaderNodeEmission')
                source = shader.inputs[CHANNEL_SOCKETS[channel]]
                value = source.links[0].from_socket
                scalar = None
                if channel != 'color':
                    # A float socket preserves Blender's color-to-value conversion.
                    scalar = nodes.new('ShaderNodeMath')
                    scalar.operation = 'MULTIPLY'
                    scalar.inputs[1].default_value = 1
                    scalar.use_clamp = True
                    links.new(value, scalar.inputs[0])
                    value = scalar.outputs[0]
                links.new(value, emission.inputs['Color'])
                links.new(emission.outputs[0], output.inputs['Surface'])
                saved.append((material, output, shader, emission, scalar))
            try:
                bpy.ops.object.bake(type='EMIT', uv_layer=uv_name)
            finally:
                for material, output, shader, emission, scalar in saved:
                    nodes, links = material.node_tree.nodes, material.node_tree.links
                    links.new(shader.outputs[0], output.inputs['Surface'])
                    nodes.remove(emission)
                    if scalar:
                        nodes.remove(scalar)
    finally:
        if helper:
            bpy.data.objects.remove(helper, do_unlink=True)
    if 'normal' in images:
        print('Baking normal', size, 'px', flush=True)
        set_active('normal', involved)
        scene.render.bake.normal_space = 'TANGENT'
        scene.render.bake.normal_r = 'POS_X'
        scene.render.bake.normal_g = 'POS_Y'
        scene.render.bake.normal_b = 'POS_Z'
        # Separate passes must keep padding inside the atlas's two-pixel island gap.
        scene.render.bake.margin = 1
        # Equal linear transforms preserve tangent space when joining translated parts.
        groups = {}
        for obj in meshes:
            basis = tuple(value for row in obj.matrix_world.to_3x3() for value in row)
            groups.setdefault(basis, []).append(obj)
        for group in groups.values():
            helper = joined_bake_mesh(group) if len(group) > 1 else None
            if helper:
                try:
                    set_active('normal', [m for m in helper.data.materials if m])
                    bpy.ops.object.bake(type='NORMAL', uv_layer=uv_name)
                finally:
                    bpy.data.objects.remove(helper, do_unlink=True)
            else:
                for obj in group:
                    select([obj])
                    bpy.ops.object.bake(type='NORMAL', uv_layer=uv_name)
    print('PBR channels baked', flush=True)

    for material, channels in targets.items():
        nodes, links = material.node_tree.nodes, material.node_tree.links
        _, shader = principled_shader(material)
        uv = nodes.new('ShaderNodeUVMap')
        uv.uv_map = uv_name
        for channel in channels:
            texture = textures[(material, channel)]
            links.new(uv.outputs['UV'], texture.inputs['Vector'])
            if channel == 'normal':
                normal_map = nodes.new('ShaderNodeNormalMap')
                normal_map.uv_map = uv_name
                links.new(texture.outputs['Color'], normal_map.inputs['Color'])
                links.new(normal_map.outputs['Normal'], shader.inputs['Normal'])
            else:
                links.new(texture.outputs['Color'], shader.inputs[CHANNEL_SOCKETS[channel]])
    for (material, channel), texture in textures.items():
        if channel not in targets.get(material, set()):
            material.node_tree.nodes.remove(texture)
    for image in images.values():
        image.pack()
    return {channel: sorted(m.name for m, c in targets.items() if channel in c) for channel in CHANNEL_IMAGES}


def export_blend(source, destination, exclude_prefixes=(), size=2048):
    source, destination = pathlib.Path(source).resolve(), pathlib.Path(destination).resolve()
    report_path = destination.with_suffix('.json')
    if destination.suffix.lower() != '.glb' or destination.exists() or report_path.exists():
        raise ValueError('Use a new .glb output path (and a new adjacent .json report path)')
    bpy.ops.wm.open_mainfile(filepath=str(source), use_scripts=False)
    missing = [lib.filepath for lib in bpy.data.libraries if not pathlib.Path(bpy.path.abspath(lib.filepath)).is_file()]
    missing += [im.filepath for im in bpy.data.images if im.source == 'FILE' and not im.packed_file and not pathlib.Path(bpy.path.abspath(im.filepath)).is_file()]
    if missing:
        raise ValueError('Missing source resources: ' + ', '.join(missing))
    excluded = {o for c in bpy.data.collections if any(c.name.upper().startswith(p.upper()) for p in exclude_prefixes) for o in c.all_objects}
    objects = [o for o in bpy.context.scene.objects if o not in excluded and not o.hide_render and o.type != 'CAMERA']
    if not objects:
        raise ValueError('No visible asset objects')
    bpy.context.scene.frame_set(bpy.context.scene.frame_start)
    instances = [o for o in objects if o.instance_type == 'COLLECTION' and o.instance_collection and any(
        slot.material and baked_channels(slot.material)
        for child in o.instance_collection.all_objects for slot in child.material_slots
    )]
    for obj in instances:
        if any(o.instance_type == 'COLLECTION' and o.instance_collection for o in obj.instance_collection.all_objects):
            raise ValueError('Realize nested collection instances in the authoring pipeline: ' + obj.name)
        if obj.animation_data or any(o.animation_data for o in obj.instance_collection.all_objects):
            raise ValueError('Realize animated collection instances in the authoring pipeline: ' + obj.name)
    instance_curves = 0
    if instances:
        instance_curves = realize_instances(instances)
        objects = [o for o in bpy.context.scene.objects if o not in excluded and not o.hide_render and o.type != 'CAMERA']
    curves = [o for o in objects if o.type in {'CURVE', 'SURFACE', 'FONT'}]
    if curves:
        select(curves)
        bpy.ops.object.convert(target='MESH')
        objects = [o for o in bpy.context.scene.objects if o not in excluded and not o.hide_render and o.type != 'CAMERA']
    baked = bake_base_colors(objects, size)
    # Blender cannot calculate n-gon tangents; triangulate after baking without saving the source.
    triangulated = 0
    depsgraph = bpy.context.evaluated_depsgraph_get()
    for obj in objects:
        if obj.type == 'MESH' and any(len(face.vertices) > 4 for face in obj.evaluated_get(depsgraph).data.polygons):
            modifier = obj.modifiers.new('Asset Hub export triangles', 'TRIANGULATE')
            modifier.min_vertices = 5
            triangulated += 1
    select(objects)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='asset-hub-export-', dir=destination.parent) as directory:
        temporary = pathlib.Path(directory) / destination.name
        bpy.ops.export_scene.gltf(
            filepath=str(temporary), export_format='GLB', use_selection=True,
            export_tangents=True,
            export_apply=True, export_animations=any(o.animation_data for o in objects),
            export_animation_mode='ACTIVE_ACTIONS', export_cameras=False, export_lights=True,
        )
        data = temporary.read_bytes()
        if data[:4] != b'glTF':
            raise ValueError('Exporter did not produce a GLB')
        report = {
            'blender': bpy.app.version_string,
            'exporterHash': hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),
            'sourceHash': hashlib.sha256(source.read_bytes()).hexdigest(),
            'glbHash': hashlib.sha256(data).hexdigest(),
            'animationMode': 'ACTIVE_ACTIONS',
            'excludedCollectionPrefixes': list(exclude_prefixes),
            'bakedBaseColorMaterials': baked['color'],
            'bakedRoughnessMaterials': baked['roughness'],
            'bakedMetallicMaterials': baked['metallic'],
            'bakedNormalMaterials': baked['normal'],
            'baseColorAtlasSize': size if any(baked.values()) else None,
            'selectedObjects': len(objects),
            'convertedCurves': len(curves) + instance_curves,
            'realizedInstances': len(instances),
            'triangulatedMeshes': triangulated,
            'limitations': 'Procedural base color, roughness, metallic and normals baked at the first frame. Procedural volumes, subsurface, transmission and animated shader expressions are not baked.',
        }
        with destination.open('xb') as stream:
            stream.write(data)
        with report_path.open('x') as stream:
            json.dump(report, stream, ensure_ascii=False, indent=2)
            stream.write('\n')
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source')
    parser.add_argument('output')
    parser.add_argument('--exclude-collection-prefix', action='append', default=[])
    parser.add_argument('--size', type=int, choices=[512, 1024, 2048, 4096], default=2048)
    args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:])
    print(json.dumps(export_blend(args.source, args.output, args.exclude_collection_prefix, args.size), ensure_ascii=False))
