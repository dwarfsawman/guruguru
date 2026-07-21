/**
 * ページ編集 lightbox の「セリフ」ドロワー(Docs/Feature-ScriptToManga.md S3 UI 2 / S4 LLM 提案)
 * (pagePanelLightboxView.ts から分割)。行クリックで placement 作成+吹き出し生成を行う。
 */
import type { DialogueLine, DialogueProposal, DialogueProposalItem } from "../../shared/apiTypes";
import type { PageObject } from "../../shared/pageObjects";
import { escapeAttr, escapeHtml } from "../format";
import { iconSparkle } from "../icons";
import { renderChronicleBar, type ChronicleBarViewState } from "./chronicleBarView";

/**
 * 「セリフ」ドロワー(Docs/Feature-ScriptToManga.md S3 UI 2)の表示用状態。`lines` はそのプロジェクトの
 * active なセリフ行(script 横断)。行クリックで placement 作成+吹き出し生成を行う(同じ行を複数回
 * クリックすれば分割配置になる -- 既に配置済みの行も一覧に残し「配置済み ×N」を添えて再クリック可能にする)。
 */
export interface DialogueDrawerViewState {
  open: boolean;
  lines: DialogueLine[];
  /** 構造化 LLM セリフ提案(Docs/Feature-ScriptToManga.md S4)。 */
  llmConfigured: boolean;
  /** このページの提案一覧(新しい順)。 */
  proposals: DialogueProposal[];
  /** LLM 提案リクエスト送信中か(ボタン disabled + スピナー表示、llmImproving 同型)。 */
  busy: boolean;
}

const SEMANTIC_KIND_LABEL: Record<DialogueLine["semanticKind"], string> = {
  dialogue: "台詞",
  monologue: "心の声",
  narration: "ナレーション",
  sfx: "SFX"
};

/**
 * 「セリフ」ドロワー(Docs/Feature-ScriptToManga.md S3 UI 2)。行クリックで placement 作成+
 * 吹き出し生成が対で行われる(同じ行を複数回クリックすれば1台詞を複数吹き出しへ分割配置できる)。
 * 既に配置済みの行も一覧からは消さず「配置済み ×N」を添えて残す(設計書の逸脱: サーバ側に
 * dialogue_lines.page_id が無く「ページ割当済み・未配置」の中間状態を持たないため、
 * 「このページの PageObject.sourceDialogueLineId」から配置回数を数える方式にしている)。
 *
 * B-1(Docs/Feature-PageEditSidebarUx.md 課題B): Chronicle バーはこのドロワー配下(末尾)にのみ描く。
 * 以前は `renderPagePanelLightbox` がタブと無関係にサイドバー末尾へ常時描画しており、レイヤタブにも
 * Chronicle チップ列が出て役割が重複していた。レイヤタブ = オブジェクト(手動編集)、
 * セリフタブ = 脚本由来セリフの管理、と役割を分けるため、ここでのみ描画する。
 */
export function renderDialogueDrawer(dialogueDrawer: DialogueDrawerViewState, objects: PageObject[], chronicleBar: ChronicleBarViewState): string {
  const { lines, llmConfigured, proposals, busy } = dialogueDrawer;
  const placedCounts = new Map<string, number>();
  for (const object of objects) {
    if (object.sourceDialogueLineId) {
      placedCounts.set(object.sourceDialogueLineId, (placedCounts.get(object.sourceDialogueLineId) ?? 0) + 1);
    }
  }
  const listContent =
    lines.length === 0
      ? `<p class="page-panel-hint-text">配置できるセリフがありません。先に脚本画面で取り込んでください。</p>`
      : `
        <p class="page-panel-hint-text">行をクリックすると、このページ(選択中のコマがあればそのコマ中心)に吹き出しを配置します。</p>
        <div class="dialogue-drawer-list">
          ${lines
            .map((line) => {
              const placedCount = placedCounts.get(line.id) ?? 0;
              const orphaned = line.status === "orphaned";
              return `
                <button class="dialogue-drawer-item${orphaned ? " is-orphaned" : ""}" type="button" data-action="place-dialogue-line" data-id="${escapeAttr(line.id)}" ${orphaned ? "disabled" : ""}>
                  <span class="dialogue-drawer-item-speaker">${escapeHtml(line.speakerLabel || "(話者不明)")}</span>
                  <span class="dialogue-drawer-item-kind">${SEMANTIC_KIND_LABEL[line.semanticKind]}</span>
                  <span class="dialogue-drawer-item-text">${escapeHtml(line.text)}</span>
                  ${placedCount > 0 ? `<span class="dialogue-drawer-item-badge">配置済み ×${placedCount}</span>` : ""}
                  ${orphaned ? `<span class="dialogue-drawer-item-badge">⚠ orphaned</span>` : ""}
                </button>
              `;
            })
            .join("")}
        </div>
      `;
  return `
    <div class="dialogue-drawer">
      ${renderDialogueProposalSection(llmConfigured, proposals, busy)}
      ${listContent}
      ${renderChronicleBar(chronicleBar)}
    </div>
  `;
}

const PROPOSAL_STATUS_LABEL: Record<DialogueProposal["status"], string> = {
  proposed: "提案中",
  resolved: "処理済み",
  failed: "失敗"
};

const PROPOSAL_ITEM_STATUS_LABEL: Record<DialogueProposalItem["itemStatus"], string> = {
  proposed: "未処理",
  adopted: "採用済み",
  rejected: "却下",
  replaced: "置換済み"
};

/**
 * 構造化 LLM セリフ提案(Docs/Feature-ScriptToManga.md S4)。「AIセリフ提案」ボタンは llmConfigured
 * (state.llmSettings の baseUrl/model が設定済み)の時だけ表示する。busy は llmImproving と同型の
 * リクエスト送信中フラグ。
 */
function renderDialogueProposalSection(llmConfigured: boolean, proposals: DialogueProposal[], busy: boolean): string {
  if (!llmConfigured) {
    return "";
  }
  return `
    <div class="dialogue-proposal-section">
      <button class="button-secondary compact" type="button" data-action="request-dialogue-proposal" ${busy ? "disabled" : ""}>
        ${iconSparkle()}${busy ? "AI提案を生成中…" : "AIセリフ提案"}
      </button>
      ${proposals.length > 0 ? `<div class="dialogue-proposal-list">${proposals.map(renderDialogueProposal).join("")}</div>` : ""}
    </div>
  `;
}

function renderDialogueProposal(proposal: DialogueProposal): string {
  const items = proposal.items ?? [];
  return `
    <div class="dialogue-proposal">
      <div class="dialogue-proposal-header">
        <span class="dialogue-proposal-model">${escapeHtml(proposal.model)}</span>
        <span class="dialogue-proposal-status is-${proposal.status}">${PROPOSAL_STATUS_LABEL[proposal.status]}</span>
        ${proposal.isStale ? `<span class="dialogue-drawer-item-badge">⚠ 脚本が更新されています</span>` : ""}
      </div>
      ${
        proposal.status === "failed"
          ? `<p class="page-panel-hint-text dialogue-proposal-error">${escapeHtml(proposal.error ?? "生成に失敗しました。")}</p>`
          : ""
      }
      ${
        items.length > 0
          ? `<div class="dialogue-proposal-items">${items.map((item, index) => renderDialogueProposalItem(proposal.id, item, index)).join("")}</div>`
          : ""
      }
    </div>
  `;
}

function renderDialogueProposalItem(proposalId: string, item: DialogueProposalItem, index: number): string {
  const isPending = item.itemStatus === "proposed";
  return `
    <div class="dialogue-proposal-item${isPending ? "" : " is-resolved"}" data-dialogue-proposal-item>
      <div class="dialogue-proposal-item-meta">
        <span class="dialogue-drawer-item-speaker">${escapeHtml(item.speakerName || "(話者不明)")}</span>
        <span class="dialogue-drawer-item-kind">${SEMANTIC_KIND_LABEL[item.semanticKind]}</span>
        ${item.panelId ? `<span class="dialogue-proposal-item-panel">panel: ${escapeHtml(item.panelId)}</span>` : ""}
        ${!isPending ? `<span class="dialogue-drawer-item-badge">${PROPOSAL_ITEM_STATUS_LABEL[item.itemStatus]}</span>` : ""}
      </div>
      ${
        isPending
          ? `
            <textarea class="dialogue-proposal-item-edit" data-dialogue-proposal-edit rows="2">${escapeHtml(item.text)}</textarea>
            <div class="dialogue-proposal-item-actions">
              <button class="button-primary compact" type="button" data-action="adopt-dialogue-proposal-item" data-id="${escapeAttr(proposalId)}" data-item-index="${index}">採用</button>
              <button class="button-secondary compact" type="button" data-action="reject-dialogue-proposal-item" data-id="${escapeAttr(proposalId)}" data-item-index="${index}">却下</button>
            </div>
          `
          : `<p class="dialogue-proposal-item-text">${escapeHtml(item.editedText ?? item.text)}</p>`
      }
    </div>
  `;
}
