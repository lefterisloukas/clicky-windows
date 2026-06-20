import { globalShortcut, ipcMain, BrowserWindow } from "electron";
import { SettingsStore } from "./settings";

export class HotkeyManager {
  private settings: SettingsStore;
  private isRecording = false;
  private ensureRecorderReady?: () => Promise<void> | void;

  /**
   * @param ensureRecorderReady Optional hook awaited when recording STARTS,
   *   before the `recording-changed` broadcast. Push-to-talk capture
   *   (`getUserMedia`/`MediaRecorder`) lives only in the chat renderer, which
   *   is created lazily — so the first hotkey press after launch would
   *   otherwise be captured by nobody. This lets `index.ts` open and finish
   *   loading the chat window first, guaranteeing a live recorder.
   */
  constructor(
    settings: SettingsStore,
    ensureRecorderReady?: () => Promise<void> | void
  ) {
    this.settings = settings;
    this.ensureRecorderReady = ensureRecorderReady;
  }

  register(): void {
    const hotkey = this.settings.get("pushToTalkHotkey", "Ctrl+Alt");

    // Register push-to-talk activation
    globalShortcut.register(`${hotkey}+Space`, () => {
      void this.toggleRecording();
    });

    // IPC listeners for renderer
    ipcMain.handle("hotkey:isRecording", () => this.isRecording);
  }

  private async toggleRecording(): Promise<void> {
    const next = !this.isRecording;

    // When starting, make sure a renderer capable of capturing the mic is
    // alive and loaded BEFORE we announce recording. Otherwise the overlay's
    // "listening" indicator lights up but no window is actually recording.
    if (next && this.ensureRecorderReady) {
      await this.ensureRecorderReady();
    }

    this.isRecording = next;

    // Notify all renderer windows
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) {
        win.webContents.send("hotkey:recording-changed", this.isRecording);
      }
    });

    // Bind Escape as a cancel key only while recording, so it doesn't
    // swallow Escape for the rest of the system the rest of the time.
    if (this.isRecording) {
      this.registerCancelKey();
      console.log("Push-to-talk: recording started");
    } else {
      this.unregisterCancelKey();
      console.log("Push-to-talk: recording stopped");
    }
  }

  /**
   * Abort an in-progress recording: stop without transcribing. Tells the
   * renderer to discard the captured audio and the overlay to drop the
   * listening state. We deliberately do NOT send "recording-changed(false)",
   * because that path transcribes + queries the audio we're throwing away.
   */
  private cancelRecording(): void {
    if (!this.isRecording) return;
    this.isRecording = false;
    this.unregisterCancelKey();
    BrowserWindow.getAllWindows().forEach((win) => {
      if (!win.isDestroyed()) {
        win.webContents.send("hotkey:recording-cancelled");
      }
    });
    console.log("Push-to-talk: recording cancelled");
  }

  private registerCancelKey(): void {
    if (globalShortcut.isRegistered("Escape")) return;
    const ok = globalShortcut.register("Escape", () => this.cancelRecording());
    if (!ok) console.warn("Could not register Escape as the cancel key");
  }

  private unregisterCancelKey(): void {
    if (globalShortcut.isRegistered("Escape")) {
      globalShortcut.unregister("Escape");
    }
  }

  unregister(): void {
    globalShortcut.unregisterAll();
  }
}
