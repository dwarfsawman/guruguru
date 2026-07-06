/**
 * イテレーションツリーのエッジポップアウトにおける「添付表示の展開」controller。
 * (Docs/Feature-ImagePaste.md (i))
 *
 * - 添付があるエッジのポップアウトは、ホイール下スクロールで展開して
 *   貼り付け画像のサムネイルを表示し、上スクロールで折りたたむ。
 * - フォールバックとしてエッジ(<button class="iteration-edge">)のクリックでもトグルする
 *   (タッチ・キーボード向け。エッジは UX改善#7 で focus 可能なボタンになっている)。
 * - 展開状態は classList 直接操作(render を経ない)。mouseleave / focusout で自動リセット。
 * - ポップアウトは通常 pointer-events: none。展開時のみ CSS 側で auto になるが、
 *   ポップアウトはエッジボタンの DOM 子孫なので hover 継続で表示が消えることはない。
 */
import { registerEventBinder } from "./actionRegistry";

function edgePopoutFor(target: EventTarget | null): { edge: HTMLElement; popout: HTMLElement } | null {
  if (!(target instanceof Element)) {
    return null;
  }
  const edge = target.closest<HTMLElement>(".iteration-edge");
  const popout = edge?.querySelector<HTMLElement>(".iteration-edge-popout");
  if (!edge || !popout || !popout.querySelector(".iteration-edge-attachments-footer")) {
    return null;
  }
  return { edge, popout };
}

function setExpanded(popout: HTMLElement, expanded: boolean) {
  popout.classList.toggle("expanded", expanded);
}

function bindEdgePopoutEvents(app: HTMLElement) {
  app.addEventListener(
    "wheel",
    (event) => {
      const found = edgePopoutFor(event.target);
      if (!found) {
        return;
      }
      // ツリーのスクロールと分離する(添付ありエッジ上のホイールは展開/折りたたみ専用)。
      event.preventDefault();
      setExpanded(found.popout, event.deltaY > 0);
    },
    { passive: false }
  );

  app.addEventListener("click", (event) => {
    const found = edgePopoutFor(event.target);
    if (!found) {
      return;
    }
    // ポップアウト本体のクリックでは閉じない(誤クリックで消えるのを防ぐ)。
    // 展開トグルはフッタ(添付 n件 ˅)のクリックのみ受け付ける。
    // ポップアウト外のクリックはエッジボタンの focus が外れることで閉じる(focusout)。
    const inPopout = event.target instanceof Element && event.target.closest(".iteration-edge-popout");
    if (inPopout && !(event.target as Element).closest(".iteration-edge-attachments-footer")) {
      return;
    }
    setExpanded(found.popout, !found.popout.classList.contains("expanded"));
  });

  app.addEventListener("mouseout", (event) => {
    const found = edgePopoutFor(event.target);
    if (!found) {
      return;
    }
    const next = (event as MouseEvent).relatedTarget;
    if (next instanceof Node && found.edge.contains(next)) {
      return;
    }
    // クリックでエッジに focus が乗っている間(=ピン留め状態)は hover が外れても
    // 折りたたまない。ポップアウト外クリックで focus が外れたときに閉じる(focusout)。
    const focused = document.activeElement;
    if (focused instanceof Node && found.edge.contains(focused)) {
      return;
    }
    setExpanded(found.popout, false);
  });

  app.addEventListener("focusout", (event) => {
    const found = edgePopoutFor(event.target);
    if (found) {
      setExpanded(found.popout, false);
    }
  });
}

registerEventBinder(bindEdgePopoutEvents);
