/**
 * 最小限のキー付き DOM morph。
 *
 * render() が組み立てた HTML 文字列を、既存 DOM ツリーへ「差分パッチ」として適用する。
 * `innerHTML` 全再構築と違いノードが保持されるため、フォーカス・スクロール位置・
 * `<img>` のデコード済み状態・開いた Popover などが再レンダーをまたいで生き残る。
 *
 * 対応方針:
 * - 要素の同一性は「タグ名 + キー(`id` / `data-key`)」で判定する。キーが無い要素は
 *   兄弟内の位置合わせ(先頭からの走査)で対応付ける。
 * - フォーム要素は attribute だけでなく property(value / checked / selected)も同期する。
 *   ただしフォーカス中の要素は入力中のユーザー操作を壊さないため value 系の同期をスキップする。
 */

const KEYED_ATTR = "data-key";

export function morph(target: Element, html: string) {
  const template = document.createElement("template");
  template.innerHTML = html;
  morphChildren(target, template.content);
}

function keyOf(node: Node): string | null {
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return null;
  }
  const element = node as Element;
  return element.getAttribute("id") ?? element.getAttribute(KEYED_ATTR);
}

/** タグ名(+ input の type)が同じで、キーが矛盾しない場合のみ in-place morph できる。 */
function isCompatible(fromNode: Node, toNode: Node): boolean {
  if (fromNode.nodeType !== toNode.nodeType) {
    return false;
  }
  if (fromNode.nodeType !== Node.ELEMENT_NODE) {
    return true;
  }
  const fromEl = fromNode as Element;
  const toEl = toNode as Element;
  if (fromEl.tagName !== toEl.tagName) {
    return false;
  }
  if (fromEl.tagName === "INPUT" && fromEl.getAttribute("type") !== toEl.getAttribute("type")) {
    return false;
  }
  return keyOf(fromEl) === keyOf(toEl);
}

function morphChildren(from: Element | DocumentFragment | ShadowRoot, to: Element | DocumentFragment) {
  // キー付き旧ノードの索引と、新側で使われるキー集合(旧ノードを捨ててよいかの判定用)。
  const fromKeyed = new Map<string, Element>();
  for (let child = from.firstElementChild; child; child = child.nextElementSibling) {
    const key = keyOf(child);
    if (key) {
      if (fromKeyed.has(key)) {
        // 重複キーは片方の内容が無警告で消える事故につながるため開発時に気づけるようにする。
        console.warn(`[domMorph] duplicate data-key detected: ${key}`);
      }
      fromKeyed.set(key, child);
    }
  }
  const toKeys = new Set<string>();
  for (let child = to.firstElementChild; child; child = child.nextElementSibling) {
    const key = keyOf(child);
    if (key) {
      toKeys.add(key);
    }
  }

  let fromNode: ChildNode | null = from.firstChild;
  let toNode: ChildNode | null = to.firstChild;
  while (toNode) {
    const nextTo: ChildNode | null = toNode.nextSibling;
    let matched: ChildNode | null = null;

    const key = keyOf(toNode);
    if (key) {
      const candidate = fromKeyed.get(key);
      if (candidate && isCompatible(candidate, toNode)) {
        matched = candidate;
      }
    } else {
      // 位置合わせ: 現在位置の旧ノードが合わない場合、後で使うキー付きノードで
      // なければ捨てて先へ進む(型違いの text/comment の食い違いを吸収する)。
      while (fromNode && !isCompatible(fromNode, toNode)) {
        const fromKey = keyOf(fromNode);
        if (fromKey && toKeys.has(fromKey)) {
          break;
        }
        const next: ChildNode | null = fromNode.nextSibling;
        fromNode.remove();
        fromNode = next;
      }
      if (fromNode && isCompatible(fromNode, toNode)) {
        matched = fromNode;
      }
    }

    if (matched) {
      if (matched === fromNode) {
        fromNode = fromNode.nextSibling;
      } else {
        from.insertBefore(matched, fromNode);
      }
      morphNode(matched, toNode);
    } else {
      from.insertBefore(toNode, fromNode);
      // toNode を from 側へ移動したので、to 側の走査は nextTo で継続する。
    }
    toNode = nextTo;
  }

  while (fromNode) {
    const next: ChildNode | null = fromNode.nextSibling;
    fromNode.remove();
    fromNode = next;
  }
}

function morphNode(from: ChildNode, to: ChildNode) {
  if (from.nodeType === Node.TEXT_NODE || from.nodeType === Node.COMMENT_NODE) {
    if (from.nodeValue !== to.nodeValue) {
      from.nodeValue = to.nodeValue;
    }
    return;
  }
  if (from.nodeType === Node.ELEMENT_NODE) {
    morphElement(from as Element, to as Element);
  }
}

function morphElement(from: Element, to: Element) {
  syncAttributes(from, to);
  morphChildren(from, to);
  syncFormProperties(from, to);
}

function syncAttributes(from: Element, to: Element) {
  const focused = from === document.activeElement;
  for (const attr of Array.from(to.attributes)) {
    if (focused && attr.name === "value") {
      continue;
    }
    if (from.getAttribute(attr.name) !== attr.value) {
      from.setAttribute(attr.name, attr.value);
    }
  }
  for (const attr of Array.from(from.attributes)) {
    if (!to.hasAttribute(attr.name)) {
      // lazyImageController が読み込み済み img に付けた src は、同じ data-lazy-src を
      // 宣言する再描画で消さない。画像ノードと decode 済み状態を保つ dom morph の目的に合わせる。
      if (
        attr.name === "src" &&
        from instanceof HTMLImageElement &&
        to instanceof HTMLImageElement &&
        attr.value === to.getAttribute("data-lazy-src")
      ) {
        continue;
      }
      if (focused && attr.name === "value") {
        continue;
      }
      from.removeAttribute(attr.name);
    }
  }
}

/**
 * attribute と property が乖離するフォーム要素の状態を新側の宣言に合わせる。
 * `innerHTML` 全再構築時代は毎回 attribute どおりに初期化されていたので、
 * フォーカス中要素の入力保護を除き、それと同じ意味論を維持する。
 */
function syncFormProperties(from: Element, to: Element) {
  const focused = from === document.activeElement;
  if (from instanceof HTMLInputElement && to instanceof HTMLInputElement) {
    if (from.type === "checkbox" || from.type === "radio") {
      const checked = to.hasAttribute("checked");
      if (!focused && from.checked !== checked) {
        from.checked = checked;
      }
    } else if (from.type !== "file") {
      const value = to.getAttribute("value") ?? "";
      if (!focused && from.value !== value) {
        from.value = value;
      }
    }
    return;
  }
  if (from instanceof HTMLTextAreaElement && to instanceof HTMLTextAreaElement) {
    const value = to.textContent ?? "";
    if (!focused && from.value !== value) {
      from.value = value;
    }
    return;
  }
  if (from instanceof HTMLSelectElement && to instanceof HTMLSelectElement) {
    // 子 option は morphChildren で同期済み。selected 属性から値を復元する。
    const selected = to.querySelector("option[selected]");
    const value = selected?.getAttribute("value") ?? selected?.textContent ?? null;
    if (!focused && value !== null && from.value !== value) {
      from.value = value;
    } else if (!focused && value === null && from.selectedIndex < 0 && from.options.length > 0) {
      // 新HTMLに option[selected] が無く、現在値が新しい option 集合にも無い(selectedIndex=-1):
      // innerHTML 全再構築時代の「先頭 option へ初期化」と同じ意味論に合わせる。
      from.selectedIndex = 0;
    }
    return;
  }
  if (from instanceof HTMLOptionElement && to instanceof HTMLOptionElement) {
    const selected = to.hasAttribute("selected");
    if (from.selected !== selected && from.closest("select") !== document.activeElement) {
      from.selected = selected;
    }
  }
}
