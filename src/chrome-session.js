export function pageUrl(key, sessionId) {
  return `/api/page/${key}?session=${encodeURIComponent(sessionId)}`;
}

export function replacePage(state, page) {
  state.page = page;
  state.others = page.others || [];
}

export function agentDisplay(state) {
  if (state === "listening") return { visible: true, text: "Agent is listening — send feedback when ready", tone: "ready" };
  if (state === "working") return { visible: true, text: "Feedback delivered — page reloads when fixes land", tone: "working" };
  return { visible: false, text: "", tone: "idle" };
}
