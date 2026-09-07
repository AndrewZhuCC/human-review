import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { SERVER_PROTOCOL } from "../src/paths.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "human-review-loop-"));
process.env.HUMAN_REVIEW_STATE_DIR = path.join(tmp, "state");
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env, HUMAN_REVIEW_STATE_DIR: process.env.HUMAN_REVIEW_STATE_DIR };

function request(server, method, route, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: server.port,
        method,
        path: route,
        headers: {
          "x-human-review-token": server.token || "",
          ...(body ? { "content-type": "application/json" } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
      }
    );
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function collect(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

const cliFrom = (cwd, ...args) => spawn(process.execPath, [path.join(project, "src/cli.js"), ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
const cli = (...args) => cliFrom(project, ...args);

function spawnServer() {
  return spawn(process.execPath, ["src/server-entry.js"], { cwd: project, env, stdio: "ignore" });
}

async function waitForServer(notPid) {
  const record = path.join(process.env.HUMAN_REVIEW_STATE_DIR, "server.json");
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      const saved = JSON.parse(fs.readFileSync(record, "utf8"));
      if (notPid && saved.pid === notPid) throw new Error("stale record");
      const health = await request(saved, "GET", "/health");
      if (health.status === 200) return saved;
    } catch {
      // Not announced yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("review server did not start");
}

async function stop(child) {
  if (child.exitCode === null) {
    child.kill();
    await once(child, "exit");
  }
}

// Flat, sequential top-level tests (no nested subtests): the nested form
// trips node:test's parent-cancellation accounting on Windows even when
// every subtest passes. Module-scope state carries between them; node runs
// a file's top-level tests in order.
const file = path.join(tmp, "review.html");
fs.writeFileSync(file, "<p>Original</p>");
const first = spawnServer();
let server;
let reviewKey;
let reviewCommentId;

test("poll --timeout exits cleanly with a timeout status", async () => {
  server = await waitForServer();
  assert.equal(server.protocol, SERVER_PROTOCOL);
  const result = await collect(cli("poll", file, "--timeout", "1"));
  assert.equal(result.code, 0, result.stderr);
  const out = JSON.parse(result.stdout);
  assert.equal(out.status, "timeout");
  assert.equal(out.waited_seconds, 1);
});

test("status is idle before feedback, waiting after", async () => {
  const before = await collect(cli("status", file));
  assert.equal(before.code, 0, before.stderr);
  assert.equal(JSON.parse(before.stdout).status, "idle");

  const opened = await request(server, "POST", "/api/session", { file });
  reviewKey = opened.body.key;
  const commented = await request(server, "POST", `/api/page/${reviewKey}/comment`, {
    kind: "selection",
    quote: "Original",
    feedback: "Why does this need to be sharper?",
  });
  reviewCommentId = commented.body.comment.id;
  await request(server, "POST", `/api/page/${reviewKey}/send`, { sessionId: opened.body.sessionId, note: "Can you also explain the overall approach?" });

  const after = await collect(cli("status", file));
  assert.equal(after.code, 0, after.stderr);
  const parsed = JSON.parse(after.stdout);
  assert.equal(parsed.status, "feedback-waiting");
  assert.equal(parsed.feedback_waiting, true);

  const relative = await collect(cliFrom(project, "status", path.basename(file)));
  assert.equal(relative.code, 0, relative.stderr);
  assert.equal(JSON.parse(relative.stdout).feedback_waiting, true, "a known relative target resolves outside the CLI cwd");
});

test("reply command attaches an agent response to the sent comment", async () => {
  const result = await collect(cli("reply", file, reviewCommentId, "--message", "It makes the requirement easier to verify."));
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, "replied");
  assert.equal(output.comment_id, reviewCommentId);

  const page = await request(server, "GET", `/api/page/${reviewKey}`);
  const comment = page.body.lastReview.comments.find((item) => item.id === reviewCommentId);
  assert.equal(comment.agent_reply.text, "It makes the requirement easier to verify.");
  assert.ok(comment.agent_reply.replied_at);
});

test("reply command can answer the Overall note", async () => {
  const result = await collect(cli("reply", file, "overall", "--message", "The overall approach keeps feedback attached to its source context."));
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).comment_id, "overall");
  const page = await request(server, "GET", `/api/page/${reviewKey}`);
  assert.equal(page.body.lastReview.overall_reply.text, "The overall approach keeps feedback attached to its source context.");
});

test("reply command rejects a thread outside the latest review", async () => {
  const result = await collect(cli("reply", file, "c_missing", "--message", "No such thread."));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /thread is not in the latest sent review/);
});

test("a protocol replacement stops the old server and still delivers its persisted batch", async () => {
  const record = path.join(process.env.HUMAN_REVIEW_STATE_DIR, "server.json");
  fs.writeFileSync(record, JSON.stringify({ ...server, protocol: SERVER_PROTOCOL - 1 }));

  const result = await collect(cli("poll", file, "--timeout", "10"));
  assert.equal(result.code, 0, result.stderr);
  const batch = JSON.parse(result.stdout);
  assert.equal(batch.status, "feedback");
  assert.equal(batch.pages[0].comments[0].feedback, "Why does this need to be sharper?");

  const replacement = await waitForServer(server.pid);
  assert.notEqual(replacement.pid, server.pid, "the mismatched server was replaced rather than left running");
  try {
    process.kill(replacement.pid, "SIGTERM");
  } catch {}
});

test.after(async () => {
  await stop(first);
  fs.rmSync(tmp, { recursive: true, force: true });
});
