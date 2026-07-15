# Anima プリセット

## 構成

`ReferenceFlows/Reference-AnimaUnifiedSwitchWorkflow.json` は [Anima int8 / mxfp8](https://civitai.com/models/2754368?modelVersionId=3128953) の「Aesthetic v1.1 - int8」（Civitai model version `3128953`）を既定にした API 形式ワークフローで、モデル選択の Anima モーダルから WorkflowTemplate として追加する。このモデルは Anima Aesthetic v1.1 の量子化派生モデルであり、公式 Anima Base v1.0 そのものではない。

| 種別 | ファイル | ComfyUI 配置先 |
| --- | --- | --- |
| diffusion model | `animaInt8Mxfp8_aestheticV11Int8.safetensors` | `models/diffusion_models` 直下 |
| text encoder | `qwen_3_06b_base.safetensors` | `models/text_encoders` |
| VAE | `qwen_image_vae.safetensors` | `models/vae` |

diffusion model は表の正確なファイル名で `ComfyUI/models/diffusion_models` 直下へ手動配置する。`UNETLoader.weight_dtype` は `default` のままとし、safetensors内の量子化情報を使用する。`CLIPLoader(type=stable_diffusion)`、Qwen Image VAE、`er_sde` / `simple` / 30 steps / CFG 4 を既定にする。プロンプト方言は tags、quality prefix は `masterpiece, best quality, score_7, safe`。

### INT8モデルの固定情報と導入境界

- Civitai model version: `3128953`（`Aesthetic v1.1 - int8`）
- ファイル名: `animaInt8Mxfp8_aestheticV11Int8.safetensors`
- SHA-256: `0ECAFB8889998FCC4BAD2CF38A6E9427E0699718F50C95C8DDF025ECB3223E16`
- 形式: SafeTensor / INT8、配布サイズ約2.10 GiB

GURUGURUはこのモデルを同梱・自動取得しない。利用者が配布ページと上流Animaのライセンス、帰属、再配布・商用利用条件を確認したうえで導入する。ファイル名やhashが異なる版を、同じ既定モデルとして扱わない。

既にDBへ追加済みのWorkflowTemplateはスナップショットであり、バンドルworkflowの更新では書き換わらない。INT8既定を使うには更新後のAnimaプリセットを新規追加するか、既存テンプレートのnode `731`（`UNETLoader.unet_name`）を上記ファイル名へ明示的に変更する。

Anima Base v1.0は手動互換fallbackとして残す。必要な場合は `anima-base-v1.0.safetensors` を `ComfyUI/models/diffusion_models` 直下へ配置し、workflowを複製してnode `731`の`unet_name`だけを同ファイル名へ戻す。text encoder、VAE、`weight_dtype=default`は維持する。実行中にINT8モデルが見つからない場合の自動fallbackは行わず、再現性を保つためpreflightで不足として扱う。

## 対応範囲

- txt2img、img2img、4種の `maskedContent` を含む inpaint は統合 Switch 経路を共有する。
- Anima 用 `LoraLoaderModelOnly` LoRA は UNET と `CFGGuider` / 2本の `BasicScheduler` の間へ同じチェーンを挿入する。Chroma/SDXL 用 LoRA を流用しない。
- Chroma 用 ControlNet と PuLID-Flux はアーキテクチャ非互換のため Anima では常に無効。ControlNet モードは生成前に明示エラーにする。参照画像の PuLID トグルは Anima 生成へ注入しない。
- 承認済み Reference Set の face + full_body を Anima In-Context Character へ渡せる。`anima-incontext-character.safetensors` と対応ノードが揃う場合だけ有効になる。interactive生成は警告付きbase fallback、自動漫画はpreflightで停止する。

モデルファミリはワークフロー内の `anima-*`、`animaInt8Mxfp8_*`、または `qwen_3_06b_base` から判定し、ComfyUI モデル確認と生成時 feature gate の両方へ渡す。

## Anima In-Context Character / Reference Set

Reference Set は `character_reference_sets` に character / variant / model family / version / state / generation source と、ユーザー入力の日本語外見設定・保存済み英語appearance prompt・must-not-changeを持つ。`character_reference_images` は face / full_body、寸法、crop / mask、checksum、asset / roundを持つ。画像本体はユーザーデータ領域の `projects/<projectId>/character_reference_sets` に保存し、APIへ絶対パスを返さない。

自動生成・再生成・アップロードはいずれも候補を `review` にするだけで、自動採用しない。人間が承認した版だけが `approved` になり、外見設定を変更して次版を作ると旧版は `stale` 表示になる。ただし、既存Manga Runの再試行を再現できるよう、snapshot済みの旧承認版はID/version/hash指定で引き続き解決できる。既存 `character_bindings.faceImagePath` はChroma PuLID用legacy fallbackとして残す。

生成Roundでは採用版の画像をRound専用ファイルへ個別コピーし、ComfyUIへ各1回だけuploadする。ワークフロー送信直前に次のMODELチェーンを動的に組み立てる。

`UNETLoader → ユーザーLoRA群 → anima-incontext-character LoRA → AnimaInContextApply`

face / full_body はそれぞれ `LoadImage → AnimaRefEncode(VAELoader)` でencodeし、`AnimaRefLatentBatch(fit_mode=pad)`へ同一人物の2件だけを接続する。Apply後のMODELを`CFGGuider`とtxt2img/img2img両方の`BasicScheduler`へ同時に配線する。既定値はstrength 1、start 0、end 1、`cond_only=true`、`fit_mode=pad`で、参照encodeのtarget sizeは生成width/heightである。12GBで二枚が成立しないショットでは、顔アップにface、遠景にfull_bodyを渡す一枚フォールバックを診断比較する。

必要物は次のとおり。

- `ComfyUI/models/loras/anima-incontext-character.safetensors`（PoCではroot直下のchoice文字列を固定使用）
- `AnimaRefEncode`、`AnimaRefLatentBatch`、`AnimaInContextApply`を登録する外部ノードパック
- Anima互換テンプレート（既定はAesthetic v1.1 INT8、Base v1.0は手動fallback）

モデル選択のAnimaモーダルは、adapterとノード入力schemaを`/object_info`で確認する。生成時も同じ判定を行い、Chromaへ誤注入しない。サブフォルダ内の同名adapterは「導入済み」とみなさない。

### モデル別経路と境界

- Chromaは承認済みfaceだけをPuLIDへ渡す。Animaはface + full_bodyをencodeしてLatentBatchへ渡す。
- Script Mangaはworkflow familyごとに採用版を解決し、承認時にset ID / version / image checksum / 外見設定をsnapshotする。retry / resumeもsnapshotを再利用し、すべてのprompt方言へ英語外見設定とmust-not-changeを注入する。
- MVPで参照を配線するのはfocal character一人だけ。全castのmanifestとsnapshotは保持するが、複数人物を同じLatentBatchへ入れない。次段はbbox maskを作り、一人ずつAnima inpaintする。
- visible castの未承認参照、cast重複、画面外話者混入はpreflight対象。自動漫画はsilent fallbackせず停止し、interactiveだけ画面上の警告を伴ってbase生成へ戻せる。
- adapter/modelは[配布元モデルカード](https://huggingface.co/darask0/Anima-InContext-Character)上で非商用派生物。Anima Base v1.2の[ライセンス](https://huggingface.co/circlestone-labs/Anima/blob/main/LICENSE.md)もモデルと派生物の商用・production利用を制限する一方、出力は派生物に含めず商用利用可能としている。配布時は同ライセンスと帰属表示が必要。GURUGURUはadapter/node/modelを自動同梱・自動取得せず、利用者が条件を確認して任意導入する。node packコード単体の別ライセンスが確認できるまではadapterと同じ非商用扱いとする。
- 実機比較は本番8188ではなく `sandbox/scripts/check-reference-set.mjs` を隔離8288へ実行する。3キャラ×4構図×4参照モードを固定seed・batch 1で比較し、時間とpeak VRAMをmanifestへ保存する。出力先は必ずrepository外。評価後の勝者だけ `--phase 1024 --scores <scores.json>` で昇格する。2026-07-13実測では768のface+full_bodyが12/12でidentity改善、最大7.33 GiB。1024の選抜一枚構成も最大7.48 GiBでOOMなしだったが、waist-upで小物重複が増えたため製品既定は768、face close-up / full-body / distantだけ1024任意とした。
