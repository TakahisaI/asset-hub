import { z } from 'zod';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const file = z
  .object({
    name: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[^/\\\x00-\x1f]+$/),
    hash,
  })
  .strict();
export const vfxInfoSchema = z
  .object({
    runtime: hash,
    source: file.refine((f) => /\.blend$/i.test(f.name), 'Blender原本のファイル名が必要です'),
    preview: file.refine((f) => /\.mp4$/i.test(f.name), 'MP4動画のファイル名が必要です').optional(),
    limitations: z.string().min(1).max(4000),
  })
  .strict();
const values = z.array(z.number().finite().min(0).max(10000)).min(2).max(10000);
const color = z.tuple([
  z.number().min(0).max(1),
  z.number().min(0).max(1),
  z.number().min(0).max(1),
]);
export const vfxSchema = vfxInfoSchema
  .extend({
    schema: z.literal(1),
    clip: z.number().int().nonnegative(),
    posterTime: z.number().finite().nonnegative(),
    times: z.array(z.number().finite().nonnegative()).min(2).max(10000),
    smoke: z
      .array(
        z
          .object({
            material: z.number().int().nonnegative(),
            color,
            noiseScale: z.number().finite().positive().max(100),
            threshold: z.number().finite().min(0).max(1),
            density: values,
          })
          .strict(),
      )
      .max(200),
    emission: z
      .array(
        z.object({ material: z.number().int().nonnegative(), color, strength: values }).strict(),
      )
      .max(200),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.times.some((t, i) => i > 0 && t <= v.times[i - 1]))
      ctx.addIssue({ code: 'custom', message: 'VFXの時刻は昇順で指定してください' });
    if (v.posterTime > v.times.at(-1)!)
      ctx.addIssue({ code: 'custom', message: 'VFXの確認時刻が範囲外です' });
    for (const track of [...v.smoke, ...v.emission])
      if (('density' in track ? track.density : track.strength).length !== v.times.length)
        ctx.addIssue({ code: 'custom', message: 'VFXの時刻と値の数が一致しません' });
    const materials = [...v.smoke, ...v.emission].map((t) => t.material);
    if (new Set(materials).size !== materials.length)
      ctx.addIssue({ code: 'custom', message: 'VFXの材質指定が重複しています' });
  });
export type Vfx = z.infer<typeof vfxSchema>;
