import { BrowserWindow } from "electron";
import { ScreenCapture, ScreenshotResult, cropScreenshotRegion } from "./screenshot";
import { SettingsStore } from "./settings";
import { ClaudeService } from "../services/claude";
import { OpenAIChatService } from "../services/openai-chat";
import { OpenRouterChatService } from "../services/openrouter-chat";
import { GeminiChatService } from "../services/gemini-chat";
import {
  TranscriptionProvider,
  createTranscriptionProvider,
} from "../services/transcription/interface";
import { createTTSProvider } from "../services/tts/interface";

interface ConversationEntry {
  role: "user" | "assistant";
  content: string;
}

interface AIProvider {
  query(params: {
    transcript: string;
    screenshots: ScreenshotResult[];
    cursorPosition: { x: number; y: number };
    conversationHistory: ConversationEntry[];
  }): Promise<{ text: string }>;
}

const MAX_CONVERSATION_HISTORY = 10;

/**
 * Central orchestrator — mirrors CompanionManager.swift from macOS version.
 *
 * Flow: voice → screenshot → ai (anthropic or openai) → tts → overlay pointing
 */
export class CompanionManager {
  private settings: SettingsStore;
  private screenCapture: ScreenCapture;
  private transcription: TranscriptionProvider;
  private conversationHistory: ConversationEntry[] = [];
  private overlayWindows: BrowserWindow[] = [];

  constructor(settings: SettingsStore, overlayWindows: BrowserWindow[]) {
    this.settings = settings;
    this.screenCapture = new ScreenCapture();
    this.transcription = createTranscriptionProvider(settings);
    this.overlayWindows = overlayWindows;
  }

  private getAIProvider(): AIProvider {
    const provider = this.settings.get("aiProvider");
    if (provider === "openai") {
      return new OpenAIChatService(this.settings);
    }
    if (provider === "openrouter") {
      return new OpenRouterChatService(this.settings);
    }
    if (provider === "gemini") {
      return new GeminiChatService(this.settings);
    }
    return new ClaudeService(this.settings);
  }

  private broadcastStage(stage: string, label: string): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send("companion:stage", { stage, label });
      }
    }
  }

  /**
   * Process a user query: capture screen, send to AI, speak response.
   */
  async processQuery(transcript: string): Promise<string> {
    try {
    // 1. Capture screenshots
    this.broadcastStage("capturing", "Reading screen...");
    const screenshots = await this.screenCapture.captureAllScreens();
    const cursorPos = this.screenCapture.getCursorPosition();

    // 2. Send to AI provider with conversation history
    this.conversationHistory.push({ role: "user", content: transcript });

    this.broadcastStage("querying", "Analyzing...");
    const ai = this.getAIProvider();
    const response = await ai.query({
      transcript,
      screenshots,
      cursorPosition: cursorPos,
      conversationHistory: this.conversationHistory,
    });

    this.conversationHistory.push({ role: "assistant", content: response.text });

    // Trim history
    if (this.conversationHistory.length > MAX_CONVERSATION_HISTORY * 2) {
      this.conversationHistory = this.conversationHistory.slice(-MAX_CONVERSATION_HISTORY * 2);
    }

    // 3a. Parse raw POINT tags (still in image-pixel space).
    const rawTags = this.parseRawPointTags(response.text);
    console.log("[Clicky] Claude response:", response.text);
    console.log("[Clicky] Raw POINT tags:", JSON.stringify(rawTags));

    // 3b. Second-pass refinement: only Claude for now.
    //     For each tag, crop ~400px around the estimated point and ask the
    //     model to return the precise pixel center. Falls back to the raw
    //     tag if anything goes wrong.
    const aiProviderName = this.settings.get("aiProvider");
    let refinedTags = rawTags;
    if (aiProviderName === "anthropic" && rawTags.length > 0) {
      this.broadcastStage("refining", "Refining points...");
      const claude = new ClaudeService(this.settings);
      refinedTags = await Promise.all(
        rawTags.map(async (tag) => {
          const shot = screenshots[tag.screen] || screenshots[0];
          if (!shot) return tag;
          try {
            // 300 imageDim px — small enough to reduce ambiguity with
            // neighboring similar elements (e.g. like/dislike), large enough
            // to give context. At native DPI this is a much sharper patch
            // than cropping the downsampled pass-1 image.
            const crop = cropScreenshotRegion(shot, tag.x, tag.y, 300);
            const refined = await claude.refinePoint(
              crop.data,
              crop.claudeSize.w,
              crop.claudeSize.h,
              tag.label
            );
            if (refined) {
              // Refined coords live in native crop-pixel space. Map back to
              // imageDimensions (pass-1) space so later scaling to display
              // px works consistently.
              const imgX = crop.origin.x + refined.x / crop.pxPerImageDim;
              const imgY = crop.origin.y + refined.y / crop.pxPerImageDim;
              console.log(
                `[Clicky] Refined "${tag.label}": (${tag.x},${tag.y}) → (${Math.round(imgX)},${Math.round(imgY)})`
              );
              return { ...tag, x: Math.round(imgX), y: Math.round(imgY) };
            }
          } catch (err) {
            console.warn(
              `[Clicky] Refinement failed for "${tag.label}":`,
              err instanceof Error ? err.message : err
            );
          }
          return tag;
        })
      );
    }

    // 3c. Scale image-pixel coords to display-pixel coords for the overlay.
    const pointTags = refinedTags.map((tag) => {
      const shot = screenshots[tag.screen] || screenshots[0];
      if (!shot) return tag;
      // Models routinely overshoot the image bounds by a few px (e.g. a
      // "Next" button near the bottom comes back as y=905 on an 882-tall
      // image). Left unchecked, the overshoot scales up and the cursor flies
      // off the bottom/right edge and is never seen. Clamp to the last valid
      // pixel so an overshoot snaps to the visible edge instead.
      const clampedImgX = Math.max(0, Math.min(shot.imageDimensions.width - 1, tag.x));
      const clampedImgY = Math.max(0, Math.min(shot.imageDimensions.height - 1, tag.y));
      if (clampedImgX !== tag.x || clampedImgY !== tag.y) {
        console.log(
          `[Clicky] Clamped "${tag.label}" (${tag.x},${tag.y}) → (${clampedImgX},${clampedImgY}) ` +
            `to image bounds ${shot.imageDimensions.width}x${shot.imageDimensions.height}`
        );
      }
      const scaleX = shot.bounds.width / shot.imageDimensions.width;
      const scaleY = shot.bounds.height / shot.imageDimensions.height;
      return {
        ...tag,
        x: Math.round(clampedImgX * scaleX),
        y: Math.round(clampedImgY * scaleY),
      };
    });
    console.log("[Clicky] Final POINT tags:", JSON.stringify(pointTags));
    console.log("[Clicky] Overlay windows:", this.overlayWindows.length);
    if (pointTags.length > 0 && this.overlayWindows.length > 0) {
      // Route each tag to the overlay for its target display. Coordinates
      // are already in that display's local CSS space (0..bounds.width).
      //
      // CRITICAL: `tag.screen` is the position of the screenshot in the array
      // the model saw (screen0, screen1, ...). The overlay windows are indexed
      // by `screen.getAllDisplays()` order. Those two indices are identical
      // ONLY when no display was skipped during capture. If a display's capture
      // came back empty it is dropped from `screenshots`, shifting every later
      // array position — so we must map back through the screenshot's true
      // `displayIndex` to pick the right overlay, never `tag.screen` directly.
      const byOverlay = new Map<number, typeof pointTags>();
      for (const tag of pointTags) {
        const shot = screenshots[tag.screen] || screenshots[0];
        const overlayIdx = shot ? shot.displayIndex : tag.screen;
        if (overlayIdx !== tag.screen) {
          console.log(
            `[Clicky] POINT screen${tag.screen} (array pos) → displayIndex ${overlayIdx} (a display was skipped during capture)`
          );
        }
        const list = byOverlay.get(overlayIdx) || [];
        list.push(tag);
        byOverlay.set(overlayIdx, list);
      }
      for (const [overlayIdx, tags] of byOverlay) {
        if (overlayIdx < 0 || overlayIdx >= this.overlayWindows.length) {
          console.warn(
            `[Clicky] POINT target overlay=${overlayIdx} is out of range (have ${this.overlayWindows.length} overlay windows); routing to primary display.`
          );
        }
        const win = this.overlayWindows[overlayIdx] || this.overlayWindows[0];
        if (win && !win.isDestroyed()) {
          console.log(
            `[Clicky] → routing ${tags.length} point(s) to overlay ${overlayIdx} @ ${JSON.stringify(win.getBounds())}`
          );
          win.webContents.send("overlay:point", tags);
        }
      }
    }

    // 4. Speak response (strip POINT tags from spoken text) — non-blocking
    //    Re-read settings each time so chat toggle changes take effect immediately
    const spokenText = response.text.replace(/\[POINT:[^\]]+\]/g, "").trim();
    const ttsOn = this.settings.get("ttsEnabled");
    if (ttsOn && spokenText) {
      this.broadcastStage("speaking", "Speaking...");
      try {
        const tts = createTTSProvider(this.settings);
        tts.speak(spokenText).catch((err) => {
          console.warn("TTS failed (non-fatal):", err.message);
        });
      } catch (err: unknown) {
        console.warn("TTS provider creation failed:", err instanceof Error ? err.message : err);
      }
    }

    return response.text;
    } finally {
      this.broadcastStage("done", "");
    }
  }

  private parseRawPointTags(
    text: string
  ): Array<{ x: number; y: number; label: string; screen: number }> {
    const regex = /\[POINT:(\d+),(\d+):([^:]+):screen(\d+)\]/g;
    const tags: Array<{ x: number; y: number; label: string; screen: number }> = [];
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
      tags.push({
        x: parseInt(match[1], 10),
        y: parseInt(match[2], 10),
        label: match[3],
        screen: parseInt(match[4], 10),
      });
    }

    return tags;
  }

  clearHistory(): void {
    this.conversationHistory = [];
  }
}
