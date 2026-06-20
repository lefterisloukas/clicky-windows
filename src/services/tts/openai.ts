import { TTSProvider } from "./interface";
import { splitText } from "../incremental";
import { exec } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const MAX_CHARS = 4000; // OpenAI limit is 4096, leave margin

/**
 * OpenAI TTS — uses the /v1/audio/speech endpoint.
 * Voices: alloy, ash, ballad, coral, echo, fable, onyx, nova, sage, shimmer
 * Auto-chunks long text and dynamically calculates playback duration.
 */
export class OpenAITTS implements TTSProvider {
  private apiKey: string;
  private voice: string;
  private abortController: AbortController | null = null;
  private currentProcess: ReturnType<typeof exec> | null = null;
  private stopped = false;

  constructor(apiKey: string, voice: string = "alloy") {
    this.apiKey = apiKey;
    this.voice = voice;
  }

  async speak(text: string): Promise<void> {
    this.stop();
    this.stopped = false;

    // Split into chunks at sentence boundaries
    const chunks = this.splitText(text);

    for (const chunk of chunks) {
      if (this.stopped) break;
      await this.speakChunk(chunk);
    }
  }

  private async speakChunk(text: string): Promise<void> {
    this.abortController = new AbortController();

    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "tts-1",
        input: text,
        voice: this.voice,
        response_format: "mp3",
      }),
      signal: this.abortController.signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI TTS error (${response.status}): ${error}`);
    }

    const audioBuffer = Buffer.from(await response.arrayBuffer());
    const tmpFile = path.join(os.tmpdir(), `clicky-tts-${Date.now()}.mp3`);
    fs.writeFileSync(tmpFile, audioBuffer);

    // Estimate duration: MP3 at ~128kbps = ~16KB/sec
    const estimatedSeconds = Math.ceil(audioBuffer.length / 16000) + 1;

    return new Promise((resolve, reject) => {
      const psCmd = [
        "Add-Type -AssemblyName presentationCore",
        "$p = New-Object System.Windows.Media.MediaPlayer",
        `$p.Open([Uri]'${tmpFile}')`,
        "$p.Play()",
        `Start-Sleep -Seconds ${estimatedSeconds}`,
        "$p.Close()",
      ].join("; ");

      this.currentProcess = exec(
        `powershell -Command "${psCmd}"`,
        { timeout: estimatedSeconds * 1000 + 5000 },
        (error) => {
          this.currentProcess = null;
          try { fs.unlinkSync(tmpFile); } catch {}
          if (error && !error.killed) {
            reject(error);
          } else {
            resolve();
          }
        }
      );
    });
  }

  private splitText(text: string): string[] {
    return splitText(text, MAX_CHARS);
  }

  stop(): void {
    this.stopped = true;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (this.currentProcess) {
      this.currentProcess.kill();
      this.currentProcess = null;
    }
  }
}
