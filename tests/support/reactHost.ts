import { act, type ReactNode } from 'react';
import type { Root } from 'react-dom/client';
import { vi } from 'vitest';

// A headless React DOM host for effect/lifecycle tests only. It has no layout,
// browser event propagation or media implementation; those belong to UI tests.
class HostNode extends EventTarget {
  parentNode: HostNode | null = null;
  childNodes: HostNode[] = [];
  ownerDocument!: HostDocument;
  nodeType = 1;
  namespaceURI = 'http://www.w3.org/1999/xhtml';
  style = { setProperty: vi.fn() };
  attributes: Record<string, string> = {};
  private content = '';
  constructor(readonly nodeName: string) { super(); }
  get tagName() { return this.nodeName.toUpperCase(); }
  get firstChild(): HostNode | null { return this.childNodes[0] ?? null; }
  get lastChild(): HostNode | null { return this.childNodes.at(-1) ?? null; }
  get textContent(): string { return this.content + this.childNodes.map(node => node.textContent).join(''); }
  set textContent(value: string) { this.content = value; this.childNodes = []; }
  appendChild(node: HostNode) { node.parentNode?.removeChild(node); node.parentNode = this; this.childNodes.push(node); return node; }
  removeChild(node: HostNode) { this.childNodes = this.childNodes.filter(child => child !== node); node.parentNode = null; return node; }
  insertBefore(node: HostNode, before: HostNode) {
    node.parentNode?.removeChild(node); node.parentNode = this;
    this.childNodes.splice(this.childNodes.indexOf(before), 0, node); return node;
  }
  setAttribute(name: string, value: string) { this.attributes[name] = String(value); }
  setAttributeNS(_namespace: string, name: string, value: string) { this.setAttribute(name, value); }
  removeAttribute(name: string) { delete this.attributes[name]; }
  contains(node: HostNode): boolean { return node === this || this.childNodes.some(child => child.contains(node)); }
  getReactProps(): Record<string, any> {
    const key = Object.keys(this).find(name => name.startsWith('__reactProps$'));
    return key ? (this as any)[key] : {};
  }
}
class HostDocument extends HostNode {
  documentElement: HostNode;
  body: HostNode;
  activeElement: HostNode;
  defaultView!: Window;
  constructor() {
    super('#document'); this.nodeType = 9; this.ownerDocument = this;
    this.documentElement = this.createElement('html'); this.body = this.createElement('body');
    this.documentElement.appendChild(this.body); this.activeElement = this.body;
  }
  createElement(tag: string) { const node = new HostNode(tag); node.ownerDocument = this; return node; }
  createElementNS(namespace: string, tag: string) { const node = this.createElement(tag); node.namespaceURI = namespace; return node; }
  createTextNode(value: string) { const node = this.createElement('#text'); node.nodeType = 3; node.textContent = value; return node; }
}

export async function createReactHost() {
  const document = new HostDocument();
  const window = Object.assign(new EventTarget(), { document, isSecureContext: true, HTMLElement: HostNode, HTMLIFrameElement: class {},
    location: { pathname: '/v1.1/exhibition/screen', href: 'http://xuminghong.local:10200/v1.1/exhibition/screen' },
  });
  document.defaultView = window as unknown as Window;
  vi.stubGlobal('window', window); vi.stubGlobal('document', document); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const container = document.createElement('main'); document.body.appendChild(container);
  const { createRoot } = await import('react-dom/client');
  const root: Root = createRoot(container as unknown as HTMLElement);
  return {
    root,
    async render(node: ReactNode) { await act(async () => { root.render(node); }); },
    async close() { await act(async () => root.unmount()); },
    find(predicate: (node: HostNode) => boolean) {
      const walk = (node: HostNode): HostNode | undefined => predicate(node) ? node : node.childNodes.map(walk).find(Boolean);
      return walk(container);
    },
  };
}

export async function flushReact() {
  await act(async () => { for (let index = 0; index < 40; index++) await Promise.resolve(); });
}
