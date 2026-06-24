import { SettingsStore } from "../main/settings";
import { ScreenshotResult } from "../main/screenshot";
import { SYSTEM_PROMPT } from "./prompt";
import { readSSE } from "./streaming";

interface ChatQueryParams {
  transcript: string;
  screenshots: ScreenshotResult[];
  cursorPosition: { x: number; y: number };
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>;
  /** Called with each text fragment as it streams in. Enables streaming. */
  onDelta?: (chunk: string) => void;
  /** Abort an in-flight request (e.g. a newer query superseded this one). */
  signal?: AbortSignal;
}

interface ChatResponse {
  text: string;
}

export const OPENCODE_GO_DEFAULT_BASE_URL = "https://opencode.ai/zen/go/v1";
/** A verified vision-capable model — sensible default for a screen companion. */
export const OPENCODE_GO_DEFAULT_MODEL = "qwen3.7-plus";

/**
 * Per-model capability snapshot for OpenCode Go.
 *
 * `vision` is GROUND TRUTH: each `vision: true` model was probed against the
 * LIVE Go endpoint with a synthetic image and confirmed to actually read it;
 * the text-only ones were confirmed NOT to (deepseek-v4-pro hard-400s on image
 * content, glm-5.2 returns empty). This matters because OpenCode Go runs its
 * own deployment and a model's upstream capabilities are not a guarantee that
 * Go serves them. Re-verify with scripts/probing if the lineup changes.
 *
 * `reasoning` mirrors models.dev's `reasoning_options` for the request-time
 * effort knob: "effort" → send `reasoning_effort` (one of `effortValues`),
 * "toggle" → on/off only (no standard OpenAI param, left at model default),
 * "none" → no effort control. NOTE: every Go model reasons by default and
 * dumps its thinking into a separate `reasoning_content` field; today none of
 * the *vision* models expose an effort scale, so the reasoning dropdown is
 * effectively inert for them (kept for correctness + future models).
 *
 * The settings renderer keeps a small display-only copy of the vision sets
 * (see OPENCODE_GO_VISION / OPENCODE_GO_TEXT in renderer/settings/index.html) —
 * keep the two in sync.
 */
export interface OpenCodeGoCap {
  vision: boolean;
  reasoning: "none" | "toggle" | "effort";
  effortValues?: string[];
}

export const OPENCODE_GO_CAPS: Record<string, OpenCodeGoCap> = {
  // --- vision-capable (verified live) ---
  "kimi-k2.7-code": { vision: true, reasoning: "none" },
  "kimi-k2.6": { vision: true, reasoning: "none" },
  "kimi-k2.5": { vision: true, reasoning: "none" },
  "qwen3.7-plus": { vision: true, reasoning: "none" },
  "qwen3.6-plus": { vision: true, reasoning: "none" },
  "qwen3.5-plus": { vision: true, reasoning: "none" },
  "minimax-m3": { vision: true, reasoning: "toggle" },
  "mimo-v2.5": { vision: true, reasoning: "none" },
  "mimo-v2-omni": { vision: true, reasoning: "none" },
  // --- text-only (no vision on Go) ---
  "glm-5.2": { vision: false, reasoning: "none" },
  "glm-5.1": { vision: false, reasoning: "none" },
  "glm-5": { vision: false, reasoning: "none" },
  "qwen3.7-max": { vision: false, reasoning: "none" },
  "minimax-m2.7": { vision: false, reasoning: "none" },
  "minimax-m2.5": { vision: false, reasoning: "none" },
  "mimo-v2.5-pro": { vision: false, reasoning: "none" },
  "mimo-v2-pro": { vision: false, reasoning: "none" },
  "deepseek-v4-pro": { vision: false, reasoning: "effort", effortValues: ["high", "max"] },
  "deepseek-v4-flash": { vision: false, reasoning: "effort", effortValues: ["high", "max"] },
};

export type OpenCodeGoVision = "vision" | "text" | "unknown";

/** Vision verdict for a model id; "unknown" for ids not in the snapshot. */
export function opencodeGoVision(modelId: string): OpenCodeGoVision {
  const cap = OPENCODE_GO_CAPS[modelId];
  if (!cap) return "unknown";
  return cap.vision ? "vision" : "text";
}

/**
 * OpenCode Go chat service — an OpenAI-compatible gateway
 * (https://opencode.ai/zen/go/v1) fronting a curated set of open coding models.
 *
 * Most Go models are TEXT-ONLY; only the `vision: true` models in
 * OPENCODE_GO_CAPS can see screenshots and emit POINT tags. The settings UI
 * badges this so users don't pick a blind model.
 */
export class OpenCodeGoChatService {
  private settings: SettingsStore;

  constructor(settings: SettingsStore) {
    this.settings = settings;
  }

  async query(params: ChatQueryParams): Promise<ChatResponse> {
    const apiKey = this.settings.get("opencodeGoApiKey");
    const model = this.settings.get("opencodeGoModel");
    const reasoning = this.settings.get("opencodeGoReasoning");
    const base = (
      this.settings.get("opencodeGoBaseUrl") || OPENCODE_GO_DEFAULT_BASE_URL
    ).replace(/\/+$/, "");

    // Build user message content with images (OpenAI vision format).
    // Interleave a label text block before each image so the model binds each
    // screenshot to its screenN index directly (image order alone is
    // unreliable when monitors share a resolution).
    const userContent: Array<Record<string, unknown>> = [];

    userContent.push({
      type: "text",
      text: [
        `User says: "${params.transcript}"`,
        `Cursor position: (${params.cursorPosition.x}, ${params.cursorPosition.y})`,
        `You are given ${params.screenshots.length} screen image(s) below, each preceded by its screenN label. Use IMAGE pixel coordinates.`,
      ].join("\n"),
    });

    params.screenshots.forEach((s, i) => {
      userContent.push({
        type: "text",
        text:
          `=== screen${i} === image is ${s.imageDimensions.width}x${s.imageDimensions.height} px ` +
          `(physical display ${s.bounds.width}x${s.bounds.height} at ${s.bounds.x},${s.bounds.y}). ` +
          `The next image IS screen${i}; any element in it MUST use screen${i}.`,
      });
      userContent.push({
        type: "image_url",
        image_url: {
          url: `data:image/jpeg;base64,${s.data}`,
        },
      });
    });

    const messages: Array<Record<string, unknown>> = [
      { role: "system", content: SYSTEM_PROMPT },
    ];

    for (const entry of params.conversationHistory) {
      if (entry.role === "user" && entry.content === params.transcript) {
        messages.push({ role: "user", content: userContent });
      } else {
        messages.push({ role: entry.role, content: entry.content });
      }
    }

    const stream = !!params.onDelta;

    const body: Record<string, unknown> = {
      model,
      max_tokens: 4096,
      messages,
    };
    if (stream) body.stream = true;

    // Reasoning effort applies only to models that advertise an effort scale.
    // Go models reason by default; only some text models expose `reasoning_effort`
    // (with model-specific values, e.g. deepseek = high/max). Gate on the
    // capability snapshot and clamp to a value the model accepts, so we never
    // send an effort string the gateway will reject with a 400. "toggle"/"none"
    // models get no param (left at their default behaviour).
    const cap = OPENCODE_GO_CAPS[model];
    if (reasoning && reasoning !== "off" && cap?.reasoning === "effort") {
      const values = cap.effortValues || [];
      const chosen = values.includes(reasoning)
        ? reasoning
        : values[values.length - 1];
      if (chosen) body.reasoning_effort = chosen;
    }

    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: params.signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenCode Go API error (${response.status}): ${error}`);
    }

    // Non-streaming path: read `content` only. These models put their chain of
    // thought in a separate `reasoning_content` field — we deliberately ignore
    // it so it never reaches POINT-tag parsing or TTS.
    if (!stream) {
      const data = (await response.json()) as {
        choices: Array<{ message: { content: string | null } }>;
      };
      return { text: data.choices[0]?.message?.content || "" };
    }

    // Streaming path: accumulate `choices[0].delta.content` ONLY (never
    // `delta.reasoning_content`).
    let full = "";
    try {
      await readSSE(response, (ev) => {
        const piece = (
          ev as { choices?: Array<{ delta?: { content?: string } }> }
        ).choices?.[0]?.delta?.content;
        if (piece) {
          full += piece;
          params.onDelta!(piece);
        }
      });
    } catch (err) {
      if (full) return { text: full };
      throw err;
    }

    return { text: full };
  }
}
