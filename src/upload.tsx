import { useState } from 'react';
import { UploadCloud } from 'lucide-react';
import type { Asset } from './schema.ts';
export function Upload({ onDone }: { onDone: (id: string) => void }) {
  const [file, setFile] = useState<File | null>(null),
    [id, setId] = useState(''),
    [name, setName] = useState(''),
    [collection, setCollection] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  function choose(file: File) {
    setFile(file);
    const stem = file.name.replace(/\.glb$/i, '');
    setName(stem);
    const slug = stem
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    setId('local.' + (slug || 'asset-' + Date.now().toString(36)));
    setError('');
  }
  async function submit() {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const current = await fetch('/api/assets/' + encodeURIComponent(id));
      if (!current.ok && current.status !== 404) throw new Error('現在の登録情報を確認できません');
      const previous: Asset | undefined = current.ok ? await current.json() : undefined;
      const query = new URLSearchParams({ name, collection, filename: file.name });
      const res = await fetch('/api/import/' + encodeURIComponent(id) + '?' + query, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          ...(previous ? { 'If-Match': previous.updatedAt } : {}),
        },
        body: file,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      onDone(data.id);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  return (
    <div className="upload-form">
      <label
        className="upload-drop"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (e.dataTransfer.files[0]) choose(e.dataTransfer.files[0]);
        }}
      >
        <UploadCloud size={25} />
        <strong>{file ? file.name : 'GLBファイルを選択・ドロップ'}</strong>
        <span>最大100 MB · テクスチャを埋め込んだGLB</span>
        <input
          aria-label="GLBファイル"
          type="file"
          accept=".glb"
          onChange={(e) => {
            if (e.target.files?.[0]) choose(e.target.files[0]);
          }}
        />
      </label>
      <div className="edit-form">
        <label>
          名前
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="木の箱" />
        </label>
        <label>
          アセットID
          <input
            value={id}
            onChange={(e) => setId(e.target.value)}
            placeholder="prop.wooden-crate"
            pattern="[a-z0-9][a-z0-9._-]{0,159}"
          />
        </label>
        <label>
          コレクション（任意）
          <input value={collection} onChange={(e) => setCollection(e.target.value)} />
        </label>
      </div>
      <p className="subtle">
        IDは後から名前やフォルダを変えても維持する識別子です。同じIDで取り込むと新しい版を追加し、既存のメモと旧版を保持します。
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button
        className="primary full"
        onClick={submit}
        disabled={busy || !file || !name.trim() || !/^[a-z0-9][a-z0-9._-]{0,159}$/.test(id)}
      >
        {busy ? '検証・保存中…' : 'ライブラリに登録'}
      </button>
    </div>
  );
}
