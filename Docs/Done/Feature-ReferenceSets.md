# Versioned Reference Set 実施記録

## 目的

キャラクターの顔・髪・衣装・装飾を、会話上のnotesや一時的な顔バインディングから分離し、モデルfamily・variant・版ごとに人間が承認した参照画像と外見条件として固定する。自動漫画のretry / resumeで参照がすり替わらず、ChromaとAnimaがそれぞれ適切な経路だけを使うことを製品条件とした。

## 実装

- `character_reference_sets`: character、variant、model family、version、状態、生成元、日本語外見設定、英語appearance prompt、must-not-change、appearance hash。
- `character_reference_images`: face / full_body、寸法、crop / mask、checksum、asset / generation round。画像本体はrepository外のユーザーデータ領域に保存する。
- ページ一覧のグリッド上部にはキャラクター数・準備済み数・要設定数だけの「レファレンスコーナー」サマリを置く。
  「開く」で詳細モーダルへ移り、キャラクタータブで選択中の1人だけを表示する。選択キャラクター内では従来どおり
  Chroma / Animaの候補生成・再生成・アップロード・比較・承認を行う。専用controllerで扱い、`main.ts`はcompositionだけを行う。
- 自動生成は候補を作るだけで、自動承認しない。Chroma Readyはface、Anima Readyはface + full_bodyを人が承認した時だけ成立する。
- ChromaはfaceをPuLIDへ、Animaはface + full_bodyを個別encodeして同一人物の`AnimaRefLatentBatch`へ接続する。各画像はRound専用コピーを一度だけComfyUIへuploadする。
- interactive生成はadapter/node未導入時に警告付きfallback。自動漫画は必要人物の参照不足をpreflightで止める。
- Script Manga承認時にset ID / version / checksum / 外見設定をsnapshotする。retry / resumeは同じsnapshotを使い、英語directedを含む全promptへappearanceとmust-not-changeを注入する。
- castはcharacter+variantで正規化し、画面外話者をvisual castから除外する。MVPで配線するのはfocal character一人だけで、別人物の参照を同じLatentBatchへ入れない。

## variantと複数人物

成人／若年、通常服／戦闘服などは同一character内の別variantとして別版管理する。現在の複数人物MVPは全員分のmanifestとsnapshotを持つ一方、実際のreference conditioningはfocal一人だけ。次段は構図生成後に人物bboxをmask化し、一人ずつAnima inpaintする。同時batch方式はidentity混線の診断実験に限定する。

## ライセンス判断

[Anima In-Context Character](https://huggingface.co/darask0/Anima-InContext-Character)は非商用派生物として公開されている。[Anima Base v1.2 License](https://huggingface.co/circlestone-labs/Anima/blob/main/LICENSE.md)はモデル・派生物の商用／production利用を制限し、モデル出力自体は派生物ではなく商用利用可能としている。モデル再配布にはライセンス同梱と帰属表示が必要。GURUGURUでは関連model / adapter / nodeを自動同梱・自動downloadせず、任意導入とする。node packコード単体の別ライセンスを確認できるまでは同じ非商用条件として扱う。

## 検証

- migration、API domain、resolver、workflow graph、prompt compiler、preflight、run snapshotの回帰テストを追加した。
- 同一Runの再開前後でset ID / version / face checksum / full_body checksumが一致し、後から新versionを承認しても固定版が変わらないことをテストした。
- 隔離ComfyUI 8288（RTX 4070 SUPER 12GB）で `sandbox/scripts/check-reference-set.mjs` を実行した。長辺768・30 steps・batch 1・固定seedで3キャラ×4構図×4参照モードの48件を完走。平均25.884秒、最大peak VRAM 7,867,414,638 bytes（7.33 GiB）、OOM 0件だった。
- 顔・髪・衣装・装飾の合計を人手で比較し、face+full_bodyは参照なしより12/12構図でidentityを改善した。ポーズ追従と背景混入は別採点し、参照背景の混入は全件1/5（なし）だった。
- 768の総合勝者を1024へ昇格し、最終ショット別一枚構成12件は平均48.418秒、最大peak VRAM 8,033,840,222 bytes（7.48 GiB）、OOM 0件だった。顔寄り6件はface、全身・遠景6件はfull_bodyを採用する。
- 1024のwaist-up 3件中2件でcupが二重化し、face一枚へ落としても解消しなかった。このため製品既定は長辺768とし、1024はface close-up / full-body / distantで任意使用する。画像・manifest・採点票はrepository外へ保存した。
- `GURUGURU_TEST_DB=1`で全848テスト、`bun run check`、test DB上のReference Set API smokeが成功。1680×920 / 1600×900で横overflow 0、折りたたみ、Ready/確認待ち表示、console error 0を確認した。
- 2026-07-14のUI変更後、1680×920で2キャラクターのタブ切替、モーダル内スクロール、×閉じ、
  Chroma / Anima編集欄の維持、console error 0を確認した。Escape/backdrop閉じはcontroller回帰テストを含め、
  全体916テストが成功。

## 採用条件と残す境界

- 製品既定は長辺768 / batch 1。face+full_bodyは12/12でidentity改善、12GB OOM 0件のため9/12条件とVRAM条件を満たす。ただし実用上は二枚同時よりショット別一枚を優先する。
- 顔、髪、衣装、装飾、ポーズ追従、背景混入は別項目で人が採点し、速度・peak VRAMはスクリプトが測定する。今回の3キャラは隔離環境で作った合成評価セットであり、実在プロジェクトの承認判断を代替しない。
- node packの独立ライセンス確認と、複数人物bbox inpaintは次段のゲートである。

## 変更履歴

- 2026-07-14: Bookグリッドを集計サマリへ縮小し、詳細編集をキャラクタータブ式モーダルへ移動。
- 2026-07-13: Versioned Reference Set、承認UI、family別workflow、Manga Run snapshot/preflight/prompt統合、隔離8288評価ハーネスを実装。
