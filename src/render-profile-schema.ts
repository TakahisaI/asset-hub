import { z } from 'zod';
import { hashSchema } from './schema.ts';
// Bump when the meaning of any field changes. Profiles measured by different tools are not comparable.
export const renderProfileTool = 'render-profile/1';
const count = z.number().int().nonnegative();
export const renderProfileSchema = z
  .object({
    schema: z.literal(1),
    tool: z.literal(renderProfileTool),
    measuredAt: z.iso.datetime(),
    glb: z.object({ hash: hashSchema, bytes: count }).strict(),
    scene: z
      .object({
        nodes: count,
        meshes: count,
        meshInstances: count,
        primitives: count,
        drawCalls: count,
        materials: count,
        doubleSidedMaterials: count,
      })
      .strict(),
    geometry: z
      .object({
        triangles: count,
        trianglesDrawn: count,
        vertices: count,
        vertexBytes: count,
        indexBytes: count,
      })
      .strict(),
    attributes: z
      .object({
        primitivesWithUv: count,
        primitivesWithTangent: count,
        tangentBytesUnused: count,
        primitivesWithColor: count,
        primitivesWithSkin: count,
      })
      .strict(),
    textures: z
      .object({
        count: count,
        bytes: count,
        decodedBytes: count,
        maxEdge: count,
        items: z
          .array(
            z
              .object({
                name: z.string().optional(),
                mimeType: z.string(),
                bytes: count,
                width: count,
                height: count,
              })
              .strict(),
          )
          .max(256),
      })
      .strict(),
    byMaterial: z
      .array(
        z
          .object({
            name: z.string(),
            drawCalls: count,
            triangles: count,
            doubleSided: z.boolean(),
          })
          .strict(),
      )
      .max(256),
  })
  .strict();
export type RenderProfile = z.infer<typeof renderProfileSchema>;
