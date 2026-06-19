import { SettingsStore } from "../main/settings";
import { ScreenshotResult } from "../main/screenshot";
import { SYSTEM_PROMPT } from "./prompt";

interface ChatQueryParams {
  transcript: string;
  screenshots: ScreenshotResult[];
  cursorPosition: { x: number; y: number };
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>;
}

interface ChatResponse {
  text: string;
}

export class OpenAIChatService {
  private settings: SettingsStore;

  constructor(settings: SettingsStore) {
    this.settings = settings;
  }

  async query(params: ChatQueryParams): Promise<ChatResponse> {
    const apiKey = this.settings.get("openaiApiKey");
    const model = this.settings.get("openaiModel");
    const reasoning = this.settings.get("openaiReasoning");

    // Build user message content. Interleave a label text block before each
    // image so the model binds each screenshot to its screenN index directly
    // (image order alone is unreliable when monitors share a resolution).
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
          detail: "high",
        },
      });
    });

    // Build messages array
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

    const body: Record<string, unknown> = {
      model,
      max_completion_tokens: 1024,
      messages,
    };

    // Reasoning effort applies only to reasoning-capable models (o-series,
    // gpt-5.x). Sending it to a chat model like gpt-4o triggers a 400, so gate
    // on the model name and only attach when the user opted in (not "off").
    if (reasoning && reasoning !== "off" && /^(o\d|gpt-5)/.test(model)) {
      body.reasoning_effort = reasoning;
    }

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${error}`);
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
    };

    const text = data.choices[0]?.message?.content || "";
    return { text };
  }
}
