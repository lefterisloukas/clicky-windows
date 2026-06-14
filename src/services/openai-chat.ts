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

export class OpenAIChatService {
  private settings: SettingsStore;

  constructor(settings: SettingsStore) {
    this.settings = settings;
  }

  async query(params: ChatQueryParams): Promise<ChatResponse> {
    const apiKey = this.settings.get("openaiApiKey");
    const model = this.settings.get("openaiModel");

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

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_completion_tokens: 1024,
        messages,
      }),
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
