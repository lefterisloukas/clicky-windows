import { app, BrowserWindow, globalShortcut, ipcMain, screen, shell } from "electron";
import { createTray, getTray } from "./tray";
import { HotkeyManager } from "./hotkey";
import { AudioCapture } from "./audio";
import { SettingsStore } from "./settings";
import { CompanionManager } from "./companion";
import { prewarmKokoro } from "../services/tts/kokoro";
import path from "path";

let chatWindow: BrowserWindow | null = null;
let settingsWindow: BrowserWindow | null = null;
let overlayWindows: BrowserWindow[] = [];

const settings = new SettingsStore();
let companion: CompanionManager;
let cursorBuddyInterval: ReturnType<typeof setInterval> | null = null;

const GROQ_DEFAULT_BASE_URL = "https://api.groq.com/openai/v1";
const GROQ_DEFAULT_STT_MODEL = "whisper-large-v3-turbo";

const GEMINI_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";
const GEMINI_DEFAULT_MODEL = "gemini-3.5-flash";

const OPENCODE_GO_DEFAULT_BASE_URL = "https://opencode.ai/zen/go/v1";

/**
 * Hit OpenCode Go's OpenAI-compatible GET /models endpoint and return the live
 * model ids. The endpoint carries no capability data (id/object/created/owned_by
 * only), so vision/reasoning badging is done in the renderer from the bundled
 * capability snapshot. Mirrors fetchGroqModels.
 */
async function fetchOpenCodeGoModels(
  apiKey: string,
  baseUrl?: string
): Promise<{ ok: boolean; error?: string; models?: string[] }> {
  if (!apiKey) {
    return { ok: false, error: "OpenCode Go API key is empty" };
  }
  if (baseUrl && !baseUrl.startsWith("https://")) {
    return { ok: false, error: "Custom base URL must start with https://" };
  }
  const root = (baseUrl || OPENCODE_GO_DEFAULT_BASE_URL).replace(/\/+$/, "");
  try {
    const response = await fetch(`${root}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) {
      const body = await response.text();
      return {
        ok: false,
        error: `OpenCode Go returned ${response.status}: ${body.slice(0, 200)}`,
      };
    }
    const data = (await response.json()) as { data?: Array<{ id?: string }> };
    const seen = new Set<string>();
    const models: string[] = [];
    for (const m of data.data || []) {
      if (typeof m.id === "string" && !seen.has(m.id)) {
        seen.add(m.id);
        models.push(m.id);
      }
    }
    return { ok: true, models };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Could not reach OpenCode Go: ${msg}` };
  }
}

/**
 * Hit Gemini's REST list-models endpoint and return the models that support
 * generateContent (i.e. usable for chat/vision). Dedupes and pins the default
 * model first. Mirrors fetchGroqModels.
 */
async function fetchGeminiModels(
  apiKey: string,
  baseUrl?: string
): Promise<{ ok: boolean; error?: string; models?: string[] }> {
  if (!apiKey) {
    return { ok: false, error: "Gemini API key is empty" };
  }
  if (baseUrl && !baseUrl.startsWith("https://")) {
    return { ok: false, error: "Custom base URL must start with https://" };
  }
  const root = (baseUrl || GEMINI_DEFAULT_BASE_URL).replace(/\/+$/, "");
  const url = `${root}/v1beta/models?key=${encodeURIComponent(apiKey)}`;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      const body = await response.text();
      return {
        ok: false,
        error: `Gemini API returned ${response.status}: ${body.slice(0, 200)}`,
      };
    }
    const data = (await response.json()) as {
      models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
    };
    const chatModels = (data.models || [])
      .filter((m) =>
        (m.supportedGenerationMethods || []).includes("generateContent")
      )
      .map((m) => (m.name || "").replace(/^models\//, ""))
      .filter((id) => id.includes("gemini"));
    const seen = new Set<string>();
    const ordered: string[] = [];
    ordered.push(GEMINI_DEFAULT_MODEL);
    seen.add(GEMINI_DEFAULT_MODEL);
    for (const id of chatModels) {
      if (!seen.has(id)) {
        ordered.push(id);
        seen.add(id);
      }
    }
    return { ok: true, models: ordered };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Could not reach Gemini: ${msg}` };
  }
}

/**
 * Hit Groq's OpenAI-compatible GET /models endpoint and return the STT
 * (Whisper-family) models. Dedupes and pins whisper-large-v3-turbo first.
 */
async function fetchGroqModels(
  apiKey: string,
  baseUrl?: string
): Promise<{ ok: boolean; error?: string; models?: string[] }> {
  if (!apiKey) {
    return { ok: false, error: "Groq API key is empty" };
  }
  if (baseUrl && !baseUrl.startsWith("https://")) {
    return { ok: false, error: "Custom base URL must start with https://" };
  }
  const url = `${(baseUrl || GROQ_DEFAULT_BASE_URL).replace(/\/+$/, "")}/models`;
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) {
      const body = await response.text();
      return {
        ok: false,
        error: `Groq API returned ${response.status}: ${body.slice(0, 200)}`,
      };
    }
    const data = (await response.json()) as {
      data?: Array<{ id?: string }>;
    };
    const whisperModels = (data.data || [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string" && id.includes("whisper"));
    const seen = new Set<string>();
    const ordered: string[] = [];
    if (!seen.has(GROQ_DEFAULT_STT_MODEL)) {
      ordered.push(GROQ_DEFAULT_STT_MODEL);
      seen.add(GROQ_DEFAULT_STT_MODEL);
    }
    for (const id of whisperModels) {
      if (!seen.has(id)) {
        ordered.push(id);
        seen.add(id);
      }
    }
    return { ok: true, models: ordered };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Could not reach Groq: ${msg}` };
  }
}

// Cursor tracking loop. Runs unconditionally while the app is up so the
// listening/thinking companion can anchor to the cursor even when the glow
// dot ("cursor buddy") is disabled. Two concerns are kept separate:
//   - overlay:companion-anchor — always emitted; drives the capsule position.
//   - overlay:cursor-buddy(-visible) — emitted only when the glow is enabled,
//     so the glow dot behaves exactly as before.
function startCursorBuddy(): void {
  if (cursorBuddyInterval) return;
  cursorBuddyInterval = setInterval(() => {
    if (overlayWindows.length === 0) return;
    const glowEnabled = !!settings.get("cursorBuddyEnabled");
    const point = screen.getCursorScreenPoint();
    // Route to the overlay for the display that contains the cursor; mark
    // every other overlay inactive. Coordinates are translated into that
    // display's local CSS space (matches how POINT tags work).
    const target = screen.getDisplayNearestPoint(point);
    const displays = screen.getAllDisplays();
    const targetIndex = displays.findIndex((d) => d.id === target.id);
    const localX = point.x - target.bounds.x;
    const localY = point.y - target.bounds.y;
    for (let i = 0; i < overlayWindows.length; i++) {
      const win = overlayWindows[i];
      if (!win || win.isDestroyed()) continue;
      const active = i === targetIndex;

      // Capsule anchor — always sent.
      win.webContents.send("overlay:companion-anchor", {
        active,
        x: localX,
        y: localY,
      });

      // Glow dot — gated by the setting.
      if (glowEnabled && active) {
        win.webContents.send("overlay:cursor-buddy", localX, localY);
      } else {
        win.webContents.send("overlay:cursor-buddy-visible", false);
      }
    }
  }, 16);
}

/**
 * Create one transparent click-through overlay window per display. The
 * array index matches `screen.getAllDisplays()` order, which is also the
 * order used by `ScreenCapture.captureAllScreens`, so a POINT tag's
 * `screen` field directly indexes into this array.
 */
function createOverlayWindows(): BrowserWindow[] {
  return screen.getAllDisplays().map((display, i) => createOverlayWindow(display, i));
}

function createOverlayWindow(display: Electron.Display, displayIndex: number): BrowserWindow {
  const { x, y, width, height } = display.bounds;

  const win = new BrowserWindow({
    x,
    y,
    width,
    height,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setIgnoreMouseEvents(true, { forward: true });
  win.setAlwaysOnTop(true, "screen-saver");
  win.loadFile(path.join(__dirname, "..", "..", "src", "renderer", "overlay", "index.html"));

  // Forward overlay renderer console messages to main process so we can see
  // them in PowerShell during dev. Prefixed with the display index for
  // multi-monitor clarity.
  win.webContents.on("console-message", (_event, level, message, line) => {
    console.log(`[overlay${displayIndex}:${level}] ${message} (line ${line})`);
  });

  // Windows clamps a frameless, non-maximized window to the display's WORK
  // AREA at creation time — i.e. it shaves off the taskbar height. On a 4K
  // monitor at 175% scaling that leaves the overlay ~47px short at the bottom,
  // so points near the bottom edge (and the taskbar itself) are never covered.
  // Re-assert the full display bounds AFTER the window is at screen-saver
  // level, when Windows allows covering the taskbar. Verify and log the result.
  const enforceFullBounds = (phase: string) => {
    win.setAlwaysOnTop(true, "screen-saver");
    win.setBounds({ x, y, width, height });
    const got = win.getBounds();
    const full = got.width >= width && got.height >= height;
    console.log(
      `[Clicky] Overlay ${displayIndex} ${phase}: bounds=${JSON.stringify(got)} ` +
        `want=${width}x${height} fullCoverage=${full} isVisible=${win.isVisible()}`
    );
    if (!full) {
      console.warn(
        `[Clicky] Overlay ${displayIndex} is smaller than its display ` +
          `(${got.width}x${got.height} < ${width}x${height}); bottom/right edge points may be hidden.`
      );
    }
  };

  // Show after load is ready (transparent + show:false avoids a black flash on Windows)
  win.once("ready-to-show", () => {
    win.showInactive();
    enforceFullBounds("shown");
  });

  // Fallback: if ready-to-show never fires (transparent windows can be tricky),
  // force-show after the load completes.
  win.webContents.once("did-finish-load", () => {
    if (!win.isVisible()) {
      win.showInactive();
    }
    enforceFullBounds("did-finish-load");
  });

  return win;
}

// Create the chat window — always HIDDEN. It is never shown by creation alone:
// push-to-talk needs this renderer alive to capture the mic (getUserMedia /
// MediaRecorder live only here), so the window is often created purely to
// record, silently. Showing is a separate, explicit step (`openChatWindow`).
function createChatWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 420,
    height: 550,
    resizable: true,
    show: false,
    frame: false,
    transparent: false,
    alwaysOnTop: settings.get("alwaysOnTop"),
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // Keep timers / MediaRecorder running at full rate while the window is
      // hidden — push-to-talk records here even when chat is never shown.
      backgroundThrottling: false,
    },
  });

  win.loadFile(path.join(__dirname, "..", "..", "src", "renderer", "chat", "index.html"));
  return win;
}

// ---- Settings popover (tray-anchored) ----
// A frameless, taskbar-less panel that drops down from the tray icon and
// auto-hides on blur. Created once and reused (hidden, not destroyed) so
// toggling is instant and blur-to-dismiss works reliably. Resizable from its
// edges; the size the user leaves it at is remembered across sessions.
const POPOVER_MIN_WIDTH = 320;
const POPOVER_MIN_HEIGHT = 420;
let lastPopoverHide = 0;

function savePopoverSize(win: BrowserWindow): void {
  const { width, height } = win.getBounds();
  settings.set("popoverWidth", width);
  settings.set("popoverHeight", height);
}

function createPopover(): BrowserWindow {
  const win = new BrowserWindow({
    width: Math.max(POPOVER_MIN_WIDTH, settings.get("popoverWidth")),
    height: Math.max(POPOVER_MIN_HEIGHT, settings.get("popoverHeight")),
    minWidth: POPOVER_MIN_WIDTH,
    minHeight: POPOVER_MIN_HEIGHT,
    show: false,
    frame: false,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, "..", "..", "src", "renderer", "settings", "index.html"));
  // Dismiss when focus leaves the popover (clicking anywhere else).
  win.on("blur", () => {
    if (!win.isDestroyed() && win.isVisible()) {
      win.hide();
      lastPopoverHide = Date.now();
    }
  });
  return win;
}

// Anchor the popover to the tray icon, clamped inside the display's work area.
function positionPopover(win: BrowserWindow): void {
  const tray = getTray();
  const { width: w, height: h } = win.getBounds();
  if (tray) {
    const t = tray.getBounds();
    const wa = screen.getDisplayMatching(t).workArea;
    let x = Math.round(t.x + t.width / 2 - w / 2);
    x = Math.max(wa.x, Math.min(x, wa.x + wa.width - w));
    // Taskbar at top → drop below the icon; otherwise sit above it.
    const y = t.y <= wa.y + 10 ? wa.y : Math.max(wa.y, wa.y + wa.height - h);
    win.setPosition(x, y, false);
  } else {
    const wa = screen.getPrimaryDisplay().workArea;
    win.setPosition(wa.x + wa.width - w, wa.y + wa.height - h, false);
  }
}

// Show (or re-focus) the popover anchored to the tray. Used by the tray
// "Settings" item, the chat gear button, and first-run onboarding.
function showPopover(): void {
  if (!settingsWindow || settingsWindow.isDestroyed()) {
    settingsWindow = createPopover();
    settingsWindow.on("closed", () => {
      settingsWindow = null;
    });
  }
  const win = settingsWindow;
  positionPopover(win);
  win.show();
  win.focus();
}

// Tray left-click. Closes the popover if it's open; otherwise opens it. The
// guard swallows the click that immediately follows blur-hide, so clicking the
// tray icon while the popover is open closes it instead of reopening it.
function togglePopover(): void {
  if (
    settingsWindow &&
    !settingsWindow.isDestroyed() &&
    settingsWindow.isVisible()
  ) {
    savePopoverSize(settingsWindow);
    settingsWindow.hide();
    lastPopoverHide = Date.now();
    return;
  }
  if (Date.now() - lastPopoverHide < 300) return;
  showPopover();
}

// Ensure the (hidden) chat window exists, without showing it. Used both as the
// silent host for push-to-talk recording and as the base for openChatWindow.
function ensureChatWindow(): BrowserWindow {
  if (!chatWindow || chatWindow.isDestroyed()) {
    chatWindow = createChatWindow();
    chatWindow.on("closed", () => {
      chatWindow = null;
    });
  }
  return chatWindow;
}

// Reveal (and create if needed) the chat window — an EXPLICIT user action
// (tray menu, push-to-talk button, popover's "Open chat", first-run). Waits for
// the renderer to be paint-ready to avoid a white flash, then applies the
// always-on-top flag (more reliable after show() than via the constructor).
function openChatWindow(): void {
  const win = ensureChatWindow();
  const reveal = () => {
    if (win.isDestroyed()) return;
    win.show();
    win.focus();
    if (settings.get("alwaysOnTop")) {
      win.setAlwaysOnTop(true, "screen-saver");
      // Re-apply after a short delay — Windows can reset it.
      setTimeout(() => {
        if (!win.isDestroyed()) win.setAlwaysOnTop(true, "screen-saver");
      }, 500);
    }
  };
  if (win.isVisible()) {
    win.focus();
  } else if (win.webContents.isLoading()) {
    win.once("ready-to-show", reveal);
  } else {
    reveal();
  }
}

// Ensure a live recorder exists before push-to-talk recording starts, WITHOUT
// showing the chat window. Mic capture (getUserMedia/MediaRecorder) lives only
// in the chat renderer; without this, the first hotkey press after launch (no
// chat window yet) is recorded by nobody — the overlay shows "listening" but
// nothing is captured. Resolves once the hidden renderer has finished loading.
function ensureChatReady(): Promise<void> {
  const win = ensureChatWindow();
  return new Promise((resolve) => {
    if (!win.webContents.isLoading()) {
      resolve();
      return;
    }
    win.webContents.once("did-finish-load", () => resolve());
  });
}

function setupIPC(): void {
  // Chat query — captures screen + sends to Claude
  ipcMain.handle("chat:query", async (_event, text: string) => {
    try {
      const response = await companion.processQuery(text);
      return response;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(msg);
    }
  });

  // Settings
  ipcMain.handle("settings:getAll", () => settings.getAll());
  ipcMain.handle("settings:set", (_event, key: string, value: unknown) => {
    settings.set(key as keyof ReturnType<typeof settings.getAll>, value as never);

    // Apply alwaysOnTop immediately
    if (key === "alwaysOnTop" && chatWindow && !chatWindow.isDestroyed()) {
      chatWindow.setAlwaysOnTop(!!value, "screen-saver");
    }

    // The cursor tracking loop always runs (see startCursorBuddy); this
    // setting only gates the glow dot. When turning it off, hide the glow
    // immediately on every overlay — the next tick won't re-show it.
    if (key === "cursorBuddyEnabled" && !value) {
      for (const win of overlayWindows) {
        if (win && !win.isDestroyed()) {
          win.webContents.send("overlay:cursor-buddy-visible", false);
        }
      }
    }

    // Switching to (or enabling) Kokoro — warm its model now so the next reply
    // doesn't pay the cold-load cost.
    if (key === "ttsProvider" || key === "ttsEnabled" || key === "kokoroQuality") {
      maybePrewarmKokoro();
    }
  });

  // Shared helper: fetch + cache Groq model list. Used by both the test-key
  // button and the background auto-refresh (identical behaviour).
  async function refreshGroqCache(apiKey: string, baseUrl?: string) {
    const result = await fetchGroqModels(apiKey, baseUrl);
    if (result.ok && result.models) {
      settings.set("groqSttModelList", result.models);
      settings.set("groqSttModelListFetchedAt", Date.now());
    }
    return result;
  }

  // Verify a Groq API key by hitting GET /models. On success, refreshes the
  // cached model list (deduped, whisper-large-v3-turbo pinned first).
  ipcMain.handle(
    "settings:testGroqKey",
    (_event, apiKey: string, baseUrl?: string) => refreshGroqCache(apiKey, baseUrl)
  );

  // Force a refresh of the cached Groq model list (used by auto-refresh on
  // settings panel open, when the cache is older than 5 days).
  ipcMain.handle(
    "settings:refreshGroqModelList",
    (_event, apiKey: string, baseUrl?: string) => refreshGroqCache(apiKey, baseUrl)
  );

  // Verify a Gemini API key by hitting the list-models endpoint. On success,
  // refresh the cached model list (deduped, default model pinned first).
  ipcMain.handle(
    "settings:testGeminiKey",
    async (_event, apiKey: string, baseUrl?: string) => {
      const result = await fetchGeminiModels(apiKey, baseUrl);
      if (result.ok && result.models) {
        settings.set("geminiModelList", result.models);
        settings.set("geminiModelListFetchedAt", Date.now());
      }
      return result;
    }
  );

  // Verify an OpenCode Go API key by hitting GET /models. On success, refresh
  // the cached model list (raw live ids; vision badging happens in the UI).
  ipcMain.handle(
    "settings:testOpenCodeGoKey",
    async (_event, apiKey: string, baseUrl?: string) => {
      const result = await fetchOpenCodeGoModels(apiKey, baseUrl);
      if (result.ok && result.models) {
        settings.set("opencodeGoModelList", result.models);
        settings.set("opencodeGoModelListFetchedAt", Date.now());
      }
      return result;
    }
  );

  // Open URL in default browser
  ipcMain.handle("shell:openExternal", (_event, url: string) => {
    if (url.startsWith("https://")) {
      shell.openExternal(url);
    }
  });

  // Window controls
  ipcMain.handle("window:minimize", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });

  ipcMain.handle("window:close", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });

  // Open the settings popover (single config surface) from a renderer —
  // e.g. the chat window's gear button / first-run CTA.
  ipcMain.handle("window:openSettings", () => showPopover());

  // Open the chat window from a renderer — e.g. the popover's "Open chat" link.
  ipcMain.handle("window:openChat", () => openChatWindow());

  // Hide the popover back to the tray (the popover's close button). Saves
  // size so reopening restores the dimensions the user chose.
  ipcMain.handle("window:hidePopover", () => {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      savePopoverSize(settingsWindow);
      settingsWindow.hide();
      lastPopoverHide = Date.now();
    }
  });
}

// If Kokoro (local neural TTS) is the active provider, load its model in the
// background so the first reply doesn't stall ~1s on the cold load. Best-effort:
// if the model isn't installed the rejection is swallowed and the real error
// still surfaces at speak time.
function maybePrewarmKokoro(): void {
  if (settings.get("ttsEnabled") && settings.get("ttsProvider") === "kokoro") {
    prewarmKokoro(settings.get("kokoroQuality")).catch(() => {
      /* model not installed yet — ignore; surfaces at speak time */
    });
  }
}

app.whenReady().then(() => {
  // Hide from taskbar — tray only
  app.dock?.hide?.();

  overlayWindows = createOverlayWindows();
  companion = new CompanionManager(settings, overlayWindows);

  // Warm the local TTS model ahead of the first reply if it's selected.
  maybePrewarmKokoro();

  const audioCapture = new AudioCapture(settings);
  audioCapture.setCompanion(companion);

  setupIPC();

  createTray(
    {
      onChat: () => openChatWindow(),
      onSettings: () => showPopover(),
      onToggle: () => togglePopover(),
      onQuit: () => app.quit(),
    },
    settings
  );

  const hotkeyManager = new HotkeyManager(settings, ensureChatReady);
  hotkeyManager.register();

  // Pre-create the chat window HIDDEN so the push-to-talk recorder is warm and
  // the very first hotkey press records instantly — without ever popping chat
  // onto the screen. It stays invisible until the user explicitly opens it.
  ensureChatWindow();

  // Launch tray-only / background by default. The only thing that opens on
  // startup is first-run onboarding: if no AI key is configured, drop the
  // settings popover so a brand-new user lands directly in setup. Otherwise
  // stay silent in the tray — chat/popover open on demand.
  const hasAiKey =
    settings.get("anthropicApiKey") ||
    settings.get("openaiApiKey") ||
    settings.get("openrouterApiKey") ||
    settings.get("geminiApiKey");
  if (!hasAiKey) {
    showPopover();
  }

  // Always run the cursor tracking loop so the listening/thinking companion
  // can anchor to the cursor regardless of the glow-dot setting. The loop
  // itself gates the glow messages on `cursorBuddyEnabled`.
  startCursorBuddy();

  console.log("Clicky Windows started — running in system tray");
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

// Prevent app from closing when all windows are closed (tray app)
app.on("window-all-closed", () => {
  // Do nothing — keep app running in tray
});
