import { useState, useEffect, useRef, type ReactNode } from 'react';
import {
  Box,
  FileJson,
  Grid3X3,
  Orbit,
  Download,
  ArrowUpRight,
  ArrowLeft,
  Copy,
  MessageSquare,
  ExternalLink,
  FolderOpen,
  AlertCircle,
  RotateCcw,
  Camera,
  LoaderCircle,
} from 'lucide-react';
import type { AssetViewer } from './viewer.ts';
import {
  categories,
  sourceUrl,
  type CatalogAsset,
  type Asset,
  type Behavior,
  type ReviewNote,
} from './schema.ts';
import { PlaybackControls } from './playback-controls.tsx';
import { fmt, mb, api, saveFile } from './ui.ts';
import { useAssetNotes, NotesPanel } from './notes.tsx';
import { QualityCheck } from './quality-check.tsx';
import { ProfilePanel } from './render-profile.tsx';
type DetailProps = {
  asset: CatalogAsset;
  onBack: () => void;
  onUpdate: () => Promise<void>;
  notify: (s: string) => void;
};
type Revision = Asset & Pick<CatalogAsset, 'available' | 'thumbnail' | 'profile' | 'profileError'>;

export function Detail(props: DetailProps) {
  const [revisions, setRevisions] = useState<Revision[]>([]),
    [selected, setSelected] = useState<{ asset: CatalogAsset; note?: ReviewNote } | null>(null),
    [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    void api<Revision[]>(`/api/assets/${props.asset.id}/revisions`)
      .then((items) => {
        if (!cancelled) setRevisions(items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [props.asset.id, props.asset.revision]);
  const a = selected ? { ...selected.asset, notesCount: props.asset.notesCount } : props.asset;
  return (
    <DetailView
      {...props}
      asset={a}
      currentAsset={props.asset}
      readOnly={!!selected}
      initialNote={selected?.note}
      onOpenNote={(note) => {
        const revision =
          note.revision === props.asset.revision
            ? props.asset
            : revisions.find((r) => r.revision === note.revision);
        if (!revision) {
          setError('メモが参照する版を読み込めません。履歴と保存データを確認してください。');
          return;
        }
        setError('');
        setSelected({
          asset: { ...props.asset, ...revision, behavior: note.playback?.behavior },
          note,
        });
      }}
      history={
        <div className="revision-browser">
          <label>
            表示する版
            <select
              aria-label="表示する版"
              value={a.revision}
              onChange={(e) => {
                setError('');
                const revision = revisions.find((r) => r.revision === e.target.value);
                setSelected(
                  e.target.value === props.asset.revision || !revision
                    ? null
                    : { asset: { ...props.asset, ...revision, behavior: revision.behavior } },
                );
              }}
            >
              <option value={props.asset.revision}>
                現在版 · {props.asset.revision.slice(0, 12)}
              </option>
              {revisions
                .filter((r) => r.revision !== props.asset.revision)
                .map((r) => (
                  <option key={r.revision} value={r.revision}>
                    {new Date(r.updatedAt).toLocaleString('ja-JP')} · {r.revision.slice(0, 12)}
                    {!r.available ? ' · GLB欠落' : ''}
                  </option>
                ))}
            </select>
          </label>
          {selected && (
            <>
              <span>履歴を閲覧中 · 現在の登録内容は変更しません</span>
              <button className="secondary" onClick={() => setSelected(null)}>
                現在版へ戻る
              </button>
            </>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </div>
      }
    />
  );
}

function DetailView({
  asset: a,
  currentAsset,
  onBack,
  onUpdate,
  notify,
  readOnly,
  initialNote,
  onOpenNote,
  history,
}: DetailProps & {
  currentAsset: CatalogAsset;
  readOnly: boolean;
  initialNote?: ReviewNote;
  onOpenNote: (note: ReviewNote) => void;
  history: ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null),
    viewer = useRef<AssetViewer | null>(null);
  const viewerKey = `${a.revision}:${a.behavior ?? ''}:${initialNote?.id ?? ''}:${readOnly}`;
  const [readyKey, setReadyKey] = useState(''),
    [loadError, setLoadError] = useState(''),
    [tab, setTab] = useState(initialNote ? 'notes' : 'info'),
    [mode, setMode] = useState('pbr'),
    [lighting, setLighting] = useState(a.vfx ? 'dark' : 'studio'),
    [dimensions, setDimensions] = useState(''),
    [busy, setBusy] = useState(false),
    [edit, setEdit] = useState(false),
    [draft, setDraft] = useState({
      name: a.name,
      description: a.description,
      tags: a.tags.join(', '),
      collections: a.collections.join(', '),
      license: a.license,
      category: a.category,
    }),
    [formError, setFormError] = useState('');
  const [requestedKey, setRequestedKey] = useState('');
  const ready = readyKey === viewerKey,
    loadRequested =
      requestedKey === viewerKey ||
      !!initialNote ||
      (a.file.bytes < 25_000_000 && a.metrics.triangles < 500_000);
  const review = useAssetNotes(a, viewer, ready, onUpdate, notify);
  useEffect(() => {
    setReadyKey('');
    setLoadError('');
    setFormError('');
    setDimensions('');
    setMode('pbr');
    setLighting(a.vfx ? 'dark' : 'studio');
    if (!loadRequested) return;
    let v: AssetViewer | undefined,
      cancelled = false;
    void import('./viewer.ts')
      .then(async ({ AssetViewer }) => {
        if (cancelled) return;
        v = new AssetViewer(host.current!);
        viewer.current = v;
        await v.load('/api/files/' + a.file.hash);
        if (cancelled) return;
        if (a.behavior) {
          try {
            const behavior = await api<Behavior>('/api/behaviors/' + a.behavior);
            if (cancelled) return;
            if (behavior.assetId !== a.id || behavior.modelRevision !== a.revision)
              throw new Error('動作設定が表示中の版と一致しません。');
            v.behavior = behavior;
            v.behaviorHash = a.behavior;
          } catch (error) {
            if (!cancelled) setFormError((error as Error).message);
          }
        }
        if (initialNote) {
          try {
            if (initialNote.playback) await v.restorePlayback(initialNote.playback);
            if (cancelled) return;
            if (initialNote.camera) v.restore(initialNote.camera);
          } catch (error) {
            if (!cancelled) setFormError((error as Error).message);
          }
        }
        if (cancelled) return;
        setReadyKey(viewerKey);
        setDimensions(
          v.size
            .toArray()
            .map((n) => n.toFixed(2))
            .join(' × '),
        );
        if (!a.thumbnail && !readOnly) {
          try {
            const grid = v.grid;
            if (grid) grid.visible = false;
            const shot = v.capture();
            if (grid) grid.visible = true;
            const blob = await (await fetch(shot)).blob();
            const response = await fetch(`/api/assets/${a.id}/thumbnail/${a.file.hash}`, {
              method: 'POST',
              headers: { 'Content-Type': 'image/png' },
              body: blob,
            });
            if (!response.ok) throw new Error('プレビュー画像を保存できませんでした');
            if (!cancelled) await onUpdate();
          } catch (e) {
            if (!cancelled) setFormError((e as Error).message);
          }
        }
      })
      .catch((e) => {
        if (!cancelled) setLoadError(e.message);
      });
    return () => {
      cancelled = true;
      v?.dispose();
      viewer.current = null;
    };
  }, [viewerKey, loadRequested]);
  async function saveEdit() {
    setBusy(true);
    setFormError('');
    try {
      await api(`/api/assets/${a.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'If-Match': a.updatedAt },
        body: JSON.stringify({
          ...draft,
          tags: draft.tags
            .split(/[,、]/)
            .map((x) => x.trim())
            .filter(Boolean),
          collections: draft.collections
            .split(/[,、]/)
            .map((x) => x.trim())
            .filter(Boolean),
        }),
      });
      await onUpdate();
      setEdit(false);
      notify('アセット情報を保存しました');
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      notify('コピーしました');
    } catch {
      setFormError('クリップボードを利用できません。IDを選択してコピーしてください');
    }
  }
  return (
    <div className="detail">
      <button className="back-link" onClick={onBack}>
        <ArrowLeft size={15} />
        ライブラリに戻る
      </button>
      <div className="detail-heading">
        <div>
          <div className="eyebrow">{a.collections.join(' / ')}</div>
          <h1>{a.name}</h1>
          <button className="id-copy" onClick={() => copy(a.id)}>
            {a.id}
            <Copy size={12} />
          </button>
        </div>
        <div className="detail-actions">
          {!readOnly && (
            <button
              className="secondary"
              onClick={async () => {
                try {
                  saveFile('assets.lock.json', await api(`/api/assets/${a.id}/lock`));
                } catch (error) {
                  setFormError((error as Error).message);
                }
              }}
            >
              <FileJson size={16} />
              固定版を参照
            </button>
          )}
          <a
            className={'primary ' + (!a.available ? 'disabled' : '')}
            href={readOnly ? '/api/files/' + a.file.hash : `/api/assets/${a.id}/download`}
            download={a.id + '.glb'}
          >
            <Download size={16} />
            GLBを取得
          </a>
          {a.vfx && (
            <>
              <a
                className="secondary"
                href={`/api/assets/${a.id}/revisions/${a.revision}/vfx/runtime`}
                download
              >
                Three.js用ローダーを取得
              </a>
              <a
                className="secondary"
                href={`/api/assets/${a.id}/revisions/${a.revision}/vfx/source`}
                download
              >
                Blender原本を取得
              </a>
            </>
          )}
        </div>
      </div>
      {history}
      {a.vfx && (
        <p className="snapshot-note">
          <strong>Three.js VFX</strong>
          <br />
          {a.vfx.limitations}
          <br />
          持ち出し先でもThree.js用ローダーが必要です。「固定版を参照」とCLIのsyncではGLBとローダーを一緒に取得できます。
        </p>
      )}
      {a.behavior && (
        <p className="subtle">
          {readOnly
            ? '回転・点灯などの動作設定はGLB単体には含まれません。'
            : '回転・点灯などの動作設定は「固定版を参照」とCLIのsyncで取得できます。GLB単体には含まれません。'}
        </p>
      )}
      <div className="detail-layout">
        <section className="viewer-panel" key={viewerKey}>
          <div className="viewer-top">
            <span>
              <span className="online" />
              3D INSPECTOR
            </span>
            <div className="view-modes" role="group" aria-label="表示モード">
              {[
                { key: 'pbr', label: 'マテリアル', Icon: Box },
                { key: 'wireframe', label: 'ワイヤーフレーム', Icon: Grid3X3 },
                { key: 'normal', label: '法線', Icon: Orbit },
              ].map(({ key, label, Icon }) => (
                <button
                  key={key}
                  type="button"
                  aria-label={label}
                  title={label}
                  aria-pressed={mode === key}
                  disabled={!ready}
                  onClick={() => {
                    setMode(key);
                    viewer.current?.mode(key);
                  }}
                >
                  <Icon size={16} />
                  <span>{label}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="viewport" ref={host}>
            {!ready && (
              <div className="viewer-state">
                {!loadRequested ? (
                  <>
                    {a.thumbnail && (
                      <img
                        className="viewer-preview"
                        src={'/api/thumbnails/' + a.file.hash}
                        alt={a.name}
                      />
                    )}
                    <div className="load-preview">
                      <strong>3Dプレビュー</strong>
                      <p>サイズの大きいモデルです。必要なときに読み込めます。</p>
                      <button className="primary" onClick={() => setRequestedKey(viewerKey)}>
                        3Dモデルを読み込む（{mb(a.file.bytes)}）
                      </button>
                    </div>
                  </>
                ) : loadError ? (
                  <>
                    <AlertCircle />
                    <strong>モデルを表示できません</strong>
                    <span>{loadError}</span>
                  </>
                ) : (
                  <>
                    <LoaderCircle className="spin" />
                    3Dモデルを読み込み中…
                  </>
                )}
              </div>
            )}
          </div>
          <div className="viewer-bottom">
            <div className="camera-buttons">
              {[
                ['perspective', '全体'],
                ['front', '正面'],
                ['side', '側面'],
                ['top', '上面'],
              ].map(([key, label]) => (
                <button
                  key={key}
                  disabled={!ready}
                  onClick={() => viewer.current?.fit(key as 'front')}
                >
                  {label}
                </button>
              ))}
              <button
                disabled={!ready}
                title="カメラをリセット"
                aria-label="カメラをリセット"
                onClick={() => viewer.current?.fit()}
              >
                <RotateCcw size={14} />
              </button>
            </div>
            <button
              title="確認画像を保存"
              aria-label="確認画像を保存"
              disabled={!ready}
              onClick={() => {
                const link = document.createElement('a');
                link.href = viewer.current!.capture();
                link.download = a.id + '.png';
                link.click();
              }}
            >
              <Camera size={16} />
            </button>
          </div>
          <div className="viewer-options">
            <label>
              <input
                type="checkbox"
                disabled={!ready}
                defaultChecked={!a.vfx}
                onChange={(e) => {
                  if (viewer.current?.grid) viewer.current.grid.visible = e.target.checked;
                }}
              />
              グリッド
            </label>
            <label>
              <input
                type="checkbox"
                disabled={!ready}
                onChange={(e) => {
                  if (viewer.current?.box) viewer.current.box.visible = e.target.checked;
                }}
              />
              寸法枠
            </label>
            <label>
              <input
                type="checkbox"
                disabled={!ready}
                onChange={(e) => {
                  if (viewer.current?.axes) viewer.current.axes.visible = e.target.checked;
                }}
              />
              原点
            </label>
            <select
              aria-label="照明"
              disabled={!ready}
              value={lighting}
              onChange={(e) => {
                setLighting(e.target.value);
                viewer.current?.lighting(e.target.value);
              }}
            >
              <option value="studio">スタジオ照明</option>
              <option value="dark">暗い背景</option>
              <option value="flat">曇天</option>
              <option value="night">夜間</option>
            </select>
            <label>
              <input
                type="checkbox"
                disabled={!ready}
                onChange={(e) => {
                  if (viewer.current?.ground) viewer.current.ground.visible = e.target.checked;
                }}
              />
              照射確認面
            </label>
          </div>
          <PlaybackControls viewer={viewer} ready={ready} />
          <div className="interaction-hint">
            ドラッグで回転 · スクロールで拡大 · 右ドラッグで移動
          </div>
          <div className="metrics-strip" aria-label="取込時の構造">
            <div>
              <small>三角形</small>
              <strong>{fmt(a.metrics.triangles)}</strong>
            </div>
            <div>
              <small>メッシュ</small>
              <strong>{fmt(a.metrics.meshes)}</strong>
            </div>
            <div>
              <small>マテリアル</small>
              <strong>{fmt(a.metrics.materials)}</strong>
            </div>
            <div>
              <small>ファイル</small>
              <strong>{mb(a.file.bytes)}</strong>
            </div>
          </div>
          <ProfilePanel
            profile={a.profile}
            error={a.profileError}
            current={currentAsset.profile}
            compare={readOnly}
          />
        </section>
        <aside className="inspector">
          <div className="inspector-tabs">
            <button className={tab === 'info' ? 'active' : ''} onClick={() => setTab('info')}>
              アセット情報
            </button>
            <button className={tab === 'notes' ? 'active' : ''} onClick={() => setTab('notes')}>
              確認メモ <span>{review.notes.length}</span>
            </button>
          </div>
          {formError && (
            <p role="alert" className="form-error">
              {formError}
            </p>
          )}
          {tab === 'info' ? (
            <div className="inspector-body">
              <div className="status-row">
                <span className="asset-note-count">
                  {a.notesCount > 0 ? (
                    <>
                      <MessageSquare size={11} />
                      {a.notesCount} メモ
                    </>
                  ) : (
                    <>
                      <Box size={11} />
                      {a.vfx ? 'Three.js VFX' : '3Dモデル'}
                    </>
                  )}
                </span>
                {!readOnly && (
                  <button
                    onClick={() => {
                      setEdit(!edit);
                      setFormError('');
                    }}
                  >
                    {edit ? 'キャンセル' : '情報を編集'}
                  </button>
                )}
              </div>
              {edit && !readOnly ? (
                <div className="edit-form">
                  <label>
                    名前
                    <input
                      value={draft.name}
                      onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    />
                  </label>
                  <label>
                    説明
                    <textarea
                      rows={4}
                      value={draft.description}
                      onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                    />
                  </label>
                  <label>
                    カテゴリ
                    <select
                      value={draft.category}
                      onChange={(e) =>
                        setDraft({ ...draft, category: e.target.value as Asset['category'] })
                      }
                    >
                      {Object.entries(categories).map(([key, label]) => (
                        <option key={key} value={key}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    タグ（カンマ区切り）
                    <input
                      value={draft.tags}
                      onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
                    />
                  </label>
                  <label>
                    プロジェクト・用途（カンマ区切り）
                    <small>複数指定できます。アセットのコピーは作りません。</small>
                    <input
                      value={draft.collections}
                      onChange={(e) => setDraft({ ...draft, collections: e.target.value })}
                    />
                  </label>
                  <label>
                    ライセンス・利用条件
                    <input
                      value={draft.license}
                      onChange={(e) => setDraft({ ...draft, license: e.target.value })}
                    />
                  </label>
                  <button
                    className="primary"
                    disabled={busy || !draft.name.trim()}
                    onClick={saveEdit}
                  >
                    {busy ? '保存中…' : '変更を保存'}
                  </button>
                </div>
              ) : (
                <>
                  <p className="description">{a.description}</p>
                  <div className="tag-list">
                    {a.tags.map((tag) => (
                      <span key={tag}>{tag}</span>
                    ))}
                  </div>
                  <div className="metadata">
                    <div>
                      <span>カテゴリ</span>
                      <b>{categories[a.category]}</b>
                    </div>
                    <div>
                      <span>制作形式</span>
                      <b>
                        {a.source.kind === 'blender'
                          ? 'Blender'
                          : a.source.kind === 'procedural'
                            ? '生成コード'
                            : 'GLBファイル'}
                      </b>
                    </div>
                    <div>
                      <span>寸法 X × Y × Z</span>
                      <b>
                        {dimensions || '—'}
                        <small>モデル座標値 / 単位は出典を確認</small>
                      </b>
                    </div>
                    <div>
                      <span>テクスチャ</span>
                      <b>{a.metrics.textures}</b>
                    </div>
                    <div>
                      <span>ライセンス</span>
                      <b>{a.license}</b>
                    </div>
                  </div>
                  <h3 className="section-label">品質チェック</h3>
                  <QualityCheck qa={a.qa} />
                  {a.vfx?.preview && (
                    <details className="qa-details">
                      <summary>Blenderの参考動画</summary>
                      <video
                        aria-label="Blenderの参考動画"
                        controls
                        preload="none"
                        src={`/api/assets/${a.id}/revisions/${a.revision}/vfx/preview`}
                        style={{ width: '100%' }}
                      />
                      <p>制作元での見え方です。上のThree.js表示とは照明や煙の表現が異なります。</p>
                    </details>
                  )}
                  {!!a.source.scope && (
                    <div className="snapshot-note">
                      <strong>収録範囲</strong>
                      <p>{a.source.scope}</p>
                    </div>
                  )}
                  {!!a.importWarnings?.length && (
                    <details className="qa-details">
                      <summary>書き出し時の変換・制限（{a.importWarnings.length}件）</summary>
                      {a.importWarnings.map((w) => (
                        <p key={w}>{w}</p>
                      ))}
                    </details>
                  )}
                  <h3 className="section-label">出典と固定版</h3>
                  <a
                    className="source-link"
                    href={a.source.repository === 'local' ? undefined : sourceUrl(a)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <FolderOpen size={16} />
                    <span>
                      {a.source.path.split('/').pop()}
                      <small>
                        {a.source.repository === 'local' ? a.source.path : '制作ソースを開く'}
                      </small>
                    </span>
                    <ArrowUpRight size={16} />
                  </a>
                  {a.source.specification && (
                    <a
                      className="text-link"
                      href={sourceUrl(a, a.source.specification)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      制作仕様
                      <ExternalLink size={12} />
                    </a>
                  )}
                  {a.source.verification && (
                    <a
                      className="text-link"
                      href={sourceUrl(a, a.source.verification)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      出典の検査記録
                      <ExternalLink size={12} />
                    </a>
                  )}
                  <div className="revision">
                    <span>COMMIT</span>
                    <code>{a.source.commit.slice(0, 12) || 'ローカルファイル'}</code>
                    <span>SHA-256</span>
                    <button title={a.revision} onClick={() => copy(a.revision)}>
                      <code>{a.revision.slice(0, 16)}…</code>
                      <Copy size={11} />
                    </button>
                  </div>
                  <details className="scope">
                    <summary>利用・統合時の注意</summary>
                    <p>{a.source.integrationNote || '出典の利用条件を確認してください。'}</p>
                  </details>
                </>
              )}
            </div>
          ) : (
            <NotesPanel
              asset={a}
              currentAsset={currentAsset}
              review={review}
              canRestore={ready}
              onRestore={async (note) => {
                if (
                  note.revision !== a.revision ||
                  (!!note.playback?.behavior && note.playback.behavior !== a.behavior)
                ) {
                  onOpenNote(note);
                  return;
                }
                try {
                  if (note.camera) viewer.current?.restore(note.camera);
                  if (note.playback) await viewer.current?.restorePlayback(note.playback);
                } catch (error) {
                  setFormError((error as Error).message);
                }
              }}
            />
          )}
        </aside>
      </div>
    </div>
  );
}
