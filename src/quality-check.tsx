import { AlertCircle, CheckCircle2 } from 'lucide-react';
import type { Asset } from './schema.ts';

const explanations: Record<string, { title: string; message: string }> = {
  MESH_PRIMITIVE_GENERATED_TANGENT_SPACE: {
    title: '接線データが未収録',
    message:
      'ノーマルマップの向きの基準を表示側で補うため、別の表示環境で凹凸や陰影が変わる可能性があります。接線を含めてGLBを書き出すと、この警告に対処できます。',
  },
  NODE_SKINNED_MESH_NON_ROOT: {
    title: '骨格付きメッシュに親ノードがある',
    message:
      '親ノードの移動・回転・拡大縮小が、骨格付きメッシュには反映されません。利用先で骨格と配置を確認してください。',
  },
  UNUSED_OBJECT: {
    title: '使用されていないデータ',
    message:
      '参照されていないデータが含まれています。通常は見た目に影響しませんが、ファイル容量が増える場合があります。',
  },
  NODE_EMPTY: {
    title: '空のノード',
    message:
      '描画する形状などを持たないノードが含まれています。制作時の補助要素などとして意図的に含まれる場合があります。',
  },
  UNSUPPORTED_EXTENSION: {
    title: '検証ツールが未対応の拡張',
    message:
      'この拡張の仕様適合は検証されていません。表示できるかどうかは、利用先の対応状況を確認してください。',
  },
  UNUSED_MESH_TANGENT: {
    title: '使用されていない接線データ',
    message:
      '対応する材質にノーマルマップがないため、接線データは表示に使われません。通常は見た目に影響しませんが、ファイル容量が増える場合があります。',
  },
};

export function QualityCheck({ qa }: { qa: Asset['qa'] }) {
  const groups = new Map<string, typeof qa.messages>();
  for (const message of qa.messages) {
    const key = `${message.severity}:${message.code}`;
    const group = groups.get(key);
    if (group) group.push(message);
    else groups.set(key, [message]);
  }
  return (
    <>
      <div
        className={'qa-box ' + (qa.errors ? 'qa-error' : qa.warnings ? 'qa-warning' : 'qa-pass')}
      >
        {qa.errors || qa.warnings ? <AlertCircle size={17} /> : <CheckCircle2 size={17} />}
        <div>
          <strong>glTF仕様検証</strong>
          <p>
            {qa.errors} エラー · {qa.warnings} 警告
          </p>
        </div>
      </div>
      {groups.size > 0 && (
        <div className="qa-details">
          {[...groups].map(([key, messages]) => {
            const first = messages[0];
            const explanation = explanations[first.code];
            return (
              <div className="qa-group" key={key}>
                {explanation && <p>{explanation.message}</p>}
                <details>
                  <summary>
                    {explanation?.title ?? first.code}
                    {' · '}
                    {['エラー', '警告', '情報', 'ヒント'][first.severity] ?? '指摘'}
                    （記録済み{messages.length}件）
                  </summary>
                  {messages.map((message, index) => (
                    <p key={index}>
                      <b>{message.code}</b>
                      <br />
                      {message.message}
                      {message.pointer && <code className="qa-pointer">{message.pointer}</code>}
                    </p>
                  ))}
                </details>
              </div>
            );
          })}
          <p className="subtle">
            同じ種類の指摘をまとめています。詳細は記録済みのメッセージのみで、全件ではない場合があります。
          </p>
        </div>
      )}
      <p className="subtle">glTFの仕様検証です。見た目や用途への適合は3D表示で確認できます。</p>
    </>
  );
}
