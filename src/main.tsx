import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Box,
  Search,
  Layers,
  ArrowUpRight,
  Download,
  Check,
  ChevronRight,
  Grid2X2,
  List,
  X,
  MessageSquare,
  FolderOpen,
  AlertCircle,
  Plus,
  Maximize2,
  Bookmark,
  Package,
  LoaderCircle,
} from 'lucide-react';
import { categories, type CatalogAsset, type CatalogProblem } from './schema.ts';
import { Detail } from './detail.tsx';
import { Compare } from './compare.tsx';
import { ProfileSummary } from './render-profile.tsx';
import { Modal } from './modal.tsx';
import { fmt, mb, api, saveFile } from './ui.ts';
import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/500.css';
import '@fontsource/dm-sans/600.css';
import '@fontsource/dm-sans/700.css';
import './style.css';
import { Upload } from './upload.tsx';
import type { inspectStorage } from '../tools/storage.ts';
type Storage = Awaited<ReturnType<typeof inspectStorage>>;
function App() {
  const [storage, setStorage] = useState<Storage | null>(null);
  const [assets, setAssets] = useState<CatalogAsset[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [problems, setProblems] = useState<CatalogProblem[]>([]),
    [query, setQuery] = useState(''),
    [collection, setCollection] = useState('all'),
    [category, setCategory] = useState('all'),
    [sort, setSort] = useState('name'),
    [layout, setLayout] = useState('grid');
  const [selected, setSelected] = useState(new URLSearchParams(location.search).get('asset') ?? ''),
    [comparing, setComparing] = useState(new URLSearchParams(location.search).has('compare')),
    [toast, setToast] = useState(''),
    [help, setHelp] = useState(false),
    search = useRef<HTMLInputElement>(null);
  const reload = () => {
    void api<Storage>('/api/storage')
      .then(setStorage)
      .catch(() => setStorage(null));
    return api<{ assets: CatalogAsset[]; problems: CatalogProblem[] }>('/api/catalog')
      .then((d) => {
        setAssets(d.assets);
        setProblems(d.problems ?? []);
        setError('');
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    void reload();
    const pop = () => {
      const params = new URLSearchParams(location.search);
      setSelected(params.get('asset') ?? '');
      setComparing(params.has('compare'));
    };
    window.addEventListener('popstate', pop);
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        search.current?.focus();
      }
    };
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('popstate', pop);
      window.removeEventListener('keydown', key);
    };
  }, []);
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(''), 3500);
      return () => clearTimeout(timer);
    }
  }, [toast]);
  function select(id: string) {
    setSelected(id);
    setComparing(false);
    window.scrollTo({ top: 0, behavior: 'instant' });
    const url = new URL(location.href);
    for (const key of ['compare', 'left', 'leftRevision', 'right', 'rightRevision'])
      url.searchParams.delete(key);
    id ? url.searchParams.set('asset', id) : url.searchParams.delete('asset');
    history.pushState({}, '', url);
  }
  const collections = [...new Set(assets.flatMap((a) => a.collections))].sort();
  const filtered = assets
    .filter(
      (a) =>
        (collection === 'all' ||
          (collection === 'notes'
            ? a.notesCount > 0
            : a.collections.includes(collection.slice(11)))) &&
        (category === 'all' || a.category === category) &&
        query
          .toLowerCase()
          .split(/\s+/)
          .every((q) =>
            [a.name, a.id, a.description, a.source.upstreamId, ...a.tags, ...a.collections]
              .join(' ')
              .toLowerCase()
              .includes(q),
          ),
    )
    .sort((a, b) =>
      sort === 'size'
        ? b.file.bytes - a.file.bytes
        : sort === 'updated'
          ? b.updatedAt.localeCompare(a.updatedAt)
          : a.name.localeCompare(b.name, 'ja'),
    );
  const current = assets.find((a) => a.id === selected),
    noted = assets.filter((a) => a.notesCount > 0).length;
  return (
    <div className="shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="/"
          onClick={(e) => {
            e.preventDefault();
            select('');
            setCollection('all');
          }}
        >
          <span className="brand-icon">
            <Box size={25} />
          </span>
          <span>
            asset hub<small>PERSONAL LIBRARY</small>
          </span>
        </a>
        <div className="workspace">
          <span className="avatar">
            <Box size={16} />
          </span>
          <div>
            マイライブラリ<small>ローカルライブラリ</small>
          </div>
          <span className="online" />
        </div>
        <div className="nav-label">LIBRARY</div>
        <nav>
          <button
            className={collection === 'all' ? 'active' : ''}
            onClick={() => {
              setCollection('all');
              select('');
            }}
          >
            <Grid2X2 size={17} />
            すべてのアセット<span>{assets.length}</span>
          </button>
          <button
            className={collection === 'notes' ? 'active' : ''}
            onClick={() => {
              setCollection('notes');
              select('');
            }}
          >
            <Bookmark size={17} />
            未解決メモあり<span>{noted}</span>
          </button>
        </nav>
        <div
          className="nav-label collection-label"
          title="利用先・用途の関連付け。同じアセットを複数に含められます。利用状況の自動追跡ではありません。"
        >
          PROJECTS & COLLECTIONS
          <Layers size={13} />
        </div>
        <nav>
          {collections.map((c) => (
            <button
              key={c}
              className={collection === 'collection:' + c ? 'active' : ''}
              onClick={() => {
                setCollection('collection:' + c);
                select('');
              }}
            >
              <span className="collection-dot sea" />
              <span className="collection-name">{c}</span>
              <span>{assets.filter((a) => a.collections.includes(c)).length}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="storage">
            <span>
              <span className="online" />
              カタログはこのPCに保存
            </span>
            <small>
              {fmt(assets.length)} assets · {storage ? mb(storage.summary.libraryBytes) : '—'}
            </small>
          </div>
          <button className="help-link" onClick={() => setHelp(true)}>
            <FolderOpen size={16} />
            アセットの追加・使い方
            <ArrowUpRight size={14} />
          </button>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <span>
            ライブラリ <ChevronRight size={14} />{' '}
            {comparing
              ? 'アセット比較'
              : current
                ? 'アセット詳細'
                : collection === 'all'
                  ? 'すべてのアセット'
                  : collection === 'notes'
                    ? '未解決メモあり'
                    : collection.slice(11)}
          </span>
          <div className="topbar-right">
            <span className="local-pill">
              <span className="online" />
              LOCAL
            </span>
            <span className="top-avatar">
              <Box size={14} />
            </span>
          </div>
        </header>
        {problems.length > 0 && (
          <div className="catalog-problems" role="alert">
            <strong>{problems.length}件のファイルを読み込めませんでした</strong>
            <p>
              読み込めたアセットを表示しています。対象の台帳・メモは保存ファイルを確認してください。
            </p>
            <details>
              <summary>対象ファイル</summary>
              {problems.map((problem) => (
                <p key={problem.file}>
                  <code>{problem.file}</code>
                  <br />
                  {problem.message}
                </p>
              ))}
            </details>
          </div>
        )}
        {comparing ? (
          <Compare assets={assets} onBack={() => select('')} />
        ) : current ? (
          <Detail
            key={current.id + ':' + current.revision + ':' + (current.behavior ?? '')}
            asset={current}
            onBack={() => select('')}
            onUpdate={reload}
            notify={setToast}
          />
        ) : (
          <div className="library">
            <div className="page-heading">
              <div>
                <div className="eyebrow">YOUR CREATIVE INVENTORY</div>
                <h1>
                  {collection === 'all'
                    ? 'すべてのアセット'
                    : collection === 'notes'
                      ? '未解決メモあり'
                      : collection.slice(11)}
                  <span>{filtered.length}</span>
                </h1>
                <p>作品を越えて、探す。確かめる。次の制作へ。</p>
              </div>
              <div className="detail-actions">
                <a className="secondary" href="?compare=1">
                  アセットを比較
                </a>
                <button className="primary" onClick={() => setHelp(true)}>
                  <Plus size={17} />
                  アセットを追加
                </button>
              </div>
            </div>
            <div className="overview">
              <div>
                <span className="stat-icon">
                  <Box size={20} />
                </span>
                <span>
                  <small>ライブラリ</small>
                  <strong>
                    {fmt(assets.length)}
                    <em>assets</em>
                  </strong>
                </span>
              </div>
              <div>
                <span className="stat-icon">
                  <Layers size={20} />
                </span>
                <span>
                  <small>コレクション</small>
                  <strong>
                    {collections.length}
                    <em>collections</em>
                  </strong>
                </span>
              </div>
              <div>
                <span className="stat-icon amber">
                  <Bookmark size={20} />
                </span>
                <span>
                  <small>未解決メモあり</small>
                  <strong>
                    {noted}
                    <em>assets</em>
                  </strong>
                </span>
              </div>
              <div>
                <span className="stat-icon green">
                  <Package size={20} />
                </span>
                <span>
                  <small>ライブラリ容量</small>
                  <strong className="size-stat">
                    {storage ? mb(storage.summary.libraryBytes) : '—'}
                  </strong>
                </span>
              </div>
            </div>
            {storage && (
              <details className="storage-detail">
                <summary>保存容量の内訳</summary>
                <dl>
                  <div>
                    <dt>モデル 現在版</dt>
                    <dd>{mb(storage.summary.currentBytes)}</dd>
                  </div>
                  <div>
                    <dt>モデル 履歴・復元用の完全版</dt>
                    <dd>{mb(storage.summary.retainedHistoryBytes)}</dd>
                  </div>
                  <div>
                    <dt>サムネイル</dt>
                    <dd>{mb(storage.summary.thumbnailBytes)}</dd>
                  </div>
                  <div>
                    <dt>制作ソース・台帳</dt>
                    <dd>{mb(storage.summary.catalogBytes + storage.summary.indexBytes)}</dd>
                  </div>
                  <div>
                    <dt>未参照候補</dt>
                    <dd>{mb(storage.summary.candidateBytes)}</dd>
                  </div>
                  <div>
                    <dt>表示キャッシュ（容量の別枠）</dt>
                    <dd>
                      {mb(storage.summary.materializedBytes)} /{' '}
                      {mb(storage.summary.cacheLimitBytes)}
                    </dd>
                  </div>
                </dl>
                <p>
                  保存先: <code>{storage.root}</code>
                </p>
                {(!storage.complete || storage.missing.length > 0) && (
                  <p role="alert">保存データに問題があります。CLIの doctor で確認できます。</p>
                )}
              </details>
            )}
            <div className="toolbar">
              <div className="search">
                <Search size={18} />
                <input
                  ref={search}
                  aria-label="アセットを検索"
                  placeholder="名前、タグ、用途から検索…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                {query ? (
                  <button aria-label="検索をクリア" onClick={() => setQuery('')}>
                    <X size={15} />
                  </button>
                ) : (
                  <kbd>⌘ K</kbd>
                )}
              </div>
              <select
                className="sort"
                aria-label="並び順"
                value={sort}
                onChange={(e) => setSort(e.target.value)}
              >
                <option value="name">名前順</option>
                <option value="updated">更新が新しい順</option>
                <option value="size">ファイルが大きい順</option>
              </select>
              <div className="view-switch">
                <button
                  aria-label="グリッド表示"
                  className={layout === 'grid' ? 'chosen' : ''}
                  onClick={() => setLayout('grid')}
                >
                  <Grid2X2 size={17} />
                </button>
                <button
                  aria-label="リスト表示"
                  className={layout === 'list' ? 'chosen' : ''}
                  onClick={() => setLayout('list')}
                >
                  <List size={18} />
                </button>
              </div>
            </div>
            <div className="categories">
              <button
                className={category === 'all' ? 'selected' : ''}
                onClick={() => setCategory('all')}
              >
                すべて
              </button>
              {Object.entries(categories)
                .filter(([key]) => assets.some((a) => a.category === key))
                .map(([key, label]) => (
                  <button
                    className={category === key ? 'selected' : ''}
                    key={key}
                    onClick={() => setCategory(key)}
                  >
                    {label}
                    <span>{assets.filter((a) => a.category === key).length}</span>
                  </button>
                ))}
            </div>
            <div className="results-caption">
              <span>{filtered.length} 件のアセット</span>
              <button
                onClick={() => {
                  saveFile('asset-catalog.json', { schema: 1, assets: filtered });
                  setToast('表示中のカタログを書き出しました');
                }}
              >
                <Download size={13} />
                カタログを書き出す
              </button>
            </div>
            {error ? (
              <div className="empty">
                <AlertCircle />
                <h2>読み込めませんでした</h2>
                <p>{error}</p>
                <button onClick={reload}>再読み込み</button>
              </div>
            ) : loading ? (
              <div className="empty">
                <LoaderCircle className="spin" />
                カタログを読み込み中…
              </div>
            ) : !filtered.length ? (
              <div className="empty">
                <Search size={30} />
                <h2>アセットが見つかりません</h2>
                <p>検索語や絞り込みを変更してください。</p>
                <button
                  onClick={() => {
                    setQuery('');
                    setCategory('all');
                    setCollection('all');
                  }}
                >
                  条件をリセット
                </button>
              </div>
            ) : (
              <div className={'asset-grid ' + (layout === 'list' ? 'list-layout' : '')}>
                {filtered.map((a) => (
                  <button className="asset-card" key={a.id} onClick={() => select(a.id)}>
                    <div className={'card-image ' + a.category}>
                      {a.thumbnail ? (
                        <img src={'/api/thumbnails/' + a.file.hash} alt={a.name} loading="lazy" />
                      ) : (
                        <div className="placeholder-model">
                          <Box size={64} strokeWidth={0.7} />
                          <span>3D PREVIEW</span>
                        </div>
                      )}
                      <span className="format">GLB</span>
                      <span className="card-open">
                        <Maximize2 size={15} />
                      </span>
                      {!a.available && <span className="missing">ファイル未取得</span>}
                    </div>
                    <div className="card-info">
                      <div className="card-collection">
                        <span className="collection-dot sea" />
                        {a.collections.join(' / ') || 'LOCAL ASSETS'}
                      </div>
                      <h3>{a.name}</h3>
                      <ProfileSummary profile={a.profile} error={a.profileError} />
                      <div className="card-tags">
                        <span>{categories[a.category]}</span>
                        <span>
                          {a.source.kind === 'procedural'
                            ? '生成モデル'
                            : a.source.kind === 'blender'
                              ? 'Blender'
                              : 'GLB'}
                        </span>
                      </div>
                      <div className="card-footer">
                        <span className="asset-note-count">
                          {a.notesCount > 0 ? (
                            <>
                              <MessageSquare size={11} />
                              {a.notesCount} メモ
                            </>
                          ) : (
                            <>
                              <Box size={11} />
                              3Dモデル
                            </>
                          )}
                        </span>
                        <span>
                          {mb(a.file.bytes)}
                          <span className="dot-sep">·</span>
                          {fmt(a.metrics.triangles)} tris
                        </span>
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
            <footer className="library-footer">
              <Box size={14} /> One library. Every possibility.<span>ASSET HUB / 01</span>
            </footer>
          </div>
        )}
        {selected && !current && !loading && (
          <div className="not-found">
            指定したアセットは見つかりません。<button onClick={() => select('')}>一覧へ戻る</button>
          </div>
        )}
      </main>
      {toast && (
        <div className="toast" role="status">
          <Check size={16} />
          {toast}
        </div>
      )}
      {help && (
        <Modal label="アセットの追加・使い方" onClose={() => setHelp(false)}>
          <button className="close-modal" aria-label="閉じる" onClick={() => setHelp(false)}>
            <X />
          </button>
          <div className="eyebrow">GROW YOUR LIBRARY</div>
          <h2>アセットを追加する</h2>
          <Upload
            onDone={async (id) => {
              setHelp(false);
              await reload();
              select(id);
              setToast('アセットを登録しました');
            }}
          />
          <details className="import-commands">
            <summary>リポジトリからの取込・CLI</summary>
            <p>
              制作ソースを残し、固定版のGLBと出典を台帳に登録します。このフォルダで実行してください。
            </p>
            <label>手元のGLBを登録する</label>
            <code>npm run assetctl -- add ./model.glb --id my.asset --name アセット名</code>
            <label>プレビュー画像を生成する</label>
            <code>npm run thumbnails</code>
            <p className="subtle">
              登録・更新後は一覧を再読み込みしてください。詳細画面で名前・タグ・コレクションを編集できます。
            </p>
            <button
              className="primary"
              onClick={() => {
                setHelp(false);
                void reload();
              }}
            >
              一覧を再読み込み
            </button>
          </details>
        </Modal>
      )}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
