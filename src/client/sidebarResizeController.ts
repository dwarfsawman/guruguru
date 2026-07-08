/**
 * 生成サイドバー(`.studio-sidebar`)の右端ドラッグによる幅変更。mask パネルリサイザと同型で、
 * ドラッグ中は CSS 変数 `--studio-sidebar-width` を対象要素へ直接書き込み(render を通さない)、
 * pointerup で `setSidebarWidth` に確定して localStorage へ永続化する。
 * main.ts の pointer ハンドラ連鎖(mask/paste/paint と同じ場所)から呼ばれる。
 */
import { clampSidebarWidth, requestRender, setSidebarWidth, state } from "./appState";

type SidebarResize = {
  pointerId: number;
  startX: number;
  startWidth: number;
  pendingWidth: number;
  sidebar: HTMLElement;
};

let sidebarResize: SidebarResize | null = null;

export function handleSidebarResizePointerDown(event: PointerEvent): boolean {
  if (event.button !== 0) {
    return false;
  }
  const handle = (event.target as HTMLElement).closest<HTMLElement>("[data-sidebar-resizer]");
  if (!handle) {
    return false;
  }
  const sidebar = handle.closest<HTMLElement>(".studio-sidebar");
  if (!sidebar) {
    return false;
  }
  event.preventDefault();
  handle.classList.add("resizing");
  sidebarResize = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startWidth: state.sidebarWidth,
    pendingWidth: state.sidebarWidth,
    sidebar
  };
  try {
    handle.setPointerCapture(event.pointerId);
  } catch {
    // setPointerCapture 未対応でも document レベルの move/up で追従できる。
  }
  return true;
}

export function handleSidebarResizePointerMove(event: PointerEvent): boolean {
  if (!sidebarResize || event.pointerId !== sidebarResize.pointerId) {
    return false;
  }
  event.preventDefault();
  const width = clampSidebarWidth(sidebarResize.startWidth + (event.clientX - sidebarResize.startX));
  sidebarResize.pendingWidth = width;
  sidebarResize.sidebar.style.setProperty("--studio-sidebar-width", `${width}px`);
  return true;
}

export function handleSidebarResizePointerUp(event: PointerEvent): boolean {
  if (!sidebarResize || event.pointerId !== sidebarResize.pointerId) {
    return false;
  }
  event.preventDefault();
  setSidebarWidth(sidebarResize.pendingWidth);
  finishSidebarResize();
  requestRender();
  return true;
}

export function handleSidebarResizePointerCancel(event: PointerEvent): boolean {
  if (!sidebarResize || event.pointerId !== sidebarResize.pointerId) {
    return false;
  }
  // 変更を破棄し、確定済みの state.sidebarWidth に戻す。
  sidebarResize.sidebar.style.setProperty("--studio-sidebar-width", `${state.sidebarWidth}px`);
  finishSidebarResize();
  return true;
}

function finishSidebarResize() {
  document.querySelector<HTMLElement>("[data-sidebar-resizer].resizing")?.classList.remove("resizing");
  sidebarResize = null;
}
