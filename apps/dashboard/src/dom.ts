export type Child = Node | string | number | null | undefined | false;
export type Attrs = Record<string, string | number | boolean | undefined>;

/**
 * Minimal element builder. Strings become text nodes, so coordinator data can
 * never be parsed as HTML. Event-handler attributes are refused outright.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (/^on/i.test(name) || name.toLowerCase() === 'style') {
      throw new Error(`Attribute "${name}" is not allowed`);
    }
    el.setAttribute(name, value === true ? '' : String(value));
  }
  append(el, children);
  return el;
}

export function append(parent: Node, children: readonly Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/**
 * Replaces a container's content while keeping keyboard focus on the element
 * with the same `data-key`, so live refreshes don't yank focus away.
 */
export function replaceContent(container: Element, next: Node): void {
  const active = document.activeElement;
  const key =
    active instanceof HTMLElement && container.contains(active)
      ? active.getAttribute('data-key')
      : null;
  container.replaceChildren(next);
  if (key === null) return;
  for (const el of container.querySelectorAll<HTMLElement>('[data-key]')) {
    if (el.getAttribute('data-key') === key) {
      el.focus({ preventScroll: true });
      return;
    }
  }
}
