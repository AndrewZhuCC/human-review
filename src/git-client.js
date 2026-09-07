import { buildContext, findQuote } from "./anchor-text.js";
import { hashTargetId, navigationHref } from "./click-target.js";

const UI_ATTR = "data-eh-ui";
const MARK_ATTR = "data-eh-mark";
const CHROME_ORIGIN = `${location.protocol}//${location.hostname === "127.0.0.1" ? "localhost" : "127.0.0.1"}:${location.port}`;
const post = (type, payload = {}) => parent.postMessage({ ...payload, type }, CHROME_ORIGIN);

let pending = null;
let composeOpen = false;

const cssPath = (el) => (el?.id ? `#${CSS.escape(el.id)}` : "body");
const isOurs = (node) => {
  const el = node?.nodeType === 1 ? node : node?.parentElement;
  return !!el?.closest?.(`[${UI_ATTR}]`);
};

function gitContext(node) {
  const el = node?.nodeType === 1 ? node : node?.parentElement;
  const source = el?.closest?.("[data-git-kind]");
  if (!source) return null;
  const number = (name) => {
    const value = source.getAttribute(name);
    return value === null || value === "" ? null : Number(value);
  };
  return {
    kind: source.getAttribute("data-git-kind") || "line",
    path: source.getAttribute("data-git-path") || "",
    side: source.getAttribute("data-git-side") || "",
    line: number("data-git-line"),
    old_line: number("data-git-old-line"),
    new_line: number("data-git-new-line"),
    hunk: source.getAttribute("data-git-hunk") || "",
    text: source.classList.contains("line") ? source.querySelector(".code")?.textContent || "" : "",
  };
}

function flatten() {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!node.nodeValue || !parent || isOurs(parent) || /^(script|style|noscript|template)$/i.test(parent.tagName)) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let text = "";
  const map = [];
  let node = walker.nextNode();
  while (node) {
    const start = text.length;
    text += node.nodeValue;
    map.push({ node, start, end: text.length });
    node = walker.nextNode();
  }
  return { text, map };
}

function offsetsFromRange(map, range) {
  let start = null;
  let end = null;
  for (const entry of map) {
    if (entry.node === range.startContainer) start = entry.start + range.startOffset;
    if (entry.node === range.endContainer) end = entry.start + range.endOffset;
  }
  return start === null || end === null ? null : { start, end };
}

function settleSelection() {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return false;
  const range = selection.getRangeAt(0);
  if (!document.body.contains(range.commonAncestorContainer) || isOurs(range.commonAncestorContainer)) return false;
  const quote = selection.toString();
  if (!quote.trim()) return false;
  const { text, map } = flatten();
  const offsets = offsetsFromRange(map, range);
  if (!offsets) return false;
  const context = buildContext(text, offsets.start, offsets.end);
  const container = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
  const anchor = { ...context, selector: cssPath(container?.closest?.("[data-git-kind]") || container), git: gitContext(container) };
  pending = { kind: "selection", context, selector: anchor.selector };
  post("eh:compose", { kind: "selection", quote, anchor });
  return true;
}

function openElement(node) {
  const element = node?.closest?.("[data-git-kind]");
  if (!element || isOurs(element)) return false;
  const git = gitContext(element);
  const label = element.getAttribute("data-container") || element.getAttribute("data-block") || git?.path || "Git change";
  pending = { kind: "element", element, selector: cssPath(element) };
  post("eh:compose", { kind: "element", quote: label, anchor: { selector: cssPath(element), label, git } });
  return true;
}

function commitPending(id) {
  if (!pending) return;
  const element = pending.element || document.querySelector(pending.selector);
  if (element) element.setAttribute("data-eh-el", id);
  pending = null;
}

function reanchor(comments) {
  document.querySelectorAll("[data-eh-el]").forEach((element) => element.removeAttribute("data-eh-el"));
  const { text } = flatten();
  const resolved = [];
  const orphaned = [];
  for (const comment of comments) {
    let element = comment.anchor?.selector ? document.querySelector(comment.anchor.selector) : null;
    if (!element && comment.anchor) {
      const hit = findQuote(text, comment.anchor);
      if (hit) {
        const git = comment.anchor.git;
        element = git?.path ? document.querySelector(`[data-git-path="${CSS.escape(git.path)}"][data-git-line="${git.line ?? ""}"]`) : null;
      }
    }
    if (element) {
      element.setAttribute("data-eh-el", comment.id);
      resolved.push(comment.id);
    } else orphaned.push(comment.id);
  }
  post("eh:anchorStatus", { resolved, orphaned });
}

function activate(id, scroll) {
  const element = document.querySelector(`[data-eh-el="${CSS.escape(id)}"]`);
  if (!element) return post("eh:notInView", { id });
  document.querySelectorAll(`.${MARK_ATTR}`).forEach((entry) => entry.classList.remove(MARK_ATTR));
  element.classList.add(MARK_ATTR);
  if (scroll) element.scrollIntoView({ behavior: "smooth", block: "center" });
}

function navigationWidth(value) {
  if (value === null || value === undefined || value === "") return 260;
  const width = Number(value);
  return Number.isFinite(width) ? Math.min(520, Math.max(180, Math.round(width))) : 260;
}

function applyNavigationWidth(value) {
  const width = navigationWidth(value);
  document.body.style.setProperty("--git-nav-width", `${width}px`);
  document.querySelector(".nav-resizer")?.setAttribute("aria-valuenow", String(width));
  return width;
}

function applyNavigationMode(mode) {
  const next = mode === "list" ? "list" : "tree";
  document.querySelectorAll("[data-git-nav-view]").forEach((view) => {
    view.hidden = view.getAttribute("data-git-nav-view") !== next;
    if (!view.hidden) {
      const main = document.querySelector("main");
      for (const link of view.querySelectorAll('a[href^="#file-"]')) {
        const file = document.getElementById(link.getAttribute("href").slice(1));
        if (file?.parentElement === main) main.appendChild(file);
      }
    }
  });
  document.querySelectorAll("[data-git-nav-mode]").forEach((button) => {
    button.setAttribute("aria-pressed", button.getAttribute("data-git-nav-mode") === next ? "true" : "false");
  });
}

function boot() {
  applyNavigationMode("tree");
  applyNavigationWidth(260);

  const resizer = document.querySelector(".nav-resizer");
  let resizing = false;
  if (resizer) {
    resizer.addEventListener("pointerdown", (event) => {
      if (matchMedia("(max-width: 900px)").matches) return;
      event.preventDefault();
      resizing = true;
      document.body.classList.add("resizing-nav");
      resizer.setPointerCapture?.(event.pointerId);
    });
    window.addEventListener("pointermove", (event) => {
      if (!resizing) return;
      event.preventDefault();
      applyNavigationWidth(event.clientX);
    });
    const finishResize = () => {
      if (!resizing) return;
      resizing = false;
      document.body.classList.remove("resizing-nav");
      const width = applyNavigationWidth(parseFloat(getComputedStyle(document.body).getPropertyValue("--git-nav-width")));
      post("eh:gitNavWidth", { width });
    };
    window.addEventListener("pointerup", finishResize);
    window.addEventListener("pointercancel", finishResize);
    resizer.addEventListener("keydown", (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const current = parseFloat(getComputedStyle(document.body).getPropertyValue("--git-nav-width"));
      const width = event.key === "Home" ? 180 : event.key === "End" ? 520 : current + (event.key === "ArrowLeft" ? -20 : 20);
      post("eh:gitNavWidth", { width: applyNavigationWidth(width) });
    });
  }

  const style = document.createElement("style");
  style.setAttribute("data-eh-sdk", "");
  style.textContent = `
    [data-eh-el] { box-shadow: inset 3px 0 0 rgba(245,196,0,.8); }
    .${MARK_ATTR} { outline: 2px solid rgba(245,196,0,.9); outline-offset: -2px; }
    ::selection { background: rgba(245,196,0,.42); }
  `;
  document.head.appendChild(style);

  document.addEventListener("mouseup", (event) => {
    if (isOurs(event.target)) return;
    setTimeout(() => {
      if (settleSelection()) return;
      if (!openElement(event.target)) post("eh:dismiss");
    }, 0);
  });

  document.addEventListener(
    "click",
    (event) => {
      if (!isOurs(event.target)) return;
      const modeButton = event.target.closest?.("[data-git-nav-mode]");
      if (modeButton) {
        event.preventDefault();
        event.stopPropagation();
        const mode = modeButton.getAttribute("data-git-nav-mode");
        applyNavigationMode(mode);
        post("eh:gitNavMode", { mode });
        return;
      }
      const href = navigationHref(event.target);
      if (!href.startsWith("#")) return;
      event.preventDefault();
      event.stopPropagation();
      const id = hashTargetId(href);
      const element = document.getElementById(id);
      if (element) element.scrollIntoView({ behavior: "smooth", block: "start" });
      location.hash = href;
    },
    true
  );

  window.addEventListener("scroll", () => post("eh:scroll", { x: window.scrollX, y: window.scrollY }), { passive: true });
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || event.origin !== CHROME_ORIGIN) return;
    const msg = event.data || {};
    switch (msg.type) {
      case "eh:anchors":
        reanchor(msg.comments || []);
        break;
      case "eh:gitNavMode":
        applyNavigationMode(msg.mode);
        break;
      case "eh:gitNavWidth":
        applyNavigationWidth(msg.width);
        break;
      case "eh:commit":
        commitPending(msg.id);
        composeOpen = false;
        break;
      case "eh:cancel":
        pending = null;
        composeOpen = false;
        break;
      case "eh:composeOpen":
        composeOpen = true;
        break;
      case "eh:remove":
        document.querySelectorAll(`[data-eh-el="${CSS.escape(msg.id)}"]`).forEach((element) => element.removeAttribute("data-eh-el"));
        break;
      case "eh:activate":
        activate(msg.id, !!msg.scroll);
        break;
      case "eh:flush":
        post("eh:flushed");
        break;
      case "eh:restoreScroll":
        window.scrollTo(msg.x || 0, msg.y || 0);
        break;
      default:
        break;
    }
  });
  post("eh:ready", { scrollHeight: document.body.scrollHeight, readonly: true });
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
else boot();
