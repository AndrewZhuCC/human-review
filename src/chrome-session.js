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

export function gitNavWidth(value) {
  if (value === null || value === undefined || value === "") return 260;
  const width = Number(value);
  return Number.isFinite(width) ? Math.min(520, Math.max(180, Math.round(width))) : 260;
}
