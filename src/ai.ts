// The AI assistant's settings and its one way to talk to a model: a streamed request through
// the back end (ai.rs), which holds the keys. Which provider and model is the user's choice,
// kept on this computer; nothing is sent until one is set.
import { Channel, invoke } from "@tauri-apps/api/core";

export type ProviderKind = "anthropic" | "openai" | "gemini" | "ollama" | "compatible";

export interface AiConfig {
  /** "off" until the user picks a provider. */
  kind: ProviderKind | "off";
  model: string;
  /** For "ollama" (optional) and "compatible" (required). */
  baseUrl: string;
  /** Grey suggestions at the cursor as you type. */
  inline: boolean;
}

export const PROVIDERS: { id: ProviderKind; name: string; needsKey: boolean; needsUrl: boolean; model: string; models: string[]; keyUrl?: string }[] = [
  { id: "anthropic", name: "Anthropic (Claude)", needsKey: true, needsUrl: false, model: "claude-opus-5-5", models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5", "claude-fable-5-1"], keyUrl: "https://platform.claude.com/settings/keys" },
  { id: "openai", name: "OpenAI", needsKey: true, needsUrl: false, model: "", models: [], keyUrl: "https://platform.openai.com/api-keys" },
  { id: "gemini", name: "Google Gemini", needsKey: true, needsUrl: false, model: "", models: [], keyUrl: "https://aistudio.google.com/apikey" },
  { id: "ollama", name: "Ollama (on this computer)", needsKey: false, needsUrl: false, model: "", models: [] },
  { id: "compatible", name: "Other (OpenAI-compatible)", needsKey: false, needsUrl: true, model: "", models: [] },
];

const KEY = "scribe.ai";
export let aiConfig: AiConfig = load();

function load(): AiConfig {
  const fallback: AiConfig = { kind: "off", model: "", baseUrl: "", inline: false };
  try {
    return { ...fallback, ...JSON.parse(localStorage.getItem(KEY) ?? "{}") };
  } catch {
    return fallback;
  }
}

export function saveAiConfig(change: Partial<AiConfig>) {
  aiConfig = { ...aiConfig, ...change };
  try {
    localStorage.setItem(KEY, JSON.stringify(aiConfig));
  } catch { /* no storage */ }
  for (const fn of aiListeners) fn();
}

/** Run when the AI settings change (the panels and the editor follow). */
export const aiListeners: (() => void)[] = [];

export const aiReady = () => aiConfig.kind !== "off" && !!aiConfig.model.trim();

const provider = () => ({ kind: aiConfig.kind, baseUrl: aiConfig.baseUrl || null, model: aiConfig.model.trim() });

export interface ChatMessage { role: "user" | "assistant"; content: string }

export interface AiRequest {
  system: string;
  messages: ChatMessage[];
  maxTokens?: number;
  /** "low" for quick suggestions. */
  speed?: "low" | "medium" | "high";
  stop?: string[];
}

type AiEvent = { type: "delta"; text: string } | { type: "done"; reason: string | null } | { type: "error"; message: string };

let nextId = 1;

/** Send a request; `onText` gets the reply as it grows. Resolves with the whole reply. An aborted
 *  signal stops the model and resolves with what came so far. */
export function aiStream(request: AiRequest, onText?: (text: string) => void, signal?: AbortSignal): Promise<{ text: string; reason: string | null }> {
  if (!aiReady()) return Promise.reject(new Error("Choose an AI provider and model in Settings > AI first."));
  const id = nextId++;
  let text = "";
  return new Promise((resolve, reject) => {
    const channel = new Channel<AiEvent>();
    channel.onmessage = (event) => {
      if (event.type === "delta") {
        text += event.text;
        onText?.(text);
      } else if (event.type === "done") {
        if (event.reason === "refusal") reject(new Error("The model declined this request."));
        else resolve({ text, reason: event.reason });
      } else {
        reject(new Error(event.message));
      }
    };
    signal?.addEventListener("abort", () => {
      invoke("ai_cancel", { id }).catch(() => {});
      resolve({ text, reason: "cancelled" });
    }, { once: true });
    invoke("ai_stream", {
      request: { id, provider: provider(), system: request.system, messages: request.messages, maxTokens: request.maxTokens ?? null, speed: request.speed ?? null, stop: request.stop ?? null },
      onEvent: channel,
    }).catch((e) => reject(new Error(String(e))));
  });
}

export const hasKey = (kind: ProviderKind) => invoke<boolean>("ai_has_key", { kind });
export const setKey = (kind: ProviderKind, key: string) => invoke("ai_set_key", { kind, key });
export const listModels = () => invoke<string[]>("ai_models", { provider: provider() });

/** The text of a ```fenced``` reply, or the reply itself; models add fences even when asked not to. */
export function unfence(reply: string): string {
  const m = /^\s*```[\w-]*\n([\s\S]*?)\n?```\s*$/.exec(reply);
  return m ? m[1] : reply.trim();
}
