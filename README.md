# Asset Hub

ローカルの3Dアセット管理。CLIから登録・編集・固定版の配布を行い、Webで形状・動き・照明を確認できます。

## 起動

Node.js 24以上と Zstandard (`zstd` 1.5.5以上) を使用します。macOSは `brew install zstd`、Ubuntuは `sudo apt-get install zstd`。

```sh
npm ci
npm run build
# ライブラリをコードと別の場所に置く場合
export ASSET_HUB_ROOT=/path/to/library
npm start
```

<http://127.0.0.1:4310> を開きます。開発時は `npm run dev`。別ポートは `PORT=4311 npm start`。
`ASSET_HUB_ROOT` を省略すると現在の作業ディレクトリがライブラリになります。空のライブラリからも起動できます。APIはloopback限定です。

## CLI

`npm run -s assetctl -- help` で全コマンドを確認できます。標準出力はJSON、エラーは標準エラーのJSONと終了コード1です。JSONファイルを受け取る `--json`・`--metadata` は `-` で標準入力も読めます。

```sh
npm run -s assetctl -- add ./model.glb --id prop.wheel --name 水車
npm run -s assetctl -- search 水車 --tag wood
npm run -s assetctl -- get prop.wheel
npm run -s assetctl -- inspect prop.wheel
npm run -s assetctl -- tag add prop.wheel wood rotating
npm run -s assetctl -- tag remove prop.wheel wood
npm run -s assetctl -- collection add prop.wheel project-a project-b
npm run -s assetctl -- update prop.wheel --json metadata.json --if-match '<getで取得したupdatedAt>'
npm run -s assetctl -- replace prop.wheel ./updated.glb --if-match '<getで取得したupdatedAt>'
npm run -s assetctl -- revisions prop.wheel
```

GLBを別の版に置き換えると、現在の動作設定は解除されます。過去の設定ファイルは保持します。同じGLBの再取り込みでは固定版を変更せず、新しい出典・検査結果を取込記録へ保存します。

`update` は指定したメタデータだけを更新します。配列は置換なので、タグや利用先の増減には `tag`・`collection` を使います。`add` はIDの重複を拒否し、`replace` は名前・タグ・利用先と旧版・メモを保持してGLBを更新します。

```sh
npm run -s assetctl -- schema edit
npm run -s assetctl -- schema import
npm run -s assetctl -- import --manifest imports.json
# 登録済みIDを新版に更新する場合
npm run -s assetctl -- import --manifest imports.json --update
```

一括取り込みは `{ "schema": 1, "assets": [{ "id": "prop.wheel", "name": "水車", "file": "wheel.glb" }] }`。ローカルの `file` はmanifestからの相対パスです。GitHubから取得する場合は `download: {repository, commit, path}` を指定します。制作出典の `source` と配布ファイルの取得先 `download` は独立しています。`commit` は40文字の固定SHA、プライベートリポジトリの読み取りには `gh` のログインが必要です。各項目の成功・失敗をJSONで返します。

### Blenderからの書き出し

```sh
blender --background --python-exit-code 1 --python tools/export_blender.py -- \
  /path/to/source.blend /path/to/new-export.glb --exclude-collection-prefix STUDIO
```

Principled BSDFのベースカラー・粗さ・金属度・法線（凹凸）につながるプロシージャル材質をテクスチャへベイクしてからGLBを書き出します。原本は保存し直さず、出力先には新しいパスを指定します。`--exclude-collection-prefix` は撮影用などのコレクションを除外する任意指定、`--size` はベイク画像の一辺（既定2048px）です。隣のJSONに原本・出力・書き出し処理のハッシュとベイク対象を記録します。

接線データも含め、ノーマルマップの陰影が表示環境によって変わる可能性を減らします。接線を計算できるよう、五角形以上の面はベイク後に書き出し用として三角形へ分割します。原本は変更しません。仕様検証の指摘は画面で種類ごとにまとめ、対応する日本語説明と元の検証メッセージを表示します。詳細は記録済みのメッセージのみで、検証時の上限により全件を含まない場合があります。

質感は開始フレームで固定します。プロシージャルなボリューム・透過・材質アニメーションのベイクは対象外です。リグ付きメッシュの質感ベイク、動きのある・入れ子のコレクションインスタンスは制作側で処理してください。動く部品のノードと埋め込みクリップは保持します。Blender 5.2で検証しています。

### 統合した派生アセットの登録

正本の固定版から、指定した剛体グループを材質・頂点属性構成ごとに統合し、別IDへ登録できます。`inspect` でノード番号を確認し、`groups.json` に固定部品だけを指定します。グループのrootから対象までに埋め込みアニメーションや動作設定の可動部があれば拒否します。制作側独自の制御は自動判定できないため、対象から外してください。

```json
{ "groups": [{ "rootNode": 0, "nodes": [1, 2] }] }
```

```sh
npm run -s assetctl -- schema bake
npm run -s assetctl -- bake ship.original --id ship.merged --json groups.json --revision '<入力GLBのSHA-256>'
# 検証後、正本と別IDに登録
npm run -s assetctl -- bake ship.original --id ship.merged --json groups.json --revision '<入力GLBのSHA-256>' --write
```

`--write` を省略すると生成・検証だけを行い、台帳・保存形状・レシピを書き込みません。検証用のブラウザにはChrome（macOS）または `npx playwright install chromium` が必要です。`CHROMIUM_EXECUTABLE` で実行ファイルを指定できます。出力3回のSHA-256一致、仕様検証、三角形数・画像容量の保持、全クリップのキー時刻と区間中点・全プリセットでの8視点×PBR/法線/ワイヤーフレーム比較を通過すると登録します。入力・生成器・環境・閾値を固定したレシピと前後計測・比較PNGを `catalog/recipes/` に保存します。

画像の既定値は最大チャンネル差2・変更画素率0.1%以下です。座標の丸めや線画の画素被覆による差も失敗になる場合があります。比較画像と数値誤差を確認して条件を変える場合は、入力JSONの `checks.imageMaxChannelError`（0〜255）と `checks.imageMaxChangedPixelRatio`（0超〜0.001の正規化済み小数文字列）に明記してください。閾値変更は別レシピとして保存し、既存の派生IDを上書きしません。

派生は `schema: 2` の `derivedFrom` に正本ID・入力版・レシピを保持します。既存のschema 1は変換しません。正本・元リポジトリ・過去メモを保持し、同じ派生の再実行でも編集済みメタデータ・メモを保持します。別の入力やレシピには新IDを使います。派生への `replace` は拒否するので、手編集した場合は別IDで通常登録し、`source.scope` に元の派生ID・版と編集内容を記録してください。詳細画面から来歴と検証結果を取得でき、lock/syncには同じ来歴JSONを同梱します。

初版は単一シーン・FLOAT頂点属性の三角形が対象で、skinning・morph・GPU instancing・透過・VFX・未知の属性や拡張を含む指定は拒否します。三角形削減やテクスチャ再ベイクは行いません。元のBINを保持するためGLBサイズは増える場合があります。限定した視点の比較は全環境の見た目・正しいスケール・ゲーム組込みや正本の部位別検査を保証しません。[設計と保存契約](docs/derived-assets.md)を参照してください。

## 動作とモーション

### Three.js向けVFX

既存GLBの移動・回転・拡縮に、Blenderの煙密度と発光強度の時間変化を追加できます。原本を`catalog/sources/`に保管し、対応するGLBから新しい版を作ります。原本と入力GLBは変更しません。

```sh
blender --background --disable-autoexec --python-exit-code 1 \
  --python tools/export_blender_vfx.py -- \
  catalog/sources/example/effect.blend original.glb effect.glb \
  --runtime src/vfx-runtime.js --preview catalog/sources/example/preview.mp4
```

元のGLBとBlenderは同じ開始フレーム・終了フレームを持つ一つのシーンクリップを使います。現在はPrincipled VolumeにNoise TextureとMultiplyで密度を与える球状の煙と、Principled BSDFのリンクされていない発光強度をフレームごとに収録します。煙には任意でクランプしたSubtractの閾値を使えます。煙はThree.jsの近似ボリュームで、Blenderのノイズ・照明・影・ブルームとは一致しません。対応範囲は詳細画面にも表示します。

GLBをCLIの`add`/`replace`/`import`で登録すると、ローダー・原本・参考動画もハッシュで圧縮保存します。原本の`source`メタデータは保管したblendへのパスを指定してください。画面では3Dの再生・停止・シーク、参考動画の視聴、原本とローダーの取得ができます。`VFX`カテゴリで絞り込めます。固定版の`lock`/`sync`では、GLBと対応するローダーを一緒に出力します。GLB単体の一般的なビューアには煙と材質アニメーションは移植されません。

持ち出し先は同じThree.jsを使い、取得したローダーをGLTFLoaderの直後に適用します。ローダーに追加の実行時依存はありません。Three.js r186 / WebGL2で確認しています。

```js
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { applyVfx } from './asset-hub-vfx.<hash>.js';

const gltf = await new GLTFLoader().loadAsync('./effect.glb');
applyVfx(gltf);
scene.add(gltf.scene);
const mixer = new THREE.AnimationMixer(gltf.scene);
mixer.clipAction(gltf.animations[0]).play();
// 描画ループで mixer.update(deltaSeconds) を呼びます。
```

VFXデータはGLBの固定版に含まれ、ローダー・原本・動画も旧版から参照し続けます。通常の`catalog/`と`.store/`のバックアップに含まれます。

GLBの埋め込みクリップを選択して再生・一時停止・時刻指定・速度変更できます。動作設定はモデルの固定版に紐付けます。

```sh
npm run -s assetctl -- schema behavior
npm run -s assetctl -- behavior set prop.wheel --json behavior.json --if-match '<updatedAt>'
npm run -s assetctl -- behavior get prop.wheel
npm run -s assetctl -- behavior clear prop.wheel --if-match '<updatedAt>'
npm run -s assetctl -- add ./walk.glb --id motion.walk --kind motion
```

`behavior.json` の例。`modelRevision` は対象GLBのハッシュ、`node` は `inspect` で確認した番号です。

```json
{
  "schema": 1,
  "assetId": "prop.wheel",
  "modelRevision": "<GLBのSHA-256>",
  "presets": [
    { "id": "breeze", "name": "微風", "rotations": [{ "node": 1, "axis": [0, 0, 1], "rpm": 6 }] },
    {
      "id": "strong-wind",
      "name": "強風",
      "rotations": [{ "node": 1, "axis": [0, 0, 1], "rpm": 30 }]
    }
  ]
}
```

プリセットの `clip: {index}` は埋め込みクリップ、`clip: {index, source: {id, revision}}` は外部モーションです。外部モーションは基準姿勢・寸法・階層が対応するノードにだけ適用します。必要なら `nodeMap` で元ノード番号から対象番号を指定します。体格や骨格が違う場合は制作側でリターゲットした版を登録してください。

`lights: [{node, intensity}]` はGLB内の照明を調整します。`type: "point"` または `"spot"` を指定するとそのノードに光源を追加できます。夜間照明と「照射確認面」で照らす範囲を確認できます。回転・点灯は決めた条件の再生で、水流や風の物理シミュレーションではありません。

## メモと配布

```sh
npm run -s assetctl -- schema note
npm run -s assetctl -- note add prop.wheel --json note.json
npm run -s assetctl -- note list prop.wheel
npm run -s assetctl -- note resolve prop.wheel '<note-id>'
npm run -s assetctl -- lock prop.wheel > assets.lock.json
npm run -s assetctl -- sync --lock assets.lock.json --out /path/to/game/assets
```

メモには `revision` と `text` を指定します。Webでは視点と選択中の動作・時刻も保存します。
詳細画面の「表示する版」で旧版を閲覧できます。旧版のメモからは、そのGLB版と記録された動作設定・時刻・視点を復元します。履歴の閲覧は現在の台帳を変更せず、メタデータの編集とlock取得は現在版に戻って行います。
`lock` はGLB・動作設定・参照モーションを固定し、`sync` は検証後にGLBと動作JSONを出力します。異なる内容の既存ファイルは上書きしません。意図した置換に限り `--force` を使います。動作JSONはAsset Hubの形式で、利用先エンジンでの実装またはGLBへの焼き付けが必要です。

## データとバックアップ

`src/`・`server/`・`tools/` がコード、`ASSET_HUB_ROOT` 内の以下がライブラリです。

```text
catalog/assets/<id>.json            現在の台帳
catalog/revisions/<id>/<hash>.json  GLBの固定版情報
catalog/behaviors/<hash>.json       動作設定の固定版
catalog/reviews/<id>.json           メモ
catalog/recipes/                   生成条件と出典
catalog/imports/                   取り込みmanifest
catalog/import-events/             実行ごとの出典・検査記録
catalog/sources/                   保管した制作ソース
catalog/generators/                個別プロジェクトの生成器
.store/blobs/<sha256>.zst          圧縮完全版または完全版からの差分
.store/blobs/<sha256>.json         復元サイズ・ハッシュ・参照する完全版
.store/<sha256>.png                サムネイル
.cache/                           再生成できるキャッシュ・保存ロック
```

GLBのIDは圧縮前のSHA-256です。全登録版を保持し、差分は完全版を直接参照します。差分が完全版の圧縮サイズの80%未満になる場合に採用し、復元時は元のSHA-256を検証します。表示・配布用のGLBキャッシュは既定512 MiB、`ASSET_HUB_CACHE_MB` で変更できます（0は保持しません）。処理中の復元ファイルは別枠で一時的に容量を使います。

```sh
npm run -s assetctl -- doctor
npm run -s assetctl -- backup --out /path/to/new-backup
npm run -s assetctl -- backup verify /path/to/new-backup
npm run -s assetctl -- restore --from /path/to/new-backup --into /path/to/new-library
# 旧形式のライブラリを一度だけ移行する場合
npm run -s assetctl -- storage migrate --backup /path/to/pre-migration-backup
```

バックアップは制作ソースを含む `catalog/` と `.store/` 全体をコピーし、全ファイルのSHA-256を記録・検証します。復元先・バックアップ先は新規ディレクトリに限ります。移行はバックアップと全GLBの復元検証後に、重複する旧GLBを取り除きます。中断した場合は別の新規バックアップ先を指定して再実行できます。

`doctor` は全圧縮データの復元、参照欠落、壊れた台帳、保存ロックを確認します。残留ロックは実行中のプロセスがないことを確認してから扱ってください。容量と保存先は画面の「保存容量の内訳」でも確認できます。

ライブラリはGit管理に含みません。圧縮保存はバックアップの代わりにはならず、差分を復元するには参照先の完全版も必要です。コードの配布対象は `package.json` の `files` で限定しています。

## 検証とサムネイル

```sh
npm run verify:full  # 整形・型検査・単体テスト・build・ブラウザ検査（一時ライブラリ）
npm run validate:assets -- --json
npm run validate:assets -- --report .cache/validation.json
npm run -s assetctl -- gc --dry-run
npm run thumbnails  # 別ターミナルでnpm run devを起動
npm run test:blender  # Blender 5.2が必要。CIでは5.2.2を固定して実行
```

検証・容量確認は台帳と圧縮保存データを変更しません。復元キャッシュは作成されます。GLBの欠落や仕様違反、古い動作設定を報告します。仕様エラーのある制作途中のGLBも登録でき、検査結果を詳細画面で確認できます。コンテナが壊れたGLBや外部ファイル参照は拒否します。容量確認は旧版・動作設定・解決済みメモの参照も保持し、外部プロジェクトのlockは走査しません。

ブラウザ検査・サムネイル生成にはChromiumを使います。`CHROMIUM_EXECUTABLE` で実行ファイルを指定でき、省略時はmacOSのChromeまたはPlaywrightのChromiumを使います。未導入なら `npx playwright install chromium`。

ビューアは埋め込みGLBとMeshoptに対応します。Draco/KTX2が必須のものは通常GLBへ書き出してください。仕様適合や骨格の構造的な互換性は、見た目・実寸・接触・ゲーム内動作の保証ではありません。収録範囲は各アセットの出典情報に表示します。

[データ・動作・更新の契約](docs/architecture.md)
