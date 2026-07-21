/**
 * 生成サイドバー(`.studio-sidebar`)の右端ドラッグによる幅変更。mask パネルリサイザと同型で、
 * ドラッグ中は CSS 変数 `--studio-sidebar-width` を対象要素へ直接書き込み(render を通さない)、
 * pointerup で `setSidebarWidth` に確定して localStorage へ永続化する。
 * main.ts の pointer ハンドラ連鎖(mask/paste/paint と同じ場所)から呼ばれる。
 */
import { clampSidebarWidth, requestRender, setSidebarWidth, state } from "./appState";
import { createDragSession } from "./dragSession";

type SidebarResizeData = {
  startX: number;
  startWidth: number;
  pendingWidth: number;
  sidebar: HTMLElement;
};

// pointerId 照合・setPointerCapture/release・up/cancel でのクリアは createDragSession(dragSession.ts)へ委譲。
const sidebarResizeSession = createDragSession<SidebarResizeData>({
  onMove: (event, resize) => {
    event.preventDefault();
    const width = clampSidebarWidth(resize.startWidth + (event.clientX - resize.startX));
    resize.pendingWidth = width;
    resize.sidebar.style.setProperty("--studio-sidebar-width", `${width}px`);
  },
  onCommit: (event, resize) => {
    event.preventDefault();
    setSidebarWidth(resize.pendingWidth);
    finishSidebarResize();
    requestRender();
  },
  onCancel: (_event, resize) => {
    // 変更を破棄し、確定済みの state.sidebarWidth に戻す。
    resize.sidebar.style.setProperty("--studio-sidebar-width", `${state.sidebarWidth}px`);
    finishSidebarResize();
  }
});

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
  sidebarResizeSession.begin(
    event,
    {
      startX: event.clientX,
      startWidth: state.sidebarWidth,
      pendingWidth: state.sidebarWidth,
      sidebar
    },
    handle
  );
  return true;
}

export function handleSidebarResizePointerMove(event: PointerEvent): boolean {
  return sidebarResizeSession.handleMove(event);
}

export function handleSidebarResizePointerUp(event: PointerEvent): boolean {
  return sidebarResizeSession.handleUp(event);
}

export function handleSidebarResizePointerCancel(event: PointerEvent): boolean {
  return sidebarResizeSession.handleCancel(event);
}

function finishSidebarResize() {
  document.querySelector<HTMLElement>("[data-sidebar-resizer].resizing")?.classList.remove("resizing");
}
