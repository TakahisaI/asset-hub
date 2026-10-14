import { chromium } from 'playwright';
import { exists } from '../server/store.ts';
export async function browser() {
  const explicit = process.env.CHROMIUM_EXECUTABLE;
  if (explicit && !(await exists(explicit)))
    throw new Error('CHROMIUM_EXECUTABLE が見つかりません: ' + explicit);
  const chrome =
    explicit ??
    (process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : undefined);
  return chromium.launch({
    headless: true,
    ...(chrome && (await exists(chrome)) ? { executablePath: chrome } : {}),
    args: ['--no-sandbox'],
  });
}
