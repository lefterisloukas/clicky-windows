import { GoogleGenAI } from "@google/genai";
import { SettingsStore } from "../main/settings";
import { ScreenshotResult } from "../main/screenshot";
import { SYSTEM_PROMPT } from "./prompt";

interface ChatQueryParams {
  transcript: string;
  screenshots: ScreenshotResult[];
  cursorPosition: { x: number; y: number };
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>;
  /** Called with each text fragment as it streams in. Enables streaming. */
  onDelta?: (chunk: string) => void;
  /**
   * Abort an in-flight request. The @google/genai SDK takes no AbortSignal, so
   * streaming aborts cooperatively (checked between chunks); a cancelled query
   * keeps consuming until the next chunk arrives.
   */
  signal?: AbortSignal;
}

interface ChatResponse {
  text: string;
}

/**
 * Map the simple reasoning dropdown to Gemini's thinking config. Gemini 3
 * models use a discrete `thinkingLevel`; the 2.5 series uses a numeric
 * `thinkingBudget`. "default" omits the config entirely (model default).
 */
function buildThinkingConfig(
  model: string,
  reasoning: string
): Record<string, unknown> | undefined {
  if (!reasoning || reasoning === "default") return undefined;

  if (/gemini-3/.test(model)) {
    const level =
      reasoning === "off"
        ? "MINIMAL"
        : reasoning === "low"
        ? "LOW"
        : reasoning === "medium"
        ? "MEDIUM"
        : "HIGH";
    return { thinkingLevel: level };
  }

  const budget =
    reasoning === "off"
      ? 0
      : reasoning === "low"
      ? 1024
      : reasoning === "medium"
      ? 8192
      : 24576;
  return { thinkingBudget: budget };
}

/**
 * Google Gemini chat service via the @google/genai SDK. Mirrors the other
 * AIProvider implementations (claude.ts / openrouter-chat.ts): one query()
 * call with screenshots as inline image parts. No second-pass refinement
 * (that is Claude-only).
 */
export class GeminiChatService {
  private settings: SettingsStore;

  constructor(settings: SettingsStore) {
    this.settings = settings;
  }

  async query(params: ChatQueryParams): Promise<ChatResponse> {
    const apiKey = this.settings.get("geminiApiKey");
    const model = this.settings.get("geminiModel");
    const baseUrl = (this.settings.get("geminiBaseUrl") || "").trim();
    const reasoning = this.settings.get("geminiReasoning");
    const temperature = Number(this.settings.get("geminiTemperature"));

    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: baseUrl ? { baseUrl } : undefined,
    });

    // Build the latest user turn. Interleave a label text part before each
    // image so the model binds each screenshot to its screenN index directly
    // (image order alone is unreliable when monitors share a resolution).
    const userParts: Array<Record<string, unknown>> = [];
    userParts.push({
      text: [
        `User says: "${params.transcript}"`,
        `Cursor position: (${params.cursorPosition.x}, ${params.cursorPosition.y})`,
        `You are given ${params.screenshots.length} screen image(s) below, each preceded by its screenN label. Use IMAGE pixel coordinates.`,
      ].join("\n"),
    });
    params.screenshots.forEach((s, i) => {
      userParts.push({
        text:
          `=== screen${i} === image is ${s.imageDimensions.width}x${s.imageDimensions.height} px ` +
          `(physical display ${s.bounds.width}x${s.bounds.height} at ${s.bounds.x},${s.bounds.y}). ` +
          `The next image IS screen${i}; any element in it MUST use screen${i}.`,
      });
      userParts.push({
        inlineData: { mimeType: "image/jpeg", data: s.data },
      });
    });

    // Map conversation history to Gemini contents (assistant -> "model"). The
    // latest user message carries the screenshots; earlier turns are text.
    const contents = params.conversationHistory.map((entry) => {
      if (entry.role === "user" && entry.content === params.transcript) {
        return { role: "user", parts: userParts };
      }
      return {
        role: entry.role === "assistant" ? "model" : "user",
        parts: [{ text: entry.content }],
      };
    });

    const config: Record<string, unknown> = {
      systemInstruction: SYSTEM_PROMPT,
      maxOutputTokens: 4096,
    };
    if (!Number.isNaN(temperature)) {
      config.temperature = temperature;
    }
    const thinkingConfig = buildThinkingConfig(model, reasoning);
    if (thinkingConfig) {
      config.thinkingConfig = thinkingConfig;
    }

    // Non-streaming path: single request, full response.
    if (!params.onDelta) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents,
          config,
        });
        return { text: response.text ?? "" };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Gemini API error: ${msg}`);
      }
    }

    // Streaming path: iterate the SDK's async stream, accumulating chunk text.
    let full = "";
    try {
      const stream = await ai.models.generateContentStream({
        model,
        contents,
        config,
      });
      for await (const chunk of stream) {
        if (params.signal?.aborted) break;
        const piece = chunk.text ?? "";
        if (piece) {
          full += piece;
          params.onDelta(piece);
        }
      }
    } catch (err: unknown) {
      if (full) return { text: full };
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Gemini API error: ${msg}`);
    }

    return { text: full };
  }
}
