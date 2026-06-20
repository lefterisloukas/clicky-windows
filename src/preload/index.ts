import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("clicky", {
  // Hotkey events
  onRecordingChanged: (callback: (isRecording: boolean) => void) => {
    ipcRenderer.on("hotkey:recording-changed", (_event, isRecording) => {
      callback(isRecording);
    });
  },

  // Recording aborted via Escape — discard audio, don't transcribe.
  onRecordingCancelled: (callback: () => void) => {
    ipcRenderer.on("hotkey:recording-cancelled", () => {
      callback();
    });
  },

  // Overlay pointing — streamed one point at a time. `kind:"raw"` shows the
  // model's first estimate; `kind:"refine"` updates the same id in place;
  // `kind:"reset"` clears the overlay at the start of a new query.
  onPoint: (
    callback: (point: {
      id?: string;
      x?: number;
      y?: number;
      label?: string;
      kind: "raw" | "refine" | "reset";
    }) => void
  ) => {
    ipcRenderer.on("overlay:point", (_event, point) => {
      callback(point);
    });
  },

  // TTS audio playback
  onTTSPlay: (callback: (audioData: ArrayBuffer) => void) => {
    ipcRenderer.on("tts:play", (_event, data) => {
      callback(data);
    });
  },

  // Voice transcript from push-to-talk
  onVoiceTranscript: (callback: (transcript: string) => void) => {
    ipcRenderer.on("voice:transcript", (_event, transcript) => {
      callback(transcript);
    });
  },

  // Cursor buddy
  onCursorBuddy: (callback: (x: number, y: number) => void) => {
    ipcRenderer.on("overlay:cursor-buddy", (_event, x, y) => {
      callback(x, y);
    });
  },

  onCursorBuddyVisible: (callback: (visible: boolean) => void) => {
    ipcRenderer.on("overlay:cursor-buddy-visible", (_event, visible) => {
      callback(visible);
    });
  },

  // Companion anchor — cursor position for the listening/thinking capsule.
  // Always streamed (independent of the glow-dot setting).
  onCompanionAnchor: (
    callback: (data: { active: boolean; x: number; y: number }) => void
  ) => {
    ipcRenderer.on("overlay:companion-anchor", (_event, data) => {
      callback(data);
    });
  },

  // Processing stage updates from companion pipeline
  onStage: (callback: (data: { stage: string; label: string }) => void) => {
    ipcRenderer.on("companion:stage", (_event, data) => {
      callback(data);
    });
  },

  // Streaming chat response: start (open bubble) → delta (append text) → end
  // (final full text for markdown render). `error` is set on the end event if
  // the query failed.
  onStreamStart: (callback: () => void) => {
    ipcRenderer.on("chat:stream-start", () => callback());
  },
  onStreamDelta: (callback: (data: { text: string }) => void) => {
    ipcRenderer.on("chat:stream-delta", (_event, data) => callback(data));
  },
  onStreamEnd: (
    callback: (data: { text: string; error?: string }) => void
  ) => {
    ipcRenderer.on("chat:stream-end", (_event, data) => callback(data));
  },

  // Fires when TTS playback for a query has fully drained — lets the overlay
  // response caption linger exactly as long as the voice, not the text reveal.
  onSpeakingEnded: (callback: () => void) => {
    ipcRenderer.on("companion:speaking-ended", () => callback());
  },

  // Settings
  getSettings: () => ipcRenderer.invoke("settings:getAll"),
  setSetting: (key: string, value: unknown) =>
    ipcRenderer.invoke("settings:set", key, value),

  // Groq: verify API key + refresh the cached Whisper model list
  testGroqKey: (
    apiKey: string,
    baseUrl?: string
  ): Promise<{ ok: boolean; error?: string; models?: string[] }> =>
    ipcRenderer.invoke("settings:testGroqKey", apiKey, baseUrl),
  refreshGroqModelList: (
    apiKey: string,
    baseUrl?: string
  ): Promise<{ ok: boolean; error?: string; models?: string[] }> =>
    ipcRenderer.invoke("settings:refreshGroqModelList", apiKey, baseUrl),

  // Gemini: verify API key + refresh the cached chat model list
  testGeminiKey: (
    apiKey: string,
    baseUrl?: string
  ): Promise<{ ok: boolean; error?: string; models?: string[] }> =>
    ipcRenderer.invoke("settings:testGeminiKey", apiKey, baseUrl),

  // Chat — send a text query (captures screen + sends to Claude)
  sendQuery: (text: string): Promise<string> =>
    ipcRenderer.invoke("chat:query", text),

  // Audio — send complete recording for transcription + AI query
  sendAudioRecording: (audioData: ArrayBuffer): Promise<{ transcript?: string; response?: string; error?: string }> =>
    ipcRenderer.invoke("audio:recording-complete", audioData),

  // Open URL in default browser
  openExternal: (url: string) => {
    ipcRenderer.invoke("shell:openExternal", url);
  },

  // Window controls
  minimizeWindow: () => ipcRenderer.invoke("window:minimize"),
  closeWindow: () => ipcRenderer.invoke("window:close"),

  // Open the settings popover (the single config surface)
  openSettings: () => ipcRenderer.invoke("window:openSettings"),

  // Open the chat window (from the popover's "Open chat" link)
  openChat: () => ipcRenderer.invoke("window:openChat"),

  // Hide the popover back to the tray (popover close button)
  hidePopover: () => ipcRenderer.invoke("window:hidePopover"),
});
