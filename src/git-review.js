import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { gitRoot as resolveGitRoot } from "./paths.js";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MAX_FILES = 300;
const MAX_DIFF_BYTES = 12 * 1024 * 1024;
const MAX_DIFF_LINES = 30000;
const MAX_UNTRACKED_BYTES = 512 * 1024;
const FULL_CONTEXT_LINES = 999999;
const FOLD_CONTEXT_AFTER = 8;
const FOLD_EDGE_LINES = 3;

const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const escapeAttribute = (value) => escapeHtml(value).replace(/"/g, "&quot;");
const stableId = (...parts) => crypto.createHash("sha1").update(parts.join("\0")).digest("hex").slice(0, 12);

function git(repo, args, { allowStatus = [], encoding = "utf8", maxBuffer = MAX_DIFF_BYTES } = {}) {
  const result = spawnSync("git", ["-C", repo, ...args], {
    encoding: encoding === "buffer" ? null : encoding,
    maxBuffer,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowStatus.includes(result.status)) {
    const detail = String(result.stderr || result.stdout || "").trim();
    throw new Error(detail || `git ${args[0]} failed with status ${result.status}`);
  }
  return result.stdout;
}

export function gitRoot(input = ".") {
  const root = resolveGitRoot(input);
  if (!root) throw new Error(`Not a Git repository: ${path.resolve(input || ".")}`);
  return root;
}

function statFingerprint(file) {
  try {
    const stat = fs.statSync(file, { bigint: true });
    return `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.mode}`;
  } catch {
    return "missing";
  }
}

/**
 * Cheap working-tree fingerprint for auto-refresh. Unlike collectGitChanges(),
 * this never constructs or parses a patch; it hashes Git status plus metadata
 * for every changed/untracked file and the index/HEAD state.
 */
export function gitChangeFingerprint(input) {
  const repo = gitRoot(input);
  const status = git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { maxBuffer: MAX_DIFF_BYTES });
  const records = status.split("\0");
  const paths = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    const code = record.slice(0, 2);
    const file = record.slice(3);
    if (file) paths.push(file);
    if (/^[RC]/.test(code) || /[RC]$/.test(code)) {
      const previous = records[index + 1];
      if (previous) paths.push(previous);
      index += 1;
    }
  }
  const head = git(repo, ["rev-parse", "--verify", "HEAD"], { allowStatus: [128], maxBuffer: 1024 }).trim();
  const gitDir = git(repo, ["rev-parse", "--git-dir"], { maxBuffer: 4096 }).trim();
  const absoluteGitDir = path.resolve(repo, gitDir);
  const metadata = [...new Set(paths)].sort().map((file) => `${file}\0${statFingerprint(path.join(repo, file))}`);
  metadata.push(`index\0${statFingerprint(path.join(absoluteGitDir, "index"))}`);
  metadata.push(`head\0${head}`);
  return crypto.createHash("sha256").update(status).update("\0").update(metadata.join("\0")).digest("hex");
}

function gitAsync(repo, args, { maxBuffer = MAX_DIFF_BYTES, allowStatus = [] } = {}) {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer, windowsHide: true }, (error, stdout, stderr) => {
      if (error && !allowStatus.includes(error.code)) {
        const detail = String(stderr || stdout || error.message || "").trim();
        reject(new Error(detail || `git ${args[0]} failed`));
        return;
      }
      resolve(stdout || "");
    });
  });
}

/** Non-blocking variant used by the server's working-tree watcher. */
export async function gitChangeFingerprintAsync(input) {
  const repo = path.resolve(String(input || "."));
  const [status, head, gitDir] = await Promise.all([
    gitAsync(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    gitAsync(repo, ["rev-parse", "--verify", "HEAD"], { allowStatus: [128], maxBuffer: 1024 }),
    gitAsync(repo, ["rev-parse", "--git-dir"], { maxBuffer: 4096 }),
  ]);
  const records = status.split("\0");
  const paths = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    const code = record.slice(0, 2);
    const file = record.slice(3);
    if (file) paths.push(file);
    if (/^[RC]/.test(code) || /[RC]$/.test(code)) {
      const previous = records[index + 1];
      if (previous) paths.push(previous);
      index += 1;
    }
  }
  const absoluteGitDir = path.resolve(repo, gitDir.trim());
  const metadata = [...new Set(paths)].sort().map((file) => `${file}\0${statFingerprint(path.join(repo, file))}`);
  metadata.push(`index\0${statFingerprint(path.join(absoluteGitDir, "index"))}`);
  metadata.push(`head\0${head.trim()}`);
  return crypto.createHash("sha256").update(status).update("\0").update(metadata.join("\0")).digest("hex");
}

function hasHead(repo) {
  const result = spawnSync("git", ["-C", repo, "rev-parse", "--verify", "HEAD"], {
    encoding: "utf8",
    windowsHide: true,
  });
  return result.status === 0;
}

function cleanPatchPath(value) {
  let text = String(value || "").trim();
  if (text === "/dev/null") return "";
  if (text.startsWith('"') && text.endsWith('"')) {
    try {
      text = JSON.parse(text);
    } catch {}
  }
  return text.replace(/^[ab]\//, "");
}

/** Parse Git's unified patch into stable file/hunk/line records. */
export function parseUnifiedDiff(patch) {
  const files = [];
  let file = null;
  let hunk = null;
  let oldLine = 0;
  let newLine = 0;
  const lines = String(patch || "").split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    // split() manufactures one trailing empty item for the patch's final
    // newline. A real blank context line is represented as " ", not "".
    if (index === lines.length - 1 && raw === "") continue;
    if (raw.startsWith("diff --git ")) {
      file = { oldPath: "", newPath: "", path: "", status: "modified", binary: false, hunks: [], meta: [] };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    if (raw.startsWith("new file mode ")) {
      file.status = "added";
      file.meta.push(raw);
      continue;
    }
    if (raw.startsWith("deleted file mode ")) {
      file.status = "deleted";
      file.meta.push(raw);
      continue;
    }
    if (raw.startsWith("rename from ")) {
      file.status = "renamed";
      file.oldPath = raw.slice("rename from ".length);
      file.meta.push(raw);
      continue;
    }
    if (raw.startsWith("rename to ")) {
      file.status = "renamed";
      file.newPath = raw.slice("rename to ".length);
      file.path = file.newPath;
      file.meta.push(raw);
      continue;
    }
    if (raw.startsWith("Binary files ") || raw === "GIT binary patch") {
      file.binary = true;
      const match = /^Binary files (.+) and (.+) differ$/.exec(raw);
      if (match) {
        file.oldPath ||= cleanPatchPath(match[1]);
        file.newPath ||= cleanPatchPath(match[2]);
        file.path ||= file.newPath || file.oldPath;
      }
      file.meta.push(raw);
      continue;
    }
    if (raw.startsWith("--- ")) {
      file.oldPath = cleanPatchPath(raw.slice(4));
      continue;
    }
    if (raw.startsWith("+++ ")) {
      file.newPath = cleanPatchPath(raw.slice(4));
      file.path = file.newPath || file.oldPath;
      continue;
    }
    if (raw.startsWith("@@ ")) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(raw);
      if (!match) continue;
      oldLine = Number(match[1]);
      newLine = Number(match[3]);
      hunk = {
        header: raw,
        oldStart: oldLine,
        oldCount: Number(match[2] || 1),
        newStart: newLine,
        newCount: Number(match[4] || 1),
        context: match[5].trim(),
        lines: [],
      };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) {
      if (raw && !raw.startsWith("index ")) file.meta.push(raw);
      continue;
    }
    if (raw === "\\ No newline at end of file") {
      hunk.lines.push({ type: "meta", text: raw, oldLine: null, newLine: null });
      continue;
    }
    const marker = raw[0];
    const text = raw.slice(1);
    if (marker === "+") {
      hunk.lines.push({ type: "add", text, oldLine: null, newLine: newLine++ });
    } else if (marker === "-") {
      hunk.lines.push({ type: "delete", text, oldLine: oldLine++, newLine: null });
    } else {
      hunk.lines.push({ type: "context", text: marker === " " ? text : raw, oldLine: oldLine++, newLine: newLine++ });
    }
  }

  return files.filter((entry) => {
    entry.path ||= entry.newPath || entry.oldPath || "unknown";
    return entry.hunks.length || entry.meta.length || entry.binary;
  });
}

function untrackedFiles(repo) {
  const raw = git(repo, ["ls-files", "--others", "--exclude-standard", "-z"], { encoding: "buffer" });
  return raw
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .slice(0, MAX_FILES);
}

function renderUntracked(repo, relative) {
  const absolute = path.join(repo, relative);
  let bytes;
  try {
    bytes = fs.readFileSync(absolute);
  } catch {
    return null;
  }
  if (bytes.includes(0)) {
    return { oldPath: "", newPath: relative, path: relative, status: "untracked", binary: true, hunks: [], meta: ["Untracked binary file"] };
  }
  const truncated = bytes.length > MAX_UNTRACKED_BYTES;
  const source = bytes.subarray(0, MAX_UNTRACKED_BYTES).toString("utf8");
  const rows = source.split(/\r?\n/);
  if (rows.at(-1) === "") rows.pop();
  const hunk = {
    header: `@@ -0,0 +1,${rows.length} @@`,
    oldStart: 0,
    oldCount: 0,
    newStart: 1,
    newCount: rows.length,
    context: "",
    lines: rows.map((text, index) => ({ type: "add", text, oldLine: null, newLine: index + 1 })),
  };
  if (truncated) hunk.lines.push({ type: "meta", text: "… untracked file truncated …", oldLine: null, newLine: null });
  return { oldPath: "", newPath: relative, path: relative, status: "untracked", binary: false, hunks: [hunk], meta: [] };
}

export function collectGitChanges(input) {
  const repo = gitRoot(input);
  const base = hasHead(repo) ? "HEAD" : EMPTY_TREE;
  let patch;
  let contextTruncated = false;
  try {
    patch = git(repo, ["-c", "core.quotePath=false", "diff", "--find-renames", "--no-color", "--no-ext-diff", `--unified=${FULL_CONTEXT_LINES}`, base, "--"]);
  } catch {
    // A very large full-context patch must not prevent review entirely. Fall
    // back to Git's conventional context and say so in the page summary.
    patch = git(repo, ["-c", "core.quotePath=false", "diff", "--find-renames", "--no-color", "--no-ext-diff", "--unified=3", base, "--"]);
    contextTruncated = true;
  }
  const files = parseUnifiedDiff(patch).slice(0, MAX_FILES);
  const known = new Set(files.map((entry) => entry.path));
  for (const relative of untrackedFiles(repo)) {
    if (known.has(relative) || files.length >= MAX_FILES) continue;
    const entry = renderUntracked(repo, relative);
    if (entry) files.push(entry);
  }
  let totalLines = 0;
  let truncated = contextTruncated;
  for (const file of files) {
    for (const hunk of file.hunks) {
      if (totalLines >= MAX_DIFF_LINES) {
        hunk.lines = [];
        truncated = true;
        continue;
      }
      const room = MAX_DIFF_LINES - totalLines;
      if (hunk.lines.length > room) {
        hunk.lines = hunk.lines.slice(0, room);
        hunk.lines.push({ type: "meta", text: "… diff truncated …", oldLine: null, newLine: null });
        truncated = true;
      }
      totalLines += hunk.lines.length;
    }
  }
  const stats = {
    files: files.length,
    additions: files.flatMap((file) => file.hunks).flatMap((hunk) => hunk.lines).filter((line) => line.type === "add").length,
    deletions: files.flatMap((file) => file.hunks).flatMap((hunk) => hunk.lines).filter((line) => line.type === "delete").length,
    truncated,
  };
  return { repo, files, stats };
}

const STYLE = `
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body { margin: 0; background: #f6f7f9; color: #24292f; font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .layout { min-height: 100vh; }
  .files { position: fixed; inset: 0 auto 0 0; width: 260px; overflow: auto; padding: 18px 12px 40px; border-right: 1px solid #d8dee4; background: #fff; }
  .files h1 { margin: 0 8px 5px; font: 600 14px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .summary { margin: 0 8px 10px; color: #57606a; font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .nav-switch { display: grid; grid-template-columns: 1fr 1fr; gap: 3px; margin: 0 8px 10px; padding: 3px; border-radius: 7px; background: #eef1f4; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .nav-switch button { border: 0; border-radius: 5px; padding: 5px 8px; background: transparent; color: #57606a; cursor: pointer; }
  .nav-switch button[aria-pressed="true"] { background: #fff; color: #24292f; box-shadow: 0 1px 2px rgba(31,35,40,.12); font-weight: 600; }
  .nav-view[hidden] { display: none; }
  .files a { display: block; padding: 5px 8px; border-radius: 5px; color: #57606a; text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .files a:hover { background: #f3f4f6; color: #0969da; }
  .tree-dir { margin-left: 5px; }
  .tree-dir > summary { padding: 5px 5px; border-radius: 5px; color: #57606a; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .tree-dir > summary:hover { background: #f3f4f6; color: #0969da; }
  .tree-children { margin-left: 9px; padding-left: 6px; border-left: 1px solid #d8dee4; }
  main { margin-left: 260px; padding: 24px 28px 100px; }
  .empty { max-width: 720px; margin: 80px auto; padding: 32px; border: 1px dashed #afb8c1; border-radius: 10px; background: #fff; color: #57606a; text-align: center; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .file { margin: 0 auto 24px; max-width: 1180px; border: 1px solid #d0d7de; border-radius: 8px; overflow: hidden; background: #fff; }
  .file-head { position: sticky; top: 0; z-index: 2; display: flex; gap: 10px; align-items: center; padding: 9px 12px; border-bottom: 1px solid #d0d7de; background: #f6f8fa; }
  .file-path { font-weight: 600; overflow-wrap: anywhere; }
  .status { padding: 1px 6px; border-radius: 999px; background: #ddf4ff; color: #0550ae; font-size: 11px; }
  .binary, .meta-block { padding: 14px; color: #57606a; white-space: pre-wrap; }
  .hunk { border-top: 1px solid #d8dee4; }
  .hunk:first-of-type { border-top: 0; }
  .hunk-head { padding: 7px 12px; background: #ddf4ff; color: #0550ae; white-space: pre-wrap; }
  .line { display: grid; grid-template-columns: 54px 54px 20px minmax(0, 1fr); min-height: 22px; }
  .line:hover { box-shadow: inset 3px 0 0 #0969da; }
  .line.add { background: #dafbe1; }
  .line.delete { background: #ffebe9; }
  .line.meta { background: #f6f8fa; color: #57606a; }
  .fold { border-block: 1px solid #d8dee4; background: #f6f8fa; }
  .fold summary { padding: 6px 12px; color: #57606a; cursor: pointer; user-select: none; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .fold summary:hover { background: #eef1f4; color: #0969da; }
  .fold[open] summary { border-bottom: 1px solid #d8dee4; }
  .num { padding: 2px 8px; border-right: 1px solid rgba(27,31,36,.08); color: #6e7781; text-align: right; user-select: none; }
  .mark { padding: 2px 3px; user-select: none; }
  .code { padding: 2px 8px; white-space: pre-wrap; overflow-wrap: anywhere; tab-size: 4; }
  @media (max-width: 900px) { .files { position: static; width: auto; max-height: 220px; border-right: 0; border-bottom: 1px solid #d8dee4; } main { margin-left: 0; padding: 16px 10px 80px; } }
`;

function gitAttrs(context) {
  const pairs = {
    "data-git-path": context.path,
    "data-git-side": context.side,
    "data-git-line": context.line,
    "data-git-old-line": context.oldLine,
    "data-git-new-line": context.newLine,
    "data-git-hunk": context.hunk,
    "data-git-kind": context.kind,
  };
  return Object.entries(pairs)
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([name, value]) => `${name}="${escapeAttribute(value)}"`)
    .join(" ");
}

function renderDiffLine(file, hunk, line, lineIndex) {
  const side = line.type === "add" ? "new" : line.type === "delete" ? "old" : "context";
  const lineNo = line.newLine ?? line.oldLine ?? "";
  const rowId = `line-${stableId(file.path, hunk.header, side, line.oldLine, line.newLine, lineIndex)}`;
  const marker = line.type === "add" ? "+" : line.type === "delete" ? "-" : line.type === "meta" ? "" : " ";
  const context = {
    path: file.path,
    kind: "line",
    side,
    line: lineNo,
    oldLine: line.oldLine,
    newLine: line.newLine,
    hunk: hunk.header,
  };
  const label = `${file.path}:${lineNo || "meta"}`;
  return `<div id="${rowId}" class="line ${line.type}" data-block="${escapeAttribute(label)}" ${gitAttrs(context)}><span class="num">${line.oldLine ?? ""}</span><span class="num">${line.newLine ?? ""}</span><span class="mark">${marker}</span><span class="code">${escapeHtml(line.text)}</span></div>`;
}

function renderHunkLines(file, hunk) {
  const out = [];
  let index = 0;
  while (index < hunk.lines.length) {
    if (hunk.lines[index].type !== "context") {
      out.push(renderDiffLine(file, hunk, hunk.lines[index], index));
      index += 1;
      continue;
    }
    let end = index;
    while (end < hunk.lines.length && hunk.lines[end].type === "context") end += 1;
    const count = end - index;
    if (count <= FOLD_CONTEXT_AFTER) {
      for (let cursor = index; cursor < end; cursor += 1) out.push(renderDiffLine(file, hunk, hunk.lines[cursor], cursor));
    } else {
      const leading = hunk.lines.slice(index, index + FOLD_EDGE_LINES);
      const hiddenStart = index + FOLD_EDGE_LINES;
      const hiddenEnd = end - FOLD_EDGE_LINES;
      const trailing = hunk.lines.slice(hiddenEnd, end);
      leading.forEach((line, offset) => out.push(renderDiffLine(file, hunk, line, index + offset)));
      const hidden = hunk.lines
        .slice(hiddenStart, hiddenEnd)
        .map((line, offset) => renderDiffLine(file, hunk, line, hiddenStart + offset))
        .join("\n");
      const hiddenCount = hiddenEnd - hiddenStart;
      out.push(`<details class="fold"><summary data-eh-ui>Show ${hiddenCount} unchanged lines</summary>${hidden}</details>`);
      trailing.forEach((line, offset) => out.push(renderDiffLine(file, hunk, line, hiddenEnd + offset)));
    }
    index = end;
  }
  return out.join("\n");
}

function navigationLink(file, label = file.path) {
  return `<a href="#file-${stableId(file.path)}" title="${escapeAttribute(file.path)}">${escapeHtml(label)}</a>`;
}

function navigationTree(files) {
  const root = { dirs: new Map(), files: [] };
  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
      node = node.dirs.get(part);
    }
    node.files.push({ ...file, name: parts.at(-1) || file.path });
  }
  const renderNode = (node) => {
    const directories = [...node.dirs.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, child]) => `<details class="tree-dir" open><summary data-eh-ui>${escapeHtml(name)}</summary><div class="tree-children">${renderNode(child)}</div></details>`);
    const leaves = [...node.files]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((file) => navigationLink(file, file.name));
    return [...directories, ...leaves].join("\n");
  };
  return renderNode(root);
}

export function renderGitReview(input) {
  const change = collectGitChanges(input);
  const flatNavigation = change.files.map((file) => navigationLink(file)).join("\n");
  const treeNavigation = navigationTree(change.files);
  const navigation = `<div class="nav-switch" role="group" aria-label="File navigation layout"><button type="button" data-git-nav-mode="tree" aria-pressed="true" data-eh-ui>Tree</button><button type="button" data-git-nav-mode="list" aria-pressed="false" data-eh-ui>List</button></div><div class="nav-view tree-view" data-git-nav-view="tree">${treeNavigation}</div><div class="nav-view list-view" data-git-nav-view="list" hidden>${flatNavigation}</div>`;
  const sections = change.files
    .map((file) => {
      const fileId = `file-${stableId(file.path)}`;
      const fileContext = { path: file.path, kind: "file" };
      const meta = file.meta.length ? `<div class="meta-block">${escapeHtml(file.meta.join("\n"))}</div>` : "";
      const body = file.binary
        ? `<div class="binary">Binary content is not rendered.</div>`
        : file.hunks
            .map((hunk, hunkIndex) => {
              const hunkId = `hunk-${stableId(file.path, hunk.header, hunkIndex)}`;
              const hunkContext = { path: file.path, kind: "hunk", hunk: hunk.header };
              const rows = renderHunkLines(file, hunk);
              return `<section id="${hunkId}" class="hunk" data-container="${escapeAttribute(`${file.path} · ${hunk.header}`)}" ${gitAttrs(hunkContext)}><div class="hunk-head">${escapeHtml(hunk.header)}</div>${rows}</section>`;
            })
            .join("\n");
      return `<article id="${fileId}" class="file" data-container="${escapeAttribute(file.path)}" ${gitAttrs(fileContext)}><header class="file-head"><span class="file-path">${escapeHtml(file.path)}</span><span class="status">${escapeHtml(file.status)}</span></header>${meta}${body}</article>`;
    })
    .join("\n");
  const summary = `${change.stats.files} files · +${change.stats.additions} −${change.stats.deletions}${change.stats.truncated ? " · truncated" : ""}`;
  const content = sections || `<div class="empty">No working tree changes to review.</div>`;
  return {
    ...change,
    html: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Git changes · ${escapeHtml(path.basename(change.repo))}</title><style>${STYLE}</style></head><body><div class="layout"><nav class="files" data-eh-ui><h1>${escapeHtml(path.basename(change.repo))}</h1><p class="summary">${escapeHtml(summary)}</p>${navigation}</nav><main>${content}</main></div></body></html>`,
  };
}
