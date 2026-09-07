import path from "node:path";
import { marked, Renderer } from "marked";

export const isMarkdown = (file) => /\.(md|markdown)$/i.test(file);

/**
 * Readable defaults for rendered Markdown. This HTML is a viewing surface
 * only — it is never written back to disk, so the styling can be opinionated.
 */
const STYLE = `
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body {
    margin: 0; background: #fdfcfa; color: #1b1a16;
    font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .review-layout { width: 100%; }
  .review-layout > main { max-width: 72ch; margin: 0 auto; padding: 48px 28px 96px; }
  body > main { max-width: 72ch; margin: 0 auto; padding: 48px 28px 96px; }
  .toc {
    position: fixed; top: 0; bottom: 0; left: 24px; width: min(240px, calc((100vw - 72ch) / 2 - 52px));
    min-width: 160px; padding: 48px 0 40px; overflow: auto; color: #6b6862;
  }
  .toc-title {
    margin: 0 0 12px; color: #1b1a16; font-size: 12px; font-weight: 650;
    letter-spacing: .08em; text-transform: uppercase;
  }
  .toc ol { margin: 0; padding: 0; list-style: none; }
  .toc li { margin: 1px 0; }
  .toc a {
    display: block; padding: 4px 8px; border-radius: 5px; color: inherit;
    font-size: 13px; line-height: 1.35; text-decoration: none;
  }
  .toc a:hover { background: #f2f0ea; color: #1b1a16; }
  .toc .depth-2 a { padding-left: 20px; }
  .toc .depth-3 a { padding-left: 32px; color: #88847b; }
  h1, h2, h3, h4 { line-height: 1.25; margin: 1.6em 0 .5em; scroll-margin-top: 20px; }
  h1:target, h2:target, h3:target, h4:target, h5:target, h6:target {
    animation: target-flash 1.2s ease-out;
  }
  @keyframes target-flash { from { background: #fff0a8; } to { background: transparent; } }
  h1 { font-size: 2em; margin-top: .4em; }
  h2 { font-size: 1.45em; border-bottom: 1px solid #eceae3; padding-bottom: .25em; }
  h3 { font-size: 1.15em; }
  p, ul, ol { margin: .75em 0; }
  li { margin: .3em 0; }
  a { color: #295fcc; }
  code {
    background: #f2f0ea; border-radius: 4px; padding: .12em .35em;
    font: .88em/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  pre { background: #f2f0ea; border-radius: 8px; padding: 14px 16px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  .mermaid-diagram { margin: 1.25em 0; padding: 18px; overflow-x: auto; border: 1px solid #e4e2db; border-radius: 10px; background: #fff; text-align: center; }
  .mermaid-diagram svg { display: block; max-width: 100%; height: auto; margin: 0 auto; }
  .mermaid-error { border-color: #e7b4ad; background: #fff5f3; color: #8b2c20; text-align: left; }
  .mermaid-error strong { display: block; margin-bottom: 8px; font: 600 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .mermaid-error pre { margin: 0; background: rgba(255,255,255,.65); color: #1b1a16; }
  blockquote { margin: 1em 0; padding: .1em 1em; border-left: 3px solid #d8d5cb; color: #6b6862; }
  table { border-collapse: collapse; margin: 1em 0; width: 100%; }
  th, td { border: 1px solid #e4e2db; padding: 7px 11px; text-align: left; }
  th { background: #f7f5f0; }
  img { max-width: 100%; height: auto; }
  hr { border: none; border-top: 1px solid #eceae3; margin: 2.2em 0; }
  @media (max-width: 1160px) {
    .toc { display: none; }
  }
`;

const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const escapeAttribute = (value) => escapeHtml(value).replace(/"/g, "&quot;");

function slugger() {
  const used = new Map();
  return (text) => {
    const base =
      String(text || "")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .trim()
        .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
        .replace(/^-+|-+$/g, "") || "section";
    const count = (used.get(base) || 0) + 1;
    used.set(base, count);
    return count === 1 ? base : `${base}-${count}`;
  };
}

function safeUrl(value, { image = false } = {}) {
  const url = String(value || "").trim();
  const probe = url.replace(/[\u0000-\u0020\u007f]+/g, "");
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(probe);
  if (!match) return url;
  const scheme = match[1].toLowerCase();
  if (scheme === "http" || scheme === "https") return url;
  if (!image && scheme === "mailto") return url;
  if (image && /^data:image\/(?:avif|gif|jpe?g|png|webp);base64,/i.test(probe)) return url;
  return null;
}

// Markdown can contain arbitrary HTML. Show that source as text so event
// handlers, embeds, SVG, and future browser features can never become active.
function createRenderer(headings) {
  const renderer = new Renderer();
  const nextSlug = slugger();
  renderer.html = ({ text }) => escapeHtml(text);
  renderer.code = function (token) {
    const language = String(token.lang || "").trim().split(/\s+/, 1)[0].toLowerCase();
    if (language !== "mermaid") return Renderer.prototype.code.call(this, token);
    return `<div class="mermaid-diagram mermaid" data-container="Mermaid diagram">${escapeHtml(token.text)}</div>\n`;
  };
  renderer.link = function (token) {
    const href = safeUrl(token.href);
    if (!href) return this.parser.parseInline(token.tokens);
    return Renderer.prototype.link.call(this, { ...token, href });
  };
  renderer.image = function (token) {
    const href = safeUrl(token.href, { image: true });
    if (!href) return escapeHtml(token.text || "");
    return Renderer.prototype.image.call(this, { ...token, href });
  };
  renderer.heading = function ({ tokens, depth }) {
    const html = this.parser.parseInline(tokens);
    const text = this.parser.parseInline(tokens, this.parser.textRenderer).trim();
    const id = nextSlug(text);
    if (depth <= 3) headings.push({ depth, id, text });
    return `<h${depth} id="${escapeAttribute(id)}">${html}</h${depth}>\n`;
  };
  return renderer;
}

function renderToc(headings) {
  if (!headings.length) return "";
  const items = headings
    .map(
      ({ depth, id, text }) =>
        `<li class="depth-${depth}"><a href="#${escapeAttribute(id)}">${escapeHtml(text)}</a></li>`
    )
    .join("\n");
  return `<nav class="toc" aria-label="Table of contents" data-eh-ui>
<p class="toc-title">Contents</p>
<ol>${items}</ol>
</nav>`;
}

/** Render a Markdown file into a standalone review page. */
export function renderMarkdownPage(mdText, file) {
  const headings = [];
  const body = marked.parse(mdText, { gfm: true, async: false, renderer: createRenderer(headings) });
  const toc = renderToc(headings);
  const title = path.basename(file);
  const content = toc ? `<div class="review-layout">${toc}<main>${body}</main></div>` : `<main>${body}</main>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</title>
<style>${STYLE}</style>
</head>
<body>${content}</body>
</html>
`;
}
