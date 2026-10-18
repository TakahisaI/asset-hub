import type { RenderProfile } from './render-profile-schema.ts';
import { fmt, mb } from './ui.ts';

type Profile = RenderProfile | null | undefined;
const profileBytes = (value: number) => (value < 1000 ? `${fmt(value)} B` : mb(value));

export function ProfileSummary({ profile, error }: { profile: Profile; error?: string }) {
  return profile ? (
    <span className="profile-summary" aria-label="描写負荷">
      <span>
        描画コール <b>{fmt(profile.scene.drawCalls)}</b>
      </span>
      <span>
        描画三角形 <b>{fmt(profile.geometry.trianglesDrawn)}</b>
      </span>
      <span>
        テクスチャ展開後 <b>{profileBytes(profile.textures.decodedBytes)}</b>
      </span>
    </span>
  ) : (
    <span className="profile-empty" title={error}>
      描写負荷：{error ? '読込エラー' : '未計測'}
    </span>
  );
}

const delta = (value: number, format = fmt) =>
  `${value > 0 ? '+' : value < 0 ? '−' : ''}${format(Math.abs(value))}`;

export function ProfilePanel({
  profile,
  current,
  compare,
  error,
}: {
  profile: Profile;
  current: Profile;
  compare: boolean;
  error?: string;
}) {
  return (
    <section className="render-profile" aria-label="描写負荷の詳細">
      <h3>描写負荷</h3>
      <ProfileSummary profile={profile} error={error} />
      {error && (
        <p className="form-error" role="alert">
          計測結果を読み込めませんでした：{error}
        </p>
      )}
      {profile && (
        <>
          <p className="subtle">
            頂点属性 {profileBytes(profile.geometry.vertexBytes)} · 計測{' '}
            {new Date(profile.measuredAt).toLocaleString('ja-JP')}
          </p>
          <p className="subtle">
            構造から計測した仕事量です。実行速度やゲームへの適合、実際のGPUメモリ使用量は保証しません。テクスチャはRGBA8・ミップマップなしの値です。
          </p>
          <div className="profile-materials">
            <table>
              <caption>材質別の内訳</caption>
              <thead>
                <tr>
                  <th>材質</th>
                  <th>描画コール</th>
                  <th>描画三角形</th>
                  <th>両面</th>
                </tr>
              </thead>
              <tbody>
                {profile.byMaterial.map((material, index) => (
                  <tr key={index}>
                    <th scope="row">{material.name}</th>
                    <td>{fmt(material.drawCalls)}</td>
                    <td>{fmt(material.triangles)}</td>
                    <td>{material.doubleSided ? 'あり' : 'なし'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {compare && (
        <div className="profile-diff" aria-label="版間差分">
          <h4>現在版との差（表示版 − 現在版）</h4>
          {!profile || !current ? (
            <p>版間差分を表示するには、表示版と現在版の計測が必要です。</p>
          ) : profile.tool !== current.tool ? (
            <p>計測方法の版が異なるため比較できません。</p>
          ) : (
            <dl>
              <div>
                <dt>描画コール</dt>
                <dd>{delta(profile.scene.drawCalls - current.scene.drawCalls)}</dd>
              </div>
              <div>
                <dt>描画三角形</dt>
                <dd>{delta(profile.geometry.trianglesDrawn - current.geometry.trianglesDrawn)}</dd>
              </div>
              <div>
                <dt>頂点属性</dt>
                <dd>
                  {delta(profile.geometry.vertexBytes - current.geometry.vertexBytes, profileBytes)}
                </dd>
              </div>
              <div>
                <dt>テクスチャ展開後</dt>
                <dd>
                  {delta(
                    profile.textures.decodedBytes - current.textures.decodedBytes,
                    profileBytes,
                  )}
                </dd>
              </div>
            </dl>
          )}
        </div>
      )}
    </section>
  );
}
