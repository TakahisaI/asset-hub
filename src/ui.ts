export const fmt = (n: number) => new Intl.NumberFormat('ja-JP').format(n);
export const mb = (n: number) =>
  n < 1e6 ? (n / 1000).toFixed(0) + ' KB' : (n / 1e6).toFixed(1) + ' MB';
export async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const r = await fetch(url, options);
  const data = await r.json();
  if (!r.ok) throw new Error(data.error ?? '通信に失敗しました');
  return data;
}
export function saveFile(name: string, data: unknown) {
  const url = URL.createObjectURL(
    new Blob([typeof data === 'string' ? data : JSON.stringify(data, null, 2)], {
      type: 'application/json',
    }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
