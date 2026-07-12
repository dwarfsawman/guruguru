# Feature: Fountain 自動漫画生成

## 目的

Fountain revision を入力として、脚本の全発話を保持したままページ分割・コマ割り・コマ別画像生成・吹き出し配置を行い、既存のページ書き出し機能へ渡せる状態まで進める。

## 実装

- `src/shared/scriptMangaPlan.ts`: シーン境界を跨がず、既定で最大6要素/2発話を1コマ、4コマを1ページへまとめる決定的プランナー。1〜6コマに一致するlayoutを選び、各コマにsource element IDと`dialogue_lines.order_index`を保持する。台詞本文は画像promptへ転記せず、speech act・表情・mouth state等の視覚状態へ変換する。
- `src/shared/mangaPlanV2.ts` / `src/server/scriptMangaPlanV2.ts`: 作成時の`script_revision_id`、`dialogueSnapshots`、ページごとの`layoutSnapshot`、planner/compiler version、LLM model/messages/raw output provenanceを固定し、NarrativeGraph、WorldState、Beat、PageSpec、PanelSpec、ReferenceManifest、must/must-not、text safe zoneを同じJSON契約へまとめる。planは画像生成より先に検証・永続化し、実行時にmutableな台詞やlayout templateを再解決しない。詳細は[`Docs/Feature-MangaPlanV2.md`](../Feature-MangaPlanV2.md)を参照。
- `src/server/scriptMangaDirector.ts`: `planningMode: "llm"` で OpenAI 互換LLMをネーム監督として挿入する。4ページ単位で画角・主役・単一アクション・感情・構図・英語画像プロンプトを構造化JSON化し、コマ数に合う非対称レイアウトも選ぶ。ページ数・コマID・台詞対応はLLMに変更させず、既存の全発話保持保証を維持する。
- `characterBible` を渡すと全バッチの監督プロンプトへ同じ固定票を再注入する。髪型、年齢、体格、服装、固有装備を明記して人物同一性を固定する用途で、未指定時も同名人物の外見固定をLLMへ要求する。
- `planningMode: "provided"` と `directorPlan` で、外部LLMや人間が作ったネームをそのまま実行できる。全台詞orderIndexが重複・欠落なく一度ずつ存在すること、ページ連番、panel id一意、layoutとコマ数、scene範囲を検証してからDBを変更する。
- 比較実験用に `pageLimit` で先頭Nページだけを生成でき、`loras: [{ name, strength }]` は通常の生成と同じChromaモデル専用LoRAチェーンへ渡す。偽文字対策として文字・看板・UI・設定画・分割画面をnegative promptへ明示する。
- `generateImages: false`ではplan、run所有ページ、コマ枠、吹き出し、pending taskまで作ってrunを`prepared`にする。`approve`→`start`で同じrunを開始でき、プロセス再起動後は`resume`できる。planは承認前にGET/PATCH可能で、preparedは行き止まりではない。
- 追加レイアウトは上段大ゴマ3コマ、右縦大ゴマ3コマ、下段大ゴマ3コマ、下段大ゴマ4コマ、右縦大ゴマ4コマ、5コマ、6コマ。均等グリッドだけでなく、導入→反応→決め、追跡、発見の緩急を作れる。
- `src/server/scriptManga.ts`: `POST /api/projects/:projectId/script-manga-runs`は、固定revisionのplanを保存してからrun所有ページ・placements・吹き出し・taskをmaterializeし、画像生成時だけbatch=1のgeneration roundへ接続する。生成長辺は既定1024pxで、`longEdge`(512〜1536)、`steps`、`cfg`、`sampler`、`scheduler`を実行ごとに指定できる。
- Character aliasと`dialogue_lines.character_id`をentityへ解決し、runのproviderに対応する`character_bindings`の顔/LoRAをPanelSpecへ保存する。現在のwire requestは主参照の顔1件へdowngradeするが、他人物の参照もManifestから捨てない。
- provided/LLMプランのコマ順は、吹き出し自動配置と同じ読書順（日本語既定は上→下、右→左）でレイアウトへ割り当てる。`layout.panels[].order` は描画順なので、非対称レイアウトの画像対応には使わない。さらに各発話のplacementへ監督指定のコマIDを先に保存し、無言コマを挟んでも自動分配で台詞を前詰めしない。
- `GET /api/script-manga-runs/:runId`: round状態を候補assetとメタデータscoreへ同期する。候補policyは常に人間reviewで、最初のassetやVLM pass候補を自動採用しない。`POST /api/script-manga-tasks/:taskId/select`で候補を明示採用した後だけ対象コマへ割り当てる。ポーリングとresumeは冪等。
- `auditMode: "vlm"`は、LM Studioへ事前importしたHauhauCS Gemma-4-E2B Q6_K_P + matching mmprojをnative APIでon-demand loadする。ComfyUI global queueのidle確認後に`/free`し、candidate medium thumbnail + identity参照（既定3、設定0〜6）を全task直列で監査する。reasoningはoff、返答はscore/checks/violationsの厳格JSONとして再検証し、最後にVLMをunloadする。監査失敗は人間reviewへfail-openする。
- Script画面へMangaPlan V2最小UIを追加し、template/planning/panel count/dialogue/audit mode、prepare、承認、開始、再開、更新、キャンセル、plan warning、VLM readiness/on-demand/unreachable/OFF状態・score・違反、candidate原寸確認・再生成・採用、completed runのPNG/PPTX/ORA downloadを操作できる。
- run所有ページのlayout変更・直接削除と、task履歴を含むround tree削除を409で拒否する。completed runは`POST /api/script-manga-runs/:runId/export`で所有pageだけをPNG/JPEG/PPTX/ORAへ書き出し、`export_manifest_json`へ固定する。
- 自動漫画の本文は商業漫画相当の視認性を狙い、基準0.04にfontScale=0.88を掛けた0.0352 page-widthで配置する。既定日本語フォントは同一ファミリーのBold faceを優先する。吹き出しサイズは楕円・thought・compoundごとの内接係数まで逆算して本文サイズを維持し、それでも収まらない長文だけ自動フィットで縮小する。全件探索が失敗した場合は2発話ずつへ分割し、通常のChronicle操作はfontScale=1のまま。
- `POST /api/projects/:projectId/pages/:pageId/fit-balloon-text`: 書き出しと同じ折返し幅・形状別内接係数・実フォントbboxで検査し、はみ出す文字だけを最小0.008まで段階的に縮小する。吹き出し位置/大きさ/尻尾は維持する。
- MangaPlanV2経路ではfit後の本文が0.02 page-width未満ならpreflight相当の品質gateで拒否し、読めない大きさのまま生成へ進めず台詞分割または再計画を要求する。
- 自動漫画では吹き出し配置直後に `fitPageBalloonText` を実行する。画像生成完了やPPTX書き出しを待たず、ページがUIに現れた時点から文字を内接矩形へ収める。
- 顔アンカー未取得の初期状態でもしっぽを真下固定にせず、右側の吹き出しは左下、左側は右下、中央は発話順に左右交互へ向ける。先端は割当コマの外接矩形から2.5%内側へclampし、隣接コマへ越境させない。画像完成後は従来どおり顔検出した口元アンカーで上書きする。
- Book作成直後の完全に未使用なスターターページ1枚だけを自動実行前に削除する。

## 話者アンカー

全身Poseは顔アップや背面で不適切だった。MediaPipe Face Landmarkerも実生成漫画で0件だったため不採用。`hysts/anime-face-detector` の YOLOv3 + HRNetV2(アニメ顔専用、28 landmarks)を採用し、唇点24〜27の中心を口アンカーにした。

`POST /api/projects/:projectId/pages/:pageId/speaker-anchors` は各コマの画像正規化口座標を受け取り、cropを介してページ座標へ変換する。同じコマの発話順と読書方向に並べた顔を対応させ、吹き出し本体はS5の衝突回避位置に保ったまま尻尾先端を口元へ向ける。顔未検出・低信頼度・thought balloonは変更しない。

尻尾先端は唇へ直接接触させず、顔bboxの長辺28%（page座標で0.012〜0.055にclamp）だけ吹き出し側へ手前で止める。遠景でも最低余白を確保し、大きな顔では過剰に離れない。

## 実機結果（2026-07-11）

- 入力: `ALICE_REBOOT_E01_speaker_fixed.fountain`（16 scenes / 644 elements / 233 dialogues）
- 出力: 37 pages / 148 panels / 148 generated assets / failed 0
- GPU: NVIDIA GeForce RTX 4070 SUPER 12GB
- モデル: SDXL Turbo fp16、4 steps、CFG 1、Euler ancestral、batch 1、各コマ長辺768px
- 生成時間: 約3分16秒（全round投入後から完了まで）
- アニメ顔後処理: 479 faces、142 balloon tails更新、errors 0
- 完成PNG ZIP: 37 files (`001.png`〜`037.png`)

## 制約・今後

- 画像promptはPanelSpecから構造的にコンパイルし、台詞本文を含めない。VLM visual auditは人物同一性、行動、偽文字、連続性の補助判定であり、顔embedding、OCR、人物検出等を組み合わせた決定的gateではない。最終採用は常に人が行う。
- groundingは既存Character名/alias、台詞の`character_id`、action内の既知alias、明示tagを扱う。一般的な代名詞・省略主語の照応、衣装・負傷・小物所有の高度な状態追跡は未実装。
- 複数人物のReferenceManifestは保持するが、現行生成requestの顔条件はfocal subject 1件である。regional conditioning、人物ごとの逐次inpaint、違反箇所だけのrepairは別フェーズ。
- taskの`retry`はコマ全体の再生成であり、VLM violation領域だけをinpaintするrepair planner、repair lineage、lettering後のページ可読性監査は未実装。layout/PanelSpecを直接編集するvisual plan editorも今後の範囲である。
- アニメ顔推論のモデル実行は今回の検証後処理で行った。常設UIから完全自動実行するには、検出sidecarまたはWeb向け変換モデルの配布経路を追加する。

## 変更履歴

- 2026-07-12: 狭いコマや通信風船で7〜16文字の短文まで一律0.02 gateに拒否される回帰を修正。実glyph bboxによるfit判定を維持しつつ、自動漫画の拒否下限をB5出力で可読な0.016へ調整。
- 2026-07-12: immutable dialogue/layout/provenance、run所有物保護、P2 UI、LM Studio VLM監査とVRAM swap、completed run exportを追加。監査結果にかかわらず候補採用は人間reviewに固定。
- 2026-07-12: MangaPlanV2制御層を追加。script revision/plan固定、prepare→approve/start/resume/cancel/retry、5/6コマ、Character binding、候補の手動reviewへ対応し、旧来のfirst asset自動採用を廃止。
- 2026-07-12: 自動漫画の本文を0.0272から0.0352 page-widthへ拡大し、既定日本語フォントをRegularからBold優先へ変更。
- 2026-07-12: 非対称レイアウトと無言コマを含むページで画像プロンプトと台詞が別コマへ割り当たる不具合を修正。読書順を統一し、監督指定の発話→コマ対応を固定。
- 2026-07-11: LLMネーム監督層、キャラクター固定票、非対称の大ゴマレイアウト3種、品質優先の生成パラメーターを追加。
- 2026-07-11: 初期吹き出しの尻尾先端を割当コマ内へ制限し、細い隣接コマへの越境を修正。
- 2026-07-11: 初版。Fountain一括生成API、永続進捗、吹き出し縮小フォールバック、アニメ顔口元アンカーを実装し、全37ページを実生成。
- 2026-07-11: 縦書きの事前サイズ計算と実描画の形状内接係数不一致を修正。全233吹き出しを実bboxで自動フィットし、PNG ZIPを再出力。
- 2026-07-11: しっぽが唇へ接触していたため、顔bbox比例の口元余白を追加。全142本を再アンカーしてPNG ZIPを更新。
