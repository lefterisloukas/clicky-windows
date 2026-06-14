import { GoogleGenAI } from "@google/genai";
import { SettingsStore } from "../main/settings";
import { ScreenshotResult } from "../main/screenshot";

interface ChatQueryParams {
  transcript: string;
  screenshots: ScreenshotResult[];
  cursorPosition: { x: number; y: number };
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>;
}

interface ChatResponse {
  text: string;
}

const SYSTEM_PROMPT = `You are Clicky, a helpful AI screen companion. You can see the user's screen and hear their voice.

When you want to point at something on the user's screen, embed a coordinate tag in your response like this:
[POINT:x,y:label:screenN]

- x,y are IMAGE pixel coordinates within the screenshot you see — use the image dimensions given for each screen, NOT the actual monitor resolution. The system scales them to real pixels for you.
- label is a short (2-5 word) description.
- screenN is the screen index. Each image is preceded by a "=== screenN ===" label; that label is the index. With multiple monitors, NEVER guess the index from image order or size — read the label directly above the image that contains the element, and match screenN to it. Putting the right coordinates on the wrong screenN points at the wrong monitor.

Be concise and helpful. You're having a real-time conversation — keep responses short and actionable.`;

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
      maxOutputTokens: 1024,
    };
    if (!Number.isNaN(temperature)) {
      config.temperature = temperature;
    }
    const thinkingConfig = buildThinkingConfig(model, reasoning);
    if (thinkingConfig) {
      config.thinkingConfig = thinkingConfig;
    }

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
}
