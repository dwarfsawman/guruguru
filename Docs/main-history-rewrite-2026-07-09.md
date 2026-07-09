# 【要対応】main の履歴書き換え通知 (2026-07-09)

他セッション(特に `book-page-grid` / `feature/book-reader` = Book Viewer / manga reader mode で作業中の方)向けの連絡です。**あなたのブランチを main に取り込む前に必ず読んでください。**

> **⚠️ 2026-07-09 追記: main は同日中にもう一度書き換えられました。** 個人ローカルパス(開発者のユーザー名を含む `C:\Users\<user>\...` 形式)を全履歴から除去する2回目の書き換えを実施し、`origin/main` へ再度 force-push 済みです。下記本文の `bcf036c` はこの2回目の書き換えで**さらに書き換わっており、もう存在しません**。最新の tip は **`499de75`** です。詳細は末尾の「[追記] 2回目の書き換え」セクションを参照してください。



## 何が起きたか

`main` の **git 履歴を書き換え**、日本語フォント `src/client/fonts/noto-sans-jp-*.woff2`(120ファイル, 約5MB)を**全履歴から除去**しました。さらに `origin/main` へ **force-push 済み**です。

| | 旧 | 新 |
|---|---|---|
| local/origin `main` tip | `c1d4428` | **`bcf036c`** |
| フォント追加コミット `16d1e56` 以降のハッシュ | 旧ハッシュ | すべて変化 |

- **tip の内容(ファイル)は不変**です。woff2 は元々削除済みで、履歴からも消えただけ。IBM Plex フォントは維持。
- バックアップ: タグ `backup/pre-font-purge`(= 旧 main `c1d4428`)と `refs/original/refs/heads/main` を保持。復旧可能です。

## あなたのブランチの現状

`book-page-grid`(`eb8766f`)も `feature/book-reader`(`8c60104`)も、**書き換え前の古い main コミットを指しており、まだ woff2 を120個保持**しています。つまり書き換え後の新しい `main` とは履歴が分岐した状態です。

**今の作業はそのまま続けて構いません。** 慌ててブランチを動かす必要はありません。問題になるのは「main に取り込む/マージする」ときだけです。

## ⚠️ 絶対にやってはいけないこと

以下を**今の状態のまま実行しないでください**。履歴が二重化し、かつ**削除した Noto フォントが復活します**:

```
git pull                     # ❌ main 追跡時
git merge origin/main        # ❌
git rebase origin/main       # ❌ (= git rebase bcf036c)
git merge main               # ❌
```

理由: あなたのブランチと新 main の共通祖先は `16d1e56^`(フォント追加の1つ前)まで遡ります。素朴な rebase/merge は、フォントを追加した**古い `16d1e56` を再生**してしまい、woff2 が戻ってきます。

`git fetch`(追跡refの更新のみ)は安全です。

## ✅ 正しい取り込み手順(作業完了後)

新 main へは **`git rebase --onto` で載せ替え**てください。「自分の作業を始めた時点のコミット」を upstream に指定するのがポイントです。

- `book-page-grid` の場合(このセッション開始時点の土台 = `eb8766f`):
  ```
  git fetch origin
  git rebase --onto bcf036c eb8766f book-page-grid
  ```
- `feature/book-reader` の場合(土台 = `8c60104`):
  ```
  git fetch origin
  git rebase --onto bcf036c 8c60104 feature/book-reader
  ```

これで「あなたが新しく積んだコミットだけ」がフォント無しの新 main の上に載り、woff2 は土台側にしか無いため自然に消えます(あなたのコミットは woff2 に触れていないことを確認済み)。コンフリクトが出るとしてもフォント以外の通常の内容差分のみです。

### 取り込み後の検証(必須)

```
git log --oneline -- 'src/client/fonts/noto-sans-jp-*.woff2'   # → 空であること
git ls-files 'src/client/fonts/noto-sans-jp-*'                 # → 空であること
git ls-files 'src/client/fonts/'                               # → ibm-plex-* のみ 4件
```

### 代替案(自ブランチも履歴書き換えしたい場合)

```
FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch --index-filter \
  "git rm -r --cached --ignore-unmatch 'src/client/fonts/noto-sans-jp-*.woff2'" \
  -- '16d1e56^..<あなたのブランチ>'
```
を実行してから統合。ただし通常は上記 `rebase --onto` の方が簡単・安全です。

## 困ったときの復旧

```
git reset --hard backup/pre-font-purge   # 旧 main(c1d4428)に戻す
git push --force-with-lease origin main   # origin も旧状態へ戻す(必要時のみ)
```

## 残タスク(全 feature ブランチ整理後)

ローカル `.git` はまだ縮んでいません(feature ブランチが woff2 blob を参照中のため)。すべての feature ブランチを新 main に載せ替え・整理し終えたら、以下でローカルも回収できます:

```
git tag -d backup/pre-font-purge
git update-ref -d refs/original/refs/heads/main
git reflog expire --expire=now --all
git gc --prune=now
```

(GitHub 側は force-push 済みのためサーバー gc で自動回収されます)

---

## [追記] 2回目の書き換え: 個人ローカルパスの除去 (2026-07-09)

上記のフォント除去とは**別件・別目的**の書き換えです。`操作メモ.md` / `Docs/Done/第二次リファクタリング計画.md`、および既に削除済みだった `Docs/Handoff-Phase5-ConsistentCharacter.md` の履歴内に、開発者のローカル環境パス(ユーザー名を含む `C:\Users\<user>\...` 形式)が生の形で残っていたため、`git-filter-repo --replace-text` で一般化しました(例: `C:\Users\<user>\AppData\Local\Comfy-Desktop\...` → `$env:LOCALAPPDATA\Comfy-Desktop\...`)。ファイル内容(現行分)はいずれも意味は変わらず、パス表記のみ一般化されています。

| | 旧 | 新 |
|---|---|---|
| local/origin `main` tip | `ce3af3d` | **`499de75`** |
| バックアップ tag | `backup/pre-path-redaction` (= `ce3af3d`) | |

**重要: この書き換えで `bcf036c` を含む直近14コミットのハッシュも変わりました。** つまり、上記本文の指示に従って既に `git rebase --onto bcf036c ...` を実行済みのブランチがある場合、そのブランチは「もう存在しない `bcf036c`」の上に乗っています。今後 main へ統合する際は、下記のとおり**もう一段 rebase --onto が必要**です。

### 影響範囲

- 書き換え対象は **`main` ブランチのみ**(`--refs main` でスコープ限定)。ローカルの他の feature ブランチ・worktree(`.claude/worktrees/*` 含む)は一切触っていません。
- `origin` に push 済みだった `claude/iteration-tree-edge-popout-9v7o92` / `claude/llm-thinking-indicator-1trvyk` の2ブランチはこの個人パスを含んでいなかったため対象外・変更なしです。

### ✅ 統合手順(まだ main に取り込んでいない場合)

本文と同じ考え方です。「自分の作業を始めた時点のコミット」を `--onto` の除外側に指定します。汎用的には次の1行で求まります:

```
git fetch origin
git rebase --onto main $(git merge-base <あなたのブランチ> ce3af3d) <あなたのブランチ>
```

(`ce3af3d` は旧 main tip。`backup/pre-path-redaction` タグとしてローカルに残っているので `merge-base` は解決できます。既に `bcf036c` ベースで rebase 済みの場合は `ce3af3d` の代わりに `bcf036c` を使っても同じ結果になります。)

### 困ったときの復旧(2回目書き換え分)

```
git reset --hard backup/pre-path-redaction   # このセッション開始時点の main (ce3af3d) に戻す
git push --force-with-lease origin main       # origin も戻す(必要時のみ)
```

さらに遡って完全に元(フォント除去前)に戻す場合は本文の `backup/pre-font-purge` を使ってください。
