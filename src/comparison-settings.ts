import { z } from 'zod';
import { hashSchema, idSchema } from './schema.ts';

const vector = z.tuple([z.number(), z.number(), z.number()]);
const reference = z.object({ id: idSchema, revision: hashSchema }).strict();
export const comparisonSettingsSchema = z
  .object({
    schema: z.literal(1),
    left: reference,
    right: reference,
    displayed: z.enum(['A', 'B']),
    pose: z.literal('rest'),
    mode: z.enum(['pbr', 'normal', 'wireframe']),
    lighting: z.enum(['studio', 'dark', 'flat', 'night']),
    grid: z.boolean(),
    camera: z
      .object({
        position: vector,
        target: vector,
        up: vector,
        fov: z.number().gt(0).lt(180),
        near: z.number().positive(),
        far: z.number().positive(),
        aspect: z.number().positive(),
      })
      .strict()
      .superRefine((c, ctx) => {
        const direction = c.target.map((n, i) => n - c.position[i]);
        const distance = Math.hypot(...direction),
          upLength = Math.hypot(...c.up);
        const d = direction.map((n) => n / distance),
          u = c.up.map((n) => n / upLength);
        const cross = Math.hypot(
          d[1] * u[2] - d[2] * u[1],
          d[2] * u[0] - d[0] * u[2],
          d[0] * u[1] - d[1] * u[0],
        );
        if (
          !Number.isFinite(distance) ||
          distance === 0 ||
          !Number.isFinite(upLength) ||
          upLength === 0 ||
          !Number.isFinite(cross) ||
          cross === 0 ||
          c.far <= c.near
        )
          ctx.addIssue({
            code: 'custom',
            message: 'カメラの位置・ターゲット・上方向、またはnear/farが不正です。',
          });
      }),
    viewport: z
      .object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        pixelRatio: z.number().positive().max(2),
        bufferWidth: z.number().int().positive(),
        bufferHeight: z.number().int().positive(),
      })
      .strict(),
    background: z.string().regex(/^#[0-9a-f]{6}$/i),
    embeddedLights: z.literal(false),
    three: z.string().min(1),
    outputColorSpace: z.literal('srgb'),
    toneMapping: z.literal(4),
    exposure: z.number().positive(),
    profiles: z
      .array(z.object({ tool: z.string(), measuredAt: z.iso.datetime() }).strict().nullable())
      .length(2),
  })
  .strict();
export type ComparisonSettings = z.infer<typeof comparisonSettingsSchema>;
export function readComparisonSettings(text: string) {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('JSONの形式が不正です。');
  }
  const parsed = comparisonSettingsSchema.safeParse(value);
  if (!parsed.success)
    throw new Error(
      '比較条件が不正です: ' +
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' / '),
    );
  return parsed.data;
}
