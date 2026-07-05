# UI洗練化（B案モック準拠）デザインリファクタリング

`Docs/UIMock/extracted/design_handoff_guruguru/GURUGURU.dc.html`（B案ベースのハイファイモック）を正として、
クライアント UI 全体をリスタイリングした際の記録。

## デザイントークン（styles.css `:root`）

- ダークテーマ + 単一 accent `#E2AD81`（派生: `--accent-soft/-line/-fill/-strong`、`--on-accent`）
- サーフェス: `--bg #000` / `--panel #0a0a0c` / `--panel-strong #141417`（モックの panel2）/ `--panel-soft #1c1c20`（panel3）/ `--input #050506`
- ボーダー: `--line rgba(255,255,255,.09)` / `--line-strong .17`
- タイポグラフィ: IBM Plex Sans（本文 12px）+ IBM Plex Mono（数値・パラメータ・セクションラベル）。Google Fonts を `@import`
- 角丸: コントロール 2px / カード 3px / モーダル 4px。シャドウはモーダルのみ、階層はボーダーで表現
- コントロール高: input/select/button 28px、ヘッダー 44px、ツールバー 50px、アクションバー 58px
- スライダー: 細トラック + `--ink` の矩形つまみ（native range を CSS で再現）

## 画面別の変更

- **ヘッダー**: 44px化、`spiral.svg` ロゴ（accent地 24px・scale 1.55）、`GURUGURU` + mono サブラベル、接続ステータスをピル型に
- **Home**: メイン + 右サイド 376px（`border-left`）の2カラム。ComfyUI接続カードの「保存」「接続テスト」は accent 全幅の**「接続」1ボタンに統合**（`connect-comfy` = 設定保存 → 接続テスト。旧 `save-settings` / `test-comfy` アクションも互換のため残置）。新規Projectフォームは 2カラムグリッド化（名前/テンプレート → 説明全幅 → 右寄せ作成ボタン）。プロジェクトカードはサムネ 132×98 + mono メタ行（`Rounds · Assets · Updated`）。見出しに `N projects · N assets` カウント。**New Project の自動採番ルールは変更なし**
- **Project**: 左サイドバー 324px。セクションラベルは mono 10px uppercase。ツールバーに全選択/選択解除/選択反転のセグメントグループ（`.segment-group`）。タイルは下部 20px メタバー（seed チップ + 解像度）付き、選択= accent 1px ボーダー、却下= 画像 28% 不透明、MASK バッジ= warn 地
- **イテレーションツリー**: コンパクト化（高さ clamp(96px,14vh,200px)）。ノードは `--branch-hue` による色ボーダーの丸ノード、active= accent 塗り + リング、実行中(pending)= warn パルス。**独立ツリー（複数ルート）はトラッカーの縦空間が小さいとき（container query `max-height:140px`）に縦積みではなく横並び**
- **アセットモーダル（マスク編集）**: 左 302px マスク・プロンプト / 中央 `#050506` プレビュー / 右 302px スマート選択。タブは accent 下線式。フッターは mono のSeed/Steps/CFG/Sampler 表示。**サイドバー折りたたみ（アイコンのみ表示）機能は維持**。**「マスクをクリア」の名称は維持**。モック作成後に追加された**生成パラメータセクション（ステップ数/CFG/デノイズ強度/幅/高さ/シード/seed mode/サンプラー/scheduler）も維持**（見出しを mono uppercase のセクションラベルに統一）
- **pose / paint パネル**: モック作成後に実装された機能。`websam-panel` / `mask-status` / `range-control` 等の共通クラスを再利用しているため新スタイルを自動継承（マークアップ変更なし）

## 実装メモ

- 旧 CSS のクラス名・DOM 構造・data-action は原則維持（renderロジック無変更）。差分は styles.css の全面リスタイル + 少数のマークアップ調整
- 旧 accent（紫 `#8b5cf6` 系）や旧サーフェス色は一括置換でトークンへ集約済み。今後色を変える場合は `:root` のみ変更すればよい（モックの `applyAccent()` 相当のテーマ可変化は未実装・必要なら派生5変数を再計算）
- ロゴ: `src/client/spiral.svg` を `scripts/build.mjs` で `dist/public/` へコピー
