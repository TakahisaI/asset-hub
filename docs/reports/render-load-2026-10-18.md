# 描写負荷の棚卸し — 2026-10-18

Issue #8。計測器 `render-profile/1`、実装コミット `acd0d26`（PR #11）。対象はローカルライブラリの現在版205件・205 GLB。`profile --all --refresh --write` で再計測し、全件のGLBハッシュとプロファイルのハッシュ一致を確認した。既存の台帳・固定版・メモ・動作設定563ファイルのSHA-256は前後で一致した。

画像の幅または高さが不明なプロファイルは0件。ゼロは未計測を表す値ではない。

数値の元表は [同日のCSV](render-load-2026-10-18.csv)。各行にID・カテゴリ・GLB SHA-256・計測日時・4指標を保存した。生プロファイルは `catalog/profiles/` にあり、Gitには含めない。`catalog/` と `.store/` の両方を別途バックアップする。

## 集計の読み方

- アセット1件の現在版を1観測とする。過去版・異なる計測器との比較は含めない。
- 中央値は偶数件のとき中央2件の算術平均。90%点は昇順の `ceil(0.9 × 件数)` 番目。上位一覧は値の降順、同値はIDの昇順で20件。
- バイトは整数の元値、MiBは1,048,576バイト。頂点属性は参照された一意なaccessorの論理バイト数。テクスチャ展開後はRGBA8・ミップマップなし。
- 描画三角形は既定シーンのインスタンスを含む。フレーム時間・GPU時間・影・ボリュームVFXの演算量・実機のメモリ割当は測っていない。GLBの仕様適合は見た目・スケール・ゲーム組込みの保証ではない。

## 全体・カテゴリ別の中央値と最大値

| カテゴリ | 件数 | コール 中央 / 最大 | 描画三角形 中央 / 最大 |   頂点バイト 中央 / 最大 | 展開後バイト 中央 / 最大 |
| -------- | ---: | -----------------: | ---------------------: | -----------------------: | -----------------------: |
| 全体     |  205 |       113 / 71,717 |   31,499 / 204,391,691 |  1,359,736 / 503,180,152 | 12,582,912 / 185,597,952 |
| 動物     |    6 |              1 / 1 |          2,669 / 4,340 |         87,256 / 179,032 |            0 / 4,194,304 |
| 建物     |   57 |       477 / 12,633 |     47,092 / 1,734,466 |   1,912,512 / 91,388,880 | 16,777,216 / 134,217,728 |
| 人物     |    4 |              1 / 1 |              820 / 952 |        147,600 / 171,360 |                    0 / 0 |
| VFX      |    4 |          126 / 170 |        14,220 / 16,646 |        421,488 / 627,776 |           0 / 16,777,216 |
| 地形・島 |   13 |       656 / 71,717 |  560,670 / 204,391,691 | 28,912,720 / 503,180,152 |     770,048 / 57,491,456 |
| 小道具   |   96 |         22 / 1,149 |     14,454 / 1,201,176 |     437,296 / 76,688,704 |     655,360 / 33,554,432 |
| 船       |   25 |        302 / 2,923 |    140,396 / 2,533,164 |   6,811,632 / 79,082,488 | 16,777,216 / 185,597,952 |

## 傾向と予算案（未確定）

船だけの問題ではない。船のコール中央値302に対し建物は477、島・地形は656で、島の最大71,717が突出する。小道具は中央値22で、同じ固定予算を一律適用すると用途の違いを見失う。島や街の集合体を船1隻・小道具1個と同じ単位で比較しない。

まずカテゴリ中央値を「次のゲーム向け形態の暫定目標」、90%点を「先に調べる候補を絞る目安」とする案。いずれも実測分布から置いた提案で、採用済み上限ではない。超過しても登録拒否・承認待ち・削除にしない。統合による描画コール削減、テクスチャ共有・解像度、同時表示数を検討し、対象端末と代表シーンの時間計測で見直す。

| 用途      | コール暫定目標 / 優先調査の目安 | 描画三角形 暫定目標 / 目安 | テクスチャMiB 暫定目標 / 目安 |
| --------- | ------------------------------: | -------------------------: | ----------------------------: |
| 船1件     |                     302 / 2,515 |        140,396 / 1,722,753 |                       16 / 48 |
| 建物1件   |                     477 / 4,793 |         47,092 / 1,077,328 |                       16 / 32 |
| 小道具1件 |                        22 / 427 |           14,454 / 158,000 |                      0.6 / 32 |

正本を置換して削減しない。#10の派生設計では正本の固定版から兄弟IDを作り、可動部と見た目を維持した形態を比較する。LODや衝突形状を大量に恒久保存する前に、実際に利用する1形態と再生成条件を決める。

## 描画コール 上位20件

| 順位 | ID                                              | カテゴリ |     値 |
| ---: | ----------------------------------------------- | -------- | -----: |
|    1 | `tbt.tsumugi.054-industrial-british-island-wip` | 地形・島 | 71,717 |
|    2 | `tbt.tsumugi.083-industrial-graving-dock`       | 建物     | 12,633 |
|    3 | `tbt.tsumugi.074-coal-merchant-yard`            | 地形・島 | 10,401 |
|    4 | `tbt.tsumugi.078-workers-rear-yards`            | 地形・島 |  7,000 |
|    5 | `tbt.tsumugi.057-great-harbor-engine-works`     | 建物     |  5,885 |
|    6 | `tbt.tsumugi.042-dock-pump-house`               | 建物     |  5,327 |
|    7 | `tbt.tsumugi.076-workers-washhouse`             | 建物     |  4,859 |
|    8 | `tbt.tsumugi.073-treaty-port-kura`              | 建物     |  4,847 |
|    9 | `tbt.tsumugi.023-quayside-warehouse`            | 建物     |  4,793 |
|   10 | `tbt.tsumugi.034-steamship-graving-dock`        | 建物     |  3,909 |
|   11 | `tbt.tsumugi.093-pirate-cove-layout`            | 地形・島 |  3,363 |
|   12 | `tbt.tsumugi.088-pirate-steam-raider-wip`       | 船       |  2,923 |
|   13 | `tbt.tsumugi.022-coastal-steamer`               | 船       |  2,836 |
|   14 | `tbt.tsumugi.070-industrial-gasholder`          | 建物     |  2,731 |
|   15 | `tbt.tsumugi.050-auxiliary-screw-steamer`       | 船       |  2,515 |
|   16 | `tbt.tsumugi.026-brick-engine-works`            | 建物     |  2,317 |
|   17 | `tbt.tsumugi.087-pirate-brig-wip`               | 船       |  2,248 |
|   18 | `tbt.tsumugi.066-factory-loading-canopy`        | 建物     |  2,184 |
|   19 | `tbt.tsumugi.086-broadside-brig-wip`            | 船       |  2,170 |
|   20 | `tbt.tsumugi.032-workers-terrace`               | 建物     |  2,119 |

## 描画三角形 上位20件

| 順位 | ID                                              | カテゴリ |          値 |
| ---: | ----------------------------------------------- | -------- | ----------: |
|    1 | `tbt.tsumugi.054-industrial-british-island-wip` | 地形・島 | 204,391,691 |
|    2 | `tbt.island.shio.runtime`                       | 地形・島 |   3,367,613 |
|    3 | `tbt.tsumugi.088-pirate-steam-raider-wip`       | 船       |   2,533,164 |
|    4 | `tbt.tsumugi.022-coastal-steamer`               | 船       |   2,522,816 |
|    5 | `tbt.island.akari`                              | 地形・島 |   2,258,866 |
|    6 | `tbt.tsumugi.032-workers-terrace`               | 建物     |   1,734,466 |
|    7 | `tbt.tsumugi.040-harbor-steam-tug`              | 船       |   1,722,753 |
|    8 | `tbt.tsumugi.050-auxiliary-screw-steamer`       | 船       |   1,719,708 |
|    9 | `tbt.tsumugi.052-fluyt-merchant`                | 船       |   1,480,572 |
|   10 | `tbt.tsumugi.023-quayside-warehouse`            | 建物     |   1,453,730 |
|   11 | `tbt.tsumugi.038-harbor-clock-tower`            | 建物     |   1,345,935 |
|   12 | `tbt.island.shio`                               | 地形・島 |   1,340,209 |
|   13 | `tbt.tsumugi.042-dock-pump-house`               | 建物     |   1,333,402 |
|   14 | `tbt.tsumugi.053-diesel-general-cargo`          | 船       |   1,275,264 |
|   15 | `tbt.tsumugi.077-tidal-landing-stairs`          | 小道具   |   1,201,176 |
|   16 | `tbt.tsumugi.029-industrial-harbor-pub`         | 建物     |   1,159,308 |
|   17 | `tbt.tsumugi.083-industrial-graving-dock`       | 建物     |   1,077,328 |
|   18 | `tbt.tsumugi.051-coastal-schooner`              | 船       |   1,006,048 |
|   19 | `tbt.tsumugi.074-coal-merchant-yard`            | 地形・島 |   1,004,210 |
|   20 | `ocean.starter.sloop.study.v1`                  | 船       |     861,938 |

## 頂点属性バイト 上位20件

| 順位 | ID                                              | カテゴリ |          値 |
| ---: | ----------------------------------------------- | -------- | ----------: |
|    1 | `tbt.tsumugi.054-industrial-british-island-wip` | 地形・島 | 503,180,152 |
|    2 | `tbt.tsumugi.083-industrial-graving-dock`       | 建物     |  91,388,880 |
|    3 | `tbt.tsumugi.022-coastal-steamer`               | 船       |  79,082,488 |
|    4 | `tbt.tsumugi.032-workers-terrace`               | 建物     |  77,656,848 |
|    5 | `tbt.tsumugi.077-tidal-landing-stairs`          | 小道具   |  76,688,704 |
|    6 | `tbt.island.shio`                               | 地形・島 |  67,222,348 |
|    7 | `tbt.tsumugi.023-quayside-warehouse`            | 建物     |  66,937,320 |
|    8 | `tbt.island.akari`                              | 地形・島 |  62,944,140 |
|    9 | `tbt.tsumugi.088-pirate-steam-raider-wip`       | 船       |  54,350,888 |
|   10 | `tbt.building.commercial-tavern`                | 建物     |  54,028,080 |
|   11 | `tbt.tsumugi.042-dock-pump-house`               | 建物     |  53,757,656 |
|   12 | `tbt.tsumugi.038-harbor-clock-tower`            | 建物     |  53,705,000 |
|   13 | `tbt.tsumugi.029-industrial-harbor-pub`         | 建物     |  50,106,616 |
|   14 | `tbt.tsumugi.074-coal-merchant-yard`            | 地形・島 |  46,919,136 |
|   15 | `tbt.tsumugi.078-workers-rear-yards`            | 地形・島 |  46,472,336 |
|   16 | `tbt.island.shio.runtime`                       | 地形・島 |  43,196,760 |
|   17 | `tbt.tsumugi.050-auxiliary-screw-steamer`       | 船       |  39,625,552 |
|   18 | `tbt.tsumugi.040-harbor-steam-tug`              | 船       |  36,170,056 |
|   19 | `tbt.tsumugi.026-brick-engine-works`            | 建物     |  35,091,008 |
|   20 | `tbt.tsumugi.052-fluyt-merchant`                | 船       |  34,209,296 |

## テクスチャ展開後バイト 上位20件

| 順位 | ID                                          | カテゴリ |          値 |
| ---: | ------------------------------------------- | -------- | ----------: |
|    1 | `tbt.tsumugi.000-initial-sloop-v5-realism`  | 船       | 185,597,952 |
|    2 | `tbt.tsumugi.032-workers-terrace`           | 建物     | 134,217,728 |
|    3 | `tbt.tsumugi.052-fluyt-merchant`            | 船       | 134,217,728 |
|    4 | `tbt.tsumugi.057-great-harbor-engine-works` | 建物     |  67,108,864 |
|    5 | `tbt.tsumugi.066-factory-loading-canopy`    | 建物     |  67,108,864 |
|    6 | `tbt.building.commercial-tavern`            | 建物     |  58,195,968 |
|    7 | `tbt.island.shio`                           | 地形・島 |  57,491,456 |
|    8 | `ocean.starter.sloop.sailing.v1`            | 船       |  50,331,648 |
|    9 | `ocean.starter.sloop.study.v1`              | 船       |  50,331,648 |
|   10 | `tbt.island.shio.runtime`                   | 地形・島 |  39,713,632 |
|   11 | `tbt.tsumugi.008-merchant-balance`          | 小道具   |  33,554,432 |
|   12 | `tbt.tsumugi.009-open-salt-sack`            | 小道具   |  33,554,432 |
|   13 | `tbt.tsumugi.010-ship-bell`                 | 小道具   |  33,554,432 |
|   14 | `tbt.tsumugi.011-captains-logbook`          | 小道具   |  33,554,432 |
|   15 | `tbt.tsumugi.013-sailors-sea-chest`         | 小道具   |  33,554,432 |
|   16 | `tbt.tsumugi.014-stock-anchor`              | 小道具   |  33,554,432 |
|   17 | `tbt.tsumugi.015-tavern-stool`              | 小道具   |  33,554,432 |
|   18 | `tbt.tsumugi.016-copper-cooking-pot`        | 小道具   |  33,554,432 |
|   19 | `tbt.tsumugi.017-chart-table`               | 小道具   |  33,554,432 |
|   20 | `tbt.tsumugi.018-wooden-capstan`            | 小道具   |  33,554,432 |
