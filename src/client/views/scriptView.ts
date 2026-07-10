/**
 * 脚本画面(Docs/Feature-ScriptToManga.md S3)。Book レベルの新スクリーン(bookSettingsView と同型、
 * book grid の上に重ねて表示)。Fountain 取り込み/再取り込み、シーン/セリフ一覧、キャラクタ管理、
 * セリフ行のページ割当を1画面にまとめる。state は引数で受け取るため main.ts への逆依存を持たない。
 */
import type { BookPages, Character, CharacterBindingView, DialogueLine, RecentReferenceImage, ScriptRevision } from "../../shared/apiTypes";
import type { MangaScript } from "../../shared/apiTypes";
import { escapeAttr, escapeHtml } from "../format";
import { iconPlus, iconScript, iconTrash } from "../icons";

const SEMANTIC_KIND_LABEL: Record<DialogueLine["semanticKind"], string> = {
  dialogue: "台詞",
  monologue: "心の声",
  narration: "ナレーション",
  sfx: "SFX"
};

export interface ScriptViewProps {
  book: BookPages;
  scripts: MangaScript[];
  activeScriptId: string | null;
  activeScriptRevision: ScriptRevision | null;
  dialogueLines: DialogueLine[];
  fountainDraft: string;
  importBusy: boolean;
  characters: Character[];
  selectedCharacterId: string | null;
  selectedCharacterBinding: CharacterBindingView | null;
  characterLoraNameDraft: string;
  characterLoraStrengthDraft: number;
  characterFacePickerOpen: boolean;
  recentImages: RecentReferenceImage[];
  loraChoices: string[];
}

export function renderScriptView(props: ScriptViewProps): string {
  const { book } = props;
  return `
    <main class="book-layout">
      <section class="panel">
        <div class="panel-heading">
          <div class="book-heading-copy">
            <div class="book-breadcrumb">
              <button class="button-secondary compact book-back-button" type="button" data-action="close-script-screen">← ページ一覧</button>
              <span class="book-page-label">${escapeHtml(book.project.name)}</span>
            </div>
            <h1>脚本<span class="tag">${iconScript()}script</span></h1>
            <p class="book-subtitle">Fountain 脚本を取り込むとキャラクター・セリフ一覧が作られます。再取り込みは既存の配置を維持したまま差分だけ反映します。</p>
          </div>
        </div>
        <div class="script-body">
          ${renderScriptTabs(props.scripts, props.activeScriptId)}
          ${renderImportCard(props)}
          <div class="script-columns">
            ${renderDialogueLinesPanel(props)}
            ${renderCharactersPanel(props)}
          </div>
        </div>
      </section>
    </main>
  `;
}

function renderScriptTabs(scripts: MangaScript[], activeScriptId: string | null): string {
  if (scripts.length <= 1) {
    return "";
  }
  return `
    <div class="script-tabs">
      ${scripts
        .map(
          (script) => `
            <button class="button-secondary compact script-tab ${script.id === activeScriptId ? "is-active" : ""}"
              type="button" data-action="select-script" data-id="${escapeAttr(script.id)}">
              ${escapeHtml(script.title || "(無題)")}
            </button>
          `
        )
        .join("")}
    </div>
  `;
}

function renderImportCard(props: ScriptViewProps): string {
  const warnings = props.activeScriptRevision?.warnings ?? [];
  return `
    <div class="script-import-card">
      <textarea class="script-fountain-textarea" rows="10" placeholder="Fountain 脚本を貼り付けてください。日本語話者は @キャラ名 で行頭を強制してください。"
        data-script-fountain="1">${escapeHtml(props.fountainDraft)}</textarea>
      <div class="script-import-actions">
        <button class="button-primary compact" type="button" data-action="import-script" ${props.importBusy ? "disabled" : ""}>
          ${props.importBusy ? "取り込み中…" : props.activeScriptId ? "再取り込み" : "取り込む"}
        </button>
        ${props.activeScriptRevision ? `<span class="script-revision-badge">revision ${props.activeScriptRevision.revision}</span>` : ""}
      </div>
      ${
        warnings.length > 0
          ? `<ul class="script-warnings">${warnings.map((warning) => `<li>⚠ ${escapeHtml(warning)}</li>`).join("")}</ul>`
          : ""
      }
    </div>
  `;
}

function renderDialogueLinesPanel(props: ScriptViewProps): string {
  const charactersById = new Map(props.characters.map((character) => [character.id, character]));
  const bySceneIndex = new Map<number, DialogueLine[]>();
  for (const line of props.dialogueLines) {
    const sceneIndex = line.sceneIndex ?? -1;
    const bucket = bySceneIndex.get(sceneIndex) ?? [];
    bucket.push(line);
    bySceneIndex.set(sceneIndex, bucket);
  }
  const scenes = props.activeScriptRevision?.parsed.scenes ?? [];
  const sceneIndices = [...bySceneIndex.keys()].sort((a, b) => a - b);

  return `
    <div class="script-panel script-lines-panel">
      <h2>シーン/セリフ</h2>
      ${
        props.dialogueLines.length === 0
          ? `<p class="script-empty-hint">脚本を取り込むとセリフ一覧が表示されます。</p>`
          : sceneIndices
              .map((sceneIndex) => {
                const heading = scenes[sceneIndex]?.heading || (sceneIndex < 0 ? "(見出し無し)" : `シーン ${sceneIndex + 1}`);
                const lines = bySceneIndex.get(sceneIndex) ?? [];
                return `
                  <div class="script-scene-group">
                    <h3 class="script-scene-heading">${escapeHtml(heading)}</h3>
                    ${lines.map((line) => renderDialogueLineRow(line, charactersById.get(line.characterId ?? ""), props.book)).join("")}
                  </div>
                `;
              })
              .join("")
      }
    </div>
  `;
}

function renderDialogueLineRow(line: DialogueLine, character: Character | undefined, book: BookPages): string {
  const color = character?.color ?? "#888888";
  const orphaned = line.status === "orphaned";
  return `
    <div class="script-line-row ${orphaned ? "is-orphaned" : ""}">
      <span class="script-line-speaker-dot" style="background:${escapeAttr(color)}"></span>
      <div class="script-line-body">
        <div class="script-line-meta">
          <span class="script-line-speaker">${escapeHtml(line.speakerLabel || character?.name || "(話者不明)")}</span>
          <span class="script-line-kind">${SEMANTIC_KIND_LABEL[line.semanticKind]}</span>
          ${orphaned ? `<span class="script-line-orphan-badge" title="最新の脚本に対応する行がありません">⚠ orphaned</span>` : ""}
        </div>
        <p class="script-line-text">${escapeHtml(line.text)}</p>
      </div>
      <select class="script-line-page-assign" data-dialogue-line-id="${escapeAttr(line.id)}" ${orphaned ? "disabled" : ""}>
        <option value="">ページへ割当…</option>
        ${book.pages
          .map(
            (page, index) =>
              `<option value="${escapeAttr(page.id)}">${escapeHtml(page.title || `ページ ${index + 1}`)}</option>`
          )
          .join("")}
      </select>
    </div>
  `;
}

function renderCharactersPanel(props: ScriptViewProps): string {
  return `
    <div class="script-panel script-characters-panel">
      <div class="script-panel-heading">
        <h2>キャラクター</h2>
        <button class="button-secondary compact" type="button" data-action="add-character">${iconPlus()}追加</button>
      </div>
      <div class="script-character-list">
        ${props.characters
          .map(
            (character) => `
              <button class="script-character-chip ${character.id === props.selectedCharacterId ? "is-active" : ""}"
                type="button" data-action="select-character" data-id="${escapeAttr(character.id)}">
                <span class="script-character-dot" style="background:${escapeAttr(character.color ?? "#888888")}"></span>
                ${escapeHtml(character.name)}
              </button>
            `
          )
          .join("")}
      </div>
      ${props.selectedCharacterId ? renderCharacterEditor(props) : ""}
    </div>
  `;
}

function renderCharacterEditor(props: ScriptViewProps): string {
  const character = props.characters.find((item) => item.id === props.selectedCharacterId);
  if (!character) {
    return "";
  }
  const binding = props.selectedCharacterBinding;
  return `
    <div class="script-character-editor">
      <label class="script-field">
        <span>名前</span>
        <input type="text" data-character-field="name" value="${escapeAttr(character.name)}" />
      </label>
      <label class="script-field">
        <span>色</span>
        <input type="color" data-character-field="color" value="${escapeAttr(character.color ?? "#888888")}" />
      </label>
      <label class="script-field">
        <span>口調・関係性メモ</span>
        <textarea rows="3" data-character-field="notes">${escapeHtml(character.notes)}</textarea>
      </label>
      <div class="script-character-binding">
        <h3>顔参照(comfy)</h3>
        ${
          binding?.hasFaceImage
            ? `
              <div class="script-face-preview">
                <img src="${escapeAttr(binding.faceImageUrl ?? "")}" alt="${escapeAttr(character.name)}の顔参照" />
                <button class="button-secondary compact" type="button" data-action="clear-character-face-image">${iconTrash()}クリア</button>
              </div>
            `
            : `<p class="script-empty-hint">顔参照画像は未設定です。</p>`
        }
        <label class="button-secondary compact source-upload-button">
          画像をアップロード
          <input type="file" accept="image/png,image/jpeg,image/webp" data-character-face-upload="1" />
        </label>
        <button class="button-secondary compact" type="button" data-action="toggle-character-face-picker">最近使った画像から選ぶ</button>
        ${props.characterFacePickerOpen ? renderFacePicker(props.recentImages) : ""}
      </div>
      <div class="script-character-lora">
        <h3>スタイル LoRA(comfy)</h3>
        <label class="script-field">
          <span>LoRA</span>
          <select data-character-lora-field="name">
            <option value="">(なし)</option>
            ${props.loraChoices
              .map(
                (name) =>
                  `<option value="${escapeAttr(name)}" ${name === props.characterLoraNameDraft ? "selected" : ""}>${escapeHtml(name)}</option>`
              )
              .join("")}
          </select>
        </label>
        <label class="script-field">
          <span>強度</span>
          <input type="number" min="0" max="2" step="0.05" data-character-lora-field="strength" value="${props.characterLoraStrengthDraft}" />
        </label>
        <button class="button-primary compact" type="button" data-action="save-character-lora">保存</button>
      </div>
      <button class="button-danger compact" type="button" data-action="delete-character">${iconTrash()}このキャラクターを削除</button>
    </div>
  `;
}

function renderFacePicker(recentImages: RecentReferenceImage[]): string {
  if (recentImages.length === 0) {
    return `<p class="script-empty-hint">最近使った画像がありません。</p>`;
  }
  return `
    <div class="script-face-picker-grid">
      ${recentImages
        .map(
          (image) => `
            <button class="script-face-picker-item" type="button" data-action="use-character-face-recent" data-url="${escapeAttr(image.url)}">
              <img src="${escapeAttr(image.thumbnailUrl)}" alt="" loading="lazy" />
            </button>
          `
        )
        .join("")}
    </div>
  `;
}
