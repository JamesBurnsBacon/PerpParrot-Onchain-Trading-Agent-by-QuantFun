// Minimal host DOM for real React mount/unmount tests, not a browser/layout simulator.
export function paintDom() {
  const calls: string[] = [];
  const context = new Proxy({}, { get: (_target, key) => () => calls.push(String(key)), set: () => true });
  const listeners = new Set<() => void>();
  const motion = { matches: false, addEventListener: (_: string, fn: () => void) => listeners.add(fn), removeEventListener: (_: string, fn: () => void) => listeners.delete(fn) };
  const doc: any = { nodeType: 9, addEventListener() {}, removeEventListener() {}, activeElement: null };
  class Element {
    nodeType = 1;
    tagName: string;
    nodeName: string;
    namespaceURI = "http://www.w3.org/1999/xhtml";
    ownerDocument = doc;
    parentNode: Element | null = null;
    childNodes: Element[] = [];
    style = { setProperty() {}, removeProperty() {} };
    attributes: Record<string, string> = {};
    textContent = "";
    constructor(tag: string) { this.tagName = this.nodeName = tag.toUpperCase(); }
    appendChild(child: Element) { this.childNodes.push(child); child.parentNode = this; return child; }
    removeChild(child: Element) { this.childNodes.splice(this.childNodes.indexOf(child), 1); child.parentNode = null; return child; }
    insertBefore(child: Element, before: Element) { this.childNodes.splice(this.childNodes.indexOf(before), 0, child); child.parentNode = this; return child; }
    setAttribute(key: string, value: string) { this.attributes[key] = value; }
    removeAttribute(key: string) { delete this.attributes[key]; }
    addEventListener() {}
    removeEventListener() {}
    getContext() { return context; }
  }
  doc.createElement = (tag: string) => new Element(tag);
  doc.createElementNS = (_: string, tag: string) => new Element(tag);
  doc.createTextNode = (text: string) => Object.assign(new Element("text"), { nodeType: 3, nodeValue: text });
  const window = { document: doc, matchMedia: () => motion, HTMLIFrameElement: class {}, HTMLElement: Element, event: undefined };
  doc.defaultView = window;
  return { window, document: doc, root: new Element("div"), motion, listeners, calls };
}
