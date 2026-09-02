import test from "node:test";
import assert from "node:assert/strict";

import { agentDisplay, pageUrl, replacePage } from "../src/chrome-session.js";

test("page refreshes keep session context and clear stale cross-page counts", () => {
  assert.equal(pageUrl("abc123", "session with spaces"), "/api/page/abc123?session=session%20with%20spaces");

  const state = {
    page: { edits: [{ label: "old" }] },
    others: [{ key: "other", count: 60 }],
  };

  const refreshed = { key: "abc123", comments: [], edits: [], others: [] };
  replacePage(state, refreshed);

  assert.equal(state.page, refreshed);
  assert.deepEqual(state.others, []);
});

test("agent poll state is visible before feedback is sent", () => {
  assert.deepEqual(agentDisplay("idle"), { visible: false, text: "", tone: "idle" });
  assert.deepEqual(agentDisplay("listening"), {
    visible: true,
    text: "Agent is listening — send feedback when ready",
    tone: "ready",
  });
  assert.deepEqual(agentDisplay("working"), {
    visible: true,
    text: "Feedback delivered — page reloads when fixes land",
    tone: "working",
  });
  assert.deepEqual(agentDisplay("stranded"), { visible: false, text: "", tone: "idle" });
});
