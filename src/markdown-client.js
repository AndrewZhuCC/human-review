import mermaid from "/vendor/mermaid/mermaid.esm.min.mjs";

mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });

function showError(element, source) {
  element.replaceChildren();
  element.className = "mermaid-diagram mermaid-error";
  const label = document.createElement("strong");
  label.textContent = "Mermaid diagram could not be rendered";
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.textContent = source;
  pre.appendChild(code);
  element.append(label, pre);
}

for (const element of document.querySelectorAll(".mermaid")) {
  const source = element.textContent || "";
  try {
    const valid = await mermaid.parse(source, { suppressErrors: true });
    if (!valid) {
      showError(element, source);
      continue;
    }
    await mermaid.run({ nodes: [element], suppressErrors: true });
    if (!element.querySelector("svg")) showError(element, source);
  } catch {
    showError(element, source);
  }
}

const key = new URL(import.meta.url).searchParams.get("key") || "";
await import(`/sdk.js?key=${encodeURIComponent(key)}`);
