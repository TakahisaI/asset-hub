import { useEffect, useState, type RefObject } from 'react';
import { Camera, Download, MessageSquare, Plus } from 'lucide-react';
import type { AssetViewer } from './viewer.ts';
import type { CatalogAsset, ReviewNote } from './schema.ts';
import { api, saveFile } from './ui.ts';

export function useAssetNotes(
  a: CatalogAsset,
  viewer: RefObject<AssetViewer | null>,
  ready: boolean,
  onUpdate: () => Promise<void>,
  notify: (s: string) => void,
) {
  const [notes, setNotes] = useState<ReviewNote[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const loadNotes = () =>
    api<ReviewNote[]>(`/api/assets/${a.id}/notes`)
      .then(setNotes)
      .catch((e) => setError(e.message));
  useEffect(() => {
    void loadNotes();
  }, [a.id]);
  async function addNote() {
    setBusy(true);
    setError('');
    try {
      await api(`/api/assets/${a.id}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          revision: a.revision,
          text: note,
          ...(ready
            ? { camera: viewer.current?.cameraState(), playback: viewer.current?.playbackState() }
            : {}),
        }),
      });
      setNote('');
      await loadNotes();
      await onUpdate();
      notify('確認メモを保存しました');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function toggleNote(n: ReviewNote) {
    setBusy(true);
    setError('');
    try {
      await api(`/api/assets/${a.id}/notes/${n.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolved: !n.resolved }),
      });
      await loadNotes();
      await onUpdate();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return { notes, note, setNote, busy, error, addNote, toggleNote };
}

export function NotesPanel({
  asset: a,
  currentAsset,
  review,
  canRestore,
  onRestore,
}: {
  asset: CatalogAsset;
  currentAsset: CatalogAsset;
  review: ReturnType<typeof useAssetNotes>;
  canRestore: boolean;
  onRestore: (note: ReviewNote) => void;
}) {
  const { notes, note, setNote, busy, error, addNote, toggleNote } = review;
  return (
    <div className="inspector-body">
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <p className="description">気づいたことを、今見ている版とカメラ位置に添えて保存できます。</p>
      <textarea
        className="note-input"
        placeholder="形状、質感、サイズなど、気づいたこと…"
        aria-label="確認メモ"
        rows={5}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <button className="primary full" disabled={busy || !note.trim()} onClick={addNote}>
        <Plus size={16} />
        {busy ? '保存中…' : '確認メモを保存'}
      </button>
      <p className="subtle">このPCのJSONファイルに保存されます。</p>
      <div className="notes-list">
        {notes.length === 0 ? (
          <div className="notes-empty">
            <MessageSquare size={25} />
            <p>まだ確認メモはありません</p>
          </div>
        ) : (
          notes.map((n) => (
            <article className={'note ' + (n.resolved ? 'resolved' : '')} key={n.id}>
              <div className="note-date">
                {new Date(n.createdAt).toLocaleString('ja-JP')}
                <span>{n.resolved ? '解決済み' : '未解決'}</span>
              </div>
              <p>{n.text}</p>
              <div className="note-revision">
                版 {n.revision.slice(0, 10)}
                {n.revision !== currentAsset.revision ? ' · 旧版へのメモ' : ''}
                {n.playback &&
                  ` · ${n.playback.preset ?? 'clip ' + n.playback.clip} / ${n.playback.time.toFixed(2)}秒`}
                {n.playback?.behavior && n.playback.behavior !== currentAsset.behavior
                  ? ' · 旧動作設定'
                  : ''}
              </div>
              <div className="note-actions">
                {(n.camera || n.playback || n.revision !== a.revision) && (
                  <button
                    disabled={
                      !canRestore &&
                      n.revision === a.revision &&
                      (!n.playback?.behavior || n.playback.behavior === a.behavior)
                    }
                    onClick={() => onRestore(n)}
                  >
                    <Camera size={12} />
                    {n.revision !== a.revision ||
                    (!!n.playback?.behavior && n.playback.behavior !== a.behavior)
                      ? 'この版の状態を開く'
                      : '視点を復元'}
                  </button>
                )}
                <button disabled={busy} onClick={() => toggleNote(n)}>
                  {n.resolved ? '再オープン' : '解決済みにする'}
                </button>
              </div>
            </article>
          ))
        )}
      </div>
      {notes.length > 0 && (
        <button
          className="secondary full"
          onClick={() => saveFile(a.id + '.review.json', { schema: 1, assetId: a.id, notes })}
        >
          <Download size={14} />
          メモを書き出す
        </button>
      )}
    </div>
  );
}
