# Asset Hub

ローカルの3Dアセット管理。CLIから登録・編集・固定版の配布を行い、Webで形状・動き・照明を確認できます。

## 起動

Node.js 24以上を使用します。

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

`update` は指定したメタデータだけを更新します。配列は置換なので、タグや利用先の増減には `tag`・`collection` を使います。`add` はIDの重複を拒否し、`replace` は名前・タグ・利用先と旧版・メモを保持してGLBを更新します。

```sh
npm run -s assetctl -- schema edit
npm run -s assetctl -- schema import
npm run -s assetctl -- import --manifest imports.json
# 登録済みIDを新版に更新する場合
npm run -s assetctl -- import --manifest imports.json --update
```

一括取り込みは `{ "schema": 1, "assets": [{ "id": "prop.wheel", "name": "水車", "file": "wheel.glb" }] }`。ローカルの `file` はmanifestからの相対パスです。GitHubから取得する場合は `download: {repository, commit, path}` を指定します。制作出典の `source` と配布ファイルの取得先 `download` は独立しています。`commit` は40文字の固定SHA、プライベートリポジトリの読み取りには `gh` のログインが必要です。各項目の成功・失敗をJSONで返します。

## 動作とモーション

GLBの埋め込みクリップを選択して再生・一時停止・時刻指定・速度変更できます。動作設定はモデルの固定版に紐付けます。

```sh
npm run -s assetctl -- schema behavior
npm run -s assetctl -- behavior set prop.wheel --json behavior.json --if-match '<updatedAt>'
npm run -s assetctl -- behavior get prop.wheel
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
    { "id": "strong-wind", "name": "強風", "rotations": [{ "node": 1, "axis": [0, 0, 1], "rpm": 30 }] }
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
catalog/generators/                個別プロジェクトの生成器
.store/<sha256>.glb                モデル・モーション実体
.store/<sha256>.png                サムネイル
.cache/                           再生成できるキャッシュ・保存ロック
```

**`catalog/` と `.store/` の両方をバックアップしてください。** このリポジトリのGit管理には含みません。GLBの内容ハッシュと制作元のコミットは別々に記録します。コードの配布対象は `package.json` の `files` で限定しています。

## 検証とサムネイル

```sh
npm run verify
npm run test:browser  # 先にbuild。一時ライブラリを使用
npm run validate:assets -- --json
npm run validate:assets -- --report .cache/validation.json
npm run -s assetctl -- gc --dry-run
npm run thumbnails  # 別ターミナルでnpm run devを起動
```

検証・容量確認は読み取り専用です。GLBの欠落や仕様違反、古い動作設定を報告します。仕様エラーのある制作途中のGLBも登録でき、検査結果を詳細画面で確認できます。コンテナが壊れたGLBや外部ファイル参照は拒否します。容量確認は旧版・動作設定・解決済みメモの参照も保持し、外部プロジェクトのlockは走査しません。

ブラウザ検査・サムネイル生成にはChromiumを使います。`CHROMIUM_EXECUTABLE` で実行ファイルを指定でき、省略時はmacOSのChromeまたはPlaywrightのChromiumを使います。未導入なら `npx playwright install chromium`。

ビューアは埋め込みGLBとMeshoptに対応します。Draco/KTX2が必須のものは通常GLBへ書き出してください。仕様適合や骨格の構造的な互換性は、見た目・実寸・接触・ゲーム内動作の保証ではありません。収録範囲は各アセットの出典情報に表示します。

[データ・動作・更新の契約](docs/architecture.md)
