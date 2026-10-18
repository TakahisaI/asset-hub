import { useEffect, useRef, useState } from 'react';
import type { Asset, CatalogAsset } from './schema.ts';
import type { CompareViewer } from './compare-viewer.ts';
import { api, fmt, saveFile } from './ui.ts';
import { ProfileSummary, profileBytes } from './render-profile.tsx';

export type ComparedRevision = Asset & Pick<CatalogAsset, 'available' | 'profile' | 'profileError'>;
type Selection = { id: string; revision: string };
export function compareUrl(left: Selection, right?: Selection) {
  const params = new URLSearchParams({ compare: '1', left: left.id, leftRevision: left.revision });
  if (right) {
    params.set('right', right.id);
    params.set('rightRevision', right.revision);
  }
  return '?' + params;
}
function useRevisions(id: string) {
  const [state, setState] = useState({
    id: '',
    items: [] as ComparedRevision[],
    error: '',
    loading: false,
  });
  useEffect(() => {
    let cancelled = false;
    setState({ id, items: [], error: '', loading: !!id });
    if (id)
      void api<ComparedRevision[]>(`/api/assets/${encodeURIComponent(id)}/revisions`)
        .then((items) => {
          if (!cancelled) setState({ id, items, error: '', loading: false });
        })
        .catch((e) => {
          if (!cancelled) setState({ id, items: [], error: e.message, loading: false });
        });
    return () => {
      cancelled = true;
    };
  }, [id]);
  return state.id === id ? state : { id, items: [], error: '', loading: !!id };
}

export function Compare({ assets, onBack }: { assets: CatalogAsset[]; onBack: () => void }) {
  const params = new URLSearchParams(location.search);
  const [left, setLeft] = useState<Selection>({
    id: params.get('left') ?? '',
    revision: params.get('leftRevision') ?? '',
  });
  const [right, setRight] = useState<Selection>({
    id: params.get('right') ?? '',
    revision: params.get('rightRevision') ?? '',
  });
  const a = useRevisions(left.id),
    b = useRevisions(right.id);
  useEffect(() => {
    if (!left.revision && a.items.length)
      setLeft({
        ...left,
        revision: assets.find((x) => x.id === left.id)?.revision ?? a.items[0].revision,
      });
  }, [left, a.items, assets]);
  useEffect(() => {
    if (!right.revision && b.items.length)
      setRight({
        ...right,
        revision: assets.find((x) => x.id === right.id)?.revision ?? b.items[0].revision,
      });
  }, [right, b.items, assets]);
  const leftAsset = a.items.find((x) => x.id === left.id && x.revision === left.revision);
  const rightAsset = b.items.find((x) => x.id === right.id && x.revision === right.revision);
  useEffect(() => {
    if (leftAsset && rightAsset) history.replaceState({}, '', compareUrl(left, right));
  }, [leftAsset, rightAsset, left, right]);
  return (
    <div className="detail comparison">
      <button className="back-link" onClick={onBack}>
        ライブラリに戻る
      </button>
      <div className="detail-heading">
        <div>
          <div className="eyebrow">FIXED ASSET COMPARISON</div>
          <h1>アセットを比較</h1>
        </div>
      </div>
      <p>2つの固定版を選び、同じカメラ・照明・表示寸法で切り替えて比較します。</p>
      <div className="compare-selectors">
        {[
          { label: 'A', value: left, set: setLeft, state: a },
          { label: 'B', value: right, set: setRight, state: b },
        ].map(({ label, value, set, state }) => (
          <fieldset key={label}>
            <legend>{label}の固定版</legend>
            <label>
              {label}のアセット
              <select
                aria-label={label + 'のアセット'}
                value={value.id}
                onChange={(e) => set({ id: e.target.value, revision: '' })}
              >
                <option value="">選択してください</option>
                {value.id && !assets.some((x) => x.id === value.id) && (
                  <option value={value.id}>{value.id}</option>
                )}
                {assets.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name} · {x.id}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {label}の版
              <select
                aria-label={label + 'の版'}
                disabled={!state.items.length}
                value={value.revision}
                onChange={(e) => set({ ...value, revision: e.target.value })}
              >
                <option value="">{state.loading ? '読み込み中…' : '版を選択してください'}</option>
                {state.items.map((x) => (
                  <option key={x.revision} value={x.revision}>
                    {x.revision.slice(0, 12)} · {new Date(x.importedAt).toLocaleDateString('ja-JP')}
                  </option>
                ))}
              </select>
            </label>
            <code>
              {value.id || '—'}
              <br />
              {value.revision || '—'}
            </code>
            {state.error && (
              <p role="alert" className="form-error">
                {state.error}
              </p>
            )}
            {!state.loading &&
              value.revision &&
              !state.error &&
              !state.items.some((x) => x.revision === value.revision) && (
                <p role="alert">{label}の指定版が見つかりません。</p>
              )}
          </fieldset>
        ))}
      </div>
      {leftAsset && rightAsset && (
        <>
          <ComparisonProfiles left={leftAsset} right={rightAsset} />
          <ComparePreview
            key={[left.id, left.revision, right.id, right.revision].join(':')}
            left={leftAsset}
            right={rightAsset}
          />
        </>
      )}
    </div>
  );
}

export function ComparisonProfiles({
  left,
  right,
}: {
  left: ComparedRevision;
  right: ComparedRevision;
}) {
  const a = left.profile,
    b = right.profile;
  const comparable = !!a && !!b && a.tool === b.tool;
  const rows = [
    { name: '描画コール', a: a?.scene.drawCalls, b: b?.scene.drawCalls, format: fmt },
    {
      name: '描画三角形',
      a: a?.geometry.trianglesDrawn,
      b: b?.geometry.trianglesDrawn,
      format: fmt,
    },
    {
      name: '頂点属性',
      a: a?.geometry.vertexBytes,
      b: b?.geometry.vertexBytes,
      format: profileBytes,
    },
    {
      name: 'テクスチャ展開後',
      a: a?.textures.decodedBytes,
      b: b?.textures.decodedBytes,
      format: profileBytes,
    },
  ];
  return (
    <section className="render-profile" aria-label="固定版の負荷比較">
      <h2>描写負荷の比較</h2>
      <div className="compare-selectors">
        {[left, right].map((asset, i) => (
          <div key={i}>
            <h3>
              {i === 0 ? 'A' : 'B'} · {asset.name}
            </h3>
            <ProfileSummary profile={asset.profile} error={asset.profileError} />
            {asset.profile && (
              <p className="subtle">
                {asset.profile.tool} · 計測{' '}
                {new Date(asset.profile.measuredAt).toLocaleString('ja-JP')}
              </p>
            )}
            {asset.profileError && (
              <p role="alert" className="form-error">
                {asset.profileError}
              </p>
            )}
          </div>
        ))}
      </div>
      {!comparable && (
        <p role="status">
          {a && b
            ? '計測方法の版が異なるため比較できません。'
            : '両方の固定版に同じ方法の計測が必要です。未計測・読込エラーの値は差分に使いません。'}
        </p>
      )}
      <div className="profile-materials">
        <table>
          <caption>固定版の数値（B − A）</caption>
          <thead>
            <tr>
              <th>項目</th>
              <th>A</th>
              <th>B</th>
              <th>差分</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.name}>
                <th scope="row">{row.name}</th>
                <td>{row.a === undefined ? '—' : row.format(row.a)}</td>
                <td>{row.b === undefined ? '—' : row.format(row.b)}</td>
                <td>
                  {comparable && row.a !== undefined && row.b !== undefined
                    ? (row.b > row.a ? '+' : row.b < row.a ? '−' : '') +
                      row.format(Math.abs(row.b - row.a))
                    : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="subtle">
        構造から計測した仕事量です。速度や実際のGPUメモリ使用量を示しません。テクスチャはRGBA8・ミップマップなし。
      </p>
    </section>
  );
}

function ComparePreview({ left, right }: { left: ComparedRevision; right: ComparedRevision }) {
  const host = useRef<HTMLDivElement>(null),
    viewer = useRef<CompareViewer | null>(null);
  const [requested, setRequested] = useState(false),
    [ready, setReady] = useState(false),
    [error, setError] = useState('');
  const [side, setSide] = useState(0),
    [mode, setMode] = useState('pbr'),
    [lighting, setLighting] = useState('studio'),
    [grid, setGrid] = useState(true),
    [message, setMessage] = useState('');
  const supported = [left, right].every(
    (a) => !a.vfx && a.kind !== 'motion' && a.metrics.meshes > 0,
  );
  useEffect(() => {
    if (!requested) return;
    let cancelled = false,
      v: CompareViewer | undefined;
    void import('./compare-viewer.ts')
      .then(async ({ CompareViewer }) => {
        if (cancelled) return;
        v = new CompareViewer(host.current!);
        viewer.current = v;
        await v.loadPair('/api/files/' + left.revision, '/api/files/' + right.revision);
        if (!cancelled) setReady(true);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
      v?.dispose();
      viewer.current = null;
    };
  }, [requested, left.revision, right.revision]);
  function conditions() {
    return {
      schema: 1,
      left: { id: left.id, revision: left.revision },
      right: { id: right.id, revision: right.revision },
      displayed: side === 0 ? 'A' : 'B',
      pose: 'rest',
      mode,
      lighting,
      grid,
      ...viewer.current!.conditions(),
      profiles: [left.profile, right.profile].map((p) =>
        p ? { tool: p.tool, measuredAt: p.measuredAt } : null,
      ),
    };
  }
  return (
    <section className="compare-preview" aria-label="同じ条件で3D比較">
      <h2>同じ条件で見た目を比較</h2>
      <div className="compare-controls" role="group" aria-label="表示する固定版">
        {[left, right].map((asset, i) => (
          <button
            key={i}
            className="secondary"
            aria-pressed={side === i}
            disabled={!ready}
            onClick={() => {
              viewer.current?.show(i);
              setSide(i);
            }}
          >
            {i === 0 ? 'A' : 'B'}を表示：{asset.name}
          </button>
        ))}
      </div>
      <div className="viewport compare-viewport" ref={host}>
        {!ready && (
          <div className="viewer-state">
            {error ? (
              <p role="alert">{error}</p>
            ) : !supported ? (
              <p>3D比較はメッシュを持つモデルの静止姿勢が対象です。VFX・モーションは対象外です。</p>
            ) : !left.available || !right.available ? (
              <p>比較するGLBを復元してから読み込んでください。</p>
            ) : requested ? (
              <p>2つの3Dモデルを読み込み中…</p>
            ) : (
              <button className="primary" onClick={() => setRequested(true)}>
                2つの3Dモデルを読み込む
              </button>
            )}
          </div>
        )}
      </div>
      <div className="compare-controls">
        <label>
          表示モード
          <select
            aria-label="比較の表示モード"
            value={mode}
            disabled={!ready}
            onChange={(e) => {
              setMode(e.target.value);
              viewer.current?.mode(e.target.value);
            }}
          >
            <option value="pbr">マテリアル</option>
            <option value="normal">法線</option>
            <option value="wireframe">ワイヤーフレーム</option>
          </select>
        </label>
        <label>
          照明と背景
          <select
            aria-label="比較の照明と背景"
            value={lighting}
            disabled={!ready}
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
        </label>
        <label>
          <input
            type="checkbox"
            checked={grid}
            disabled={!ready}
            onChange={(e) => {
              setGrid(e.target.checked);
              if (viewer.current?.grid) viewer.current.grid.visible = e.target.checked;
            }}
          />
          グリッド
        </label>
        <button
          className="secondary"
          disabled={!ready}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(JSON.stringify(conditions(), null, 2));
              setMessage('比較条件をコピーしました');
            } catch {
              setMessage('コピーできませんでした。「比較条件を保存」を使ってください。');
            }
          }}
        >
          比較条件をコピー
        </button>
        <button
          className="secondary"
          disabled={!ready}
          onClick={() => saveFile('asset-comparison.json', conditions())}
        >
          比較条件を保存
        </button>
      </div>
      {message && <p role="status">{message}</p>}
      <p className="subtle">
        最初のカメラはAを基準にします。ドラッグ・ズーム後も、切替時に自動フィットや位置合わせを行いません。縮尺・位置・隙間の差をそのまま表示します。読み込み後に表示幅を変えた場合は、変更後の描画寸法を条件に記録します。
      </p>
      <p className="subtle">
        静止姿勢の比較です。内蔵照明は使用せず、共通の照明で表示します。動作設定・外部モーションは適用しません。ゲーム固有のシェーダー、全視点の見た目、正しいスケール、ゲーム組込みの同等性は保証しません。
      </p>
    </section>
  );
}
