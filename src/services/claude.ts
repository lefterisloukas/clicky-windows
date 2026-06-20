import { SettingsStore } from "../main/settings";
import { ScreenshotResult } from "../main/screenshot";
import { SYSTEM_PROMPT } from "./prompt";
import { readSSE } from "./streaming";

interface ClaudeQueryParams {
  transcript: string;
  screenshots: ScreenshotResult[];
  cursorPosition: { x: number; y: number };
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>;
  /** Called with each text fragment as it streams in. Enables streaming. */
  onDelta?: (chunk: string) => void;
  /** Abort an in-flight request (e.g. a newer query superseded this one). */
  signal?: AbortSignal;
}

interface ClaudeResponse {
  text: string;
}

export class ClaudeService {
  private settings: SettingsStore;

  constructor(settings: SettingsStore) {
    this.settings = settings;
  }

  async query(params: ClaudeQueryParams): Promise<ClaudeResponse> {
    const apiKey = this.settings.get("anthropicApiKey");
    const useProxy = this.settings.get("useProxy");
    const proxyUrl = this.settings.get("proxyUrl");
    const model = this.settings.get("claudeModel");

    const baseUrl = useProxy && proxyUrl
      ? proxyUrl
      : "https://api.anthropic.com";

    // Build message content. CRITICAL for multi-monitor accuracy: label each
    // image with a text block IMMEDIATELY BEFORE it, rather than dumping all
    // images then one text block. When two monitors downsample to the same
    // dimensions (e.g. 1568x882), the model otherwise has to guess which image
    // is screen0 vs screen1 from block order alone — and it guesses wrong,
    // emitting the right coords on the wrong screenN. Interleaved labels let
    // the model bind each image to its index directly.
    const userContent: Array<Record<string, unknown>> = [];

    // Leading context: the question, cursor, and how many screens follow.
    userContent.push({
      type: "text",
      text: [
        `User says: "${params.transcript}"`,
        `Cursor position: (${params.cursorPosition.x}, ${params.cursorPosition.y})`,
        `You are given ${params.screenshots.length} screen image(s) below, each preceded by its screenN label.`,
        `Give POINT coordinates in IMAGE pixels — use the per-image dimensions stated in each label, NOT the actual screen resolution.`,
      ].join("\n"),
    });

    // Interleave: label text block, then its image.
    params.screenshots.forEach((s, i) => {
      userContent.push({
        type: "text",
        text:
          `=== screen${i} === image is ${s.imageDimensions.width}x${s.imageDimensions.height} px ` +
          `(physical display ${s.bounds.width}x${s.bounds.height} at ${s.bounds.x},${s.bounds.y}). ` +
          `The next image IS screen${i}. Any element you locate in it MUST use screen${i} in its POINT tag.`,
      });
      userContent.push({
        type: "image",
        source: {
          type: "base64",
          media_type: "image/jpeg",
          data: s.data,
        },
      });
    });

    // Build messages array from conversation history
    const messages = params.conversationHistory.map((entry) => ({
      role: entry.role,
      content: entry.role === "user" && entry.content === params.transcript
        ? userContent  // Latest user message gets the screenshots
        : entry.content,
    }));

    const stream = !!params.onDelta;

    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages,
        ...(stream ? { stream: true } : {}),
      }),
      signal: params.signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Claude API error (${response.status}): ${error}`);
    }

    // Non-streaming path: parse the full JSON body as before.
    if (!stream) {
      const data = (await response.json()) as {
        content: Array<{ type: string; text?: string }>;
      };
      const text = data.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      return { text };
    }

    // Streaming path: accumulate `content_block_delta` text_delta events.
    let full = "";
    try {
      await readSSE(response, (ev) => {
        const e = ev as {
          type?: string;
          delta?: { type?: string; text?: string };
          error?: { message?: string };
        };
        if (e.type === "content_block_delta" && e.delta?.type === "text_delta") {
          const piece = e.delta.text || "";
          if (piece) {
            full += piece;
            params.onDelta!(piece);
          }
        } else if (e.type === "error") {
          throw new Error(e.error?.message || "Claude stream error");
        }
      });
    } catch (err) {
      // If we got partial text before the failure, return it rather than losing
      // everything; otherwise surface the error.
      if (full) return { text: full };
      throw err;
    }

    return { text: full };
  }

  /**
   * Second-pass pointing refinement. Given a cropped patch of the original
   * screenshot and a label, ask Claude to return the exact pixel center of
   * the element within that crop. Returns null if Claude can't find it.
   */
  async refinePoint(
    cropBase64: string,
    cropWidth: number,
    cropHeight: number,
    label: string
  ): Promise<{ x: number; y: number } | null> {
    const apiKey = this.settings.get("anthropicApiKey");
    const useProxy = this.settings.get("useProxy");
    const proxyUrl = this.settings.get("proxyUrl");
    const model = this.settings.get("claudeModel");
    const baseUrl = useProxy && proxyUrl ? proxyUrl : "https://api.anthropic.com";

    const system =
      `You are a precise UI pointing tool. You receive a zoomed crop of a screenshot and a description of a UI element. ` +
      `Return ONLY "x,y" — integer pixel coordinates of the exact visual center of the element matching the description. ` +
      `CRITICAL: the crop may contain visually similar neighboring elements (e.g. a Like button next to a Dislike button, ` +
      `or several tabs side by side). Return the EXACT element described, NOT an adjacent look-alike. ` +
      `Aim for the center of the element's icon or main hit target. ` +
      `If the element is not visible in the crop, return "none". No other text, no prose, no units.`;

    const userContent = [
      {
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: cropBase64 },
      },
      {
        type: "text",
        text:
          `Crop image size: ${cropWidth}x${cropHeight} pixels (origin 0,0 = top-left).\n` +
          `Target element: "${label}"\n` +
          `Return the pixel center as "x,y" only.`,
      },
    ];

    try {
      const response = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 32,
          system,
          messages: [{ role: "user", content: userContent }],
        }),
      });

      if (!response.ok) return null;

      const data = (await response.json()) as {
        content: Array<{ type: string; text?: string }>;
      };
      const text = data.content
        .filter((b) => b.type === "text")
        .map((b) => b.text || "")
        .join("")
        .trim();

      const match = text.match(/(\d+)\s*,\s*(\d+)/);
      if (!match) return null;
      return { x: parseInt(match[1], 10), y: parseInt(match[2], 10) };
    } catch {
      return null;
    }
  }
}
