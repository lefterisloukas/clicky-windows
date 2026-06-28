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

/**
 * Custom (OpenAI-compatible) chat service.
 *
 * A generic client for any endpoint that speaks the OpenAI Chat Completions
 * API — self-hosted gateways (vLLM, LiteLLM, Ollama's OpenAI shim), other
 * vendors' compatible endpoints, etc. The user supplies the base URL, model
 * id, optional API key, and optional reasoning effort.
 *
 * Unlike the curated providers, we can't know whether the chosen model is
 * vision-capable or accepts `reasoning_effort`, so we send what the user asked
 * for and surface the endpoint's error verbatim if it rejects the request.
 * Second-pass POINT refinement is Claude-only (see companion.ts), so points
 * here are shown as the model's raw estimates.
 */
export class CustomChatService {
  private settings: SettingsStore;

  constructor(settings: SettingsStore) {
    this.settings = settings;
  }

  async query(params: ChatQueryParams): Promise<ChatResponse> {
    const apiKey = this.settings.get("customApiKey");
    const model = this.settings.get("customModel");
    const reasoning = this.settings.get("customReasoning");
    const base = (this.settings.get("customBaseUrl") || "").replace(/\/+$/, "");

    if (!base) {
      throw new Error("Custom provider: set a base URL in settings first.");
    }
    if (!model) {
      throw new Error("Custom provider: set a model name in settings first.");
    }

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

    // The endpoint is user-supplied, so we can't gate `reasoning_effort` on a
    // model-capability table the way the curated providers do. Send it whenever
    // the user opted in (not "off") and trust them to pick a model that accepts
    // it; if it doesn't, the endpoint's error surfaces verbatim below.
    if (reasoning && reasoning !== "off") {
      body.reasoning_effort = reasoning;
    }

    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: params.signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Custom provider error (${response.status}): ${error}`);
    }

    // Non-streaming path: read `content` only. Some reasoning models put their
    // chain of thought in a separate `reasoning_content` field — we ignore it
    // so it never reaches POINT-tag parsing or TTS.
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
