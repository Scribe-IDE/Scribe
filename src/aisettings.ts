// Settings > AI: which provider, its key (kept in the keychain by the back end), the model, and
// whether suggestions appear as you type.
import { $, setStatus } from "./core";
import { aiConfig, aiStream, hasKey, listModels, PROVIDERS, saveAiConfig, setKey, type ProviderKind } from "./ai";

const info = () => PROVIDERS.find((p) => p.id === aiConfig.kind);

async function fillModels() {
  const list = $("ai-models");
  const known = info()?.models ?? [];
  list.replaceChildren(...known.map((m) => Object.assign(document.createElement("option"), { value: m })));
  // the provider's own list, when it can be reached with the key we have
  const found = await listModels().catch(() => [] as string[]);
  const all = [...new Set([...known, ...found])];
  list.replaceChildren(...all.map((m) => Object.assign(document.createElement("option"), { value: m })));
}

async function renderKey() {
  const p = info();
  if (!p) return;
  const input = $<HTMLInputElement>("ai-key");
  input.value = "";
  const kept = await hasKey(p.id).catch(() => false);
  input.placeholder = kept ? "In the keychain" : p.needsKey ? "Paste the key" : "None needed";
  input.title = kept ? "A key is kept in the keychain; paste another to replace it" : "";
}

export function renderAiSettings() {
  const select = $<HTMLSelectElement>("ai-provider");
  if (!select.options.length) {
    select.append(new Option("Off", "off"), ...PROVIDERS.map((p) => new Option(p.name, p.id)));
  }
  select.value = aiConfig.kind;
  const p = info();
  $("ai-fields").hidden = !p;
  if (!p) return;
  $("ai-url-row").hidden = !(p.needsUrl || p.id === "ollama");
  $<HTMLInputElement>("ai-url").placeholder = p.id === "ollama" ? "http://localhost:11434/v1" : "https://…/v1";
  $<HTMLInputElement>("ai-url").value = aiConfig.baseUrl;
  $<HTMLInputElement>("ai-model").value = aiConfig.model;
  $<HTMLInputElement>("ai-model").placeholder = p.model || "Choose or type a model";
  $<HTMLInputElement>("ai-inline").checked = aiConfig.inline;
  $("ai-test-result").textContent = "Connection";
  renderKey();
  fillModels();
}

export function initAiSettings() {
  $("ai-provider").addEventListener("change", (e) => {
    const kind = (e.target as HTMLSelectElement).value as ProviderKind | "off";
    const p = PROVIDERS.find((x) => x.id === kind);
    saveAiConfig({ kind, model: p?.model ?? "", baseUrl: "" });
    renderAiSettings();
  });
  $("ai-url").addEventListener("change", (e) => {
    saveAiConfig({ baseUrl: (e.target as HTMLInputElement).value.trim() });
    fillModels();
  });
  $("ai-model").addEventListener("change", (e) => saveAiConfig({ model: (e.target as HTMLInputElement).value.trim() }));
  $("ai-inline").addEventListener("change", (e) => saveAiConfig({ inline: (e.target as HTMLInputElement).checked }));
  const key = $<HTMLInputElement>("ai-key");
  const keepKey = async () => {
    const p = info();
    if (!p || !key.value.trim()) return;
    try {
      await setKey(p.id, key.value.trim());
      setStatus(`Key kept in the keychain for ${p.name}`, "ok");
    } catch (err) {
      setStatus(String(err), "err");
    }
    await renderKey();
    fillModels();
  };
  key.addEventListener("change", keepKey);
  key.addEventListener("keydown", (e) => {
    if (e.key === "Enter") key.blur();
  });
  $("ai-test").addEventListener("click", async () => {
    const result = $("ai-test-result");
    result.textContent = "Testing…";
    try {
      const { text } = await aiStream({ system: "You check that a connection works.", messages: [{ role: "user", content: "Reply with the single word: ready" }], maxTokens: 1024, speed: "low" });
      result.textContent = text.trim() ? `Works (${aiConfig.model})` : "Connected, but the reply was empty";
    } catch (err) {
      result.textContent = "Doesn't work";
      setStatus(String(err).replace(/^Error: /, ""), "err");
    }
  });
  renderAiSettings();
}
