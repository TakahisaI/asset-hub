import { chromium } from 'playwright';
import { access } from 'node:fs/promises';
const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );
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
