import { TTSProvider } from "./interface";
import { execFile } from "child_process";

/**
 * Local TTS using Windows SAPI (Speech API) via PowerShell.
 * No data leaves the device — required for HIPAA mode.
 */
export class LocalTTS implements TTSProvider {
  private currentProcess: ReturnType<typeof execFile> | null = null;

  async speak(text: string): Promise<void> {
    this.stop();

    // SAPI reads punctuation literally, so strip markdown emphasis/heading
    // markers that the LLM tends to emit ("**bold**", "# heading", "`code`").
    const spoken = text
      .replace(/[*_`#>]/g, "")
      .replace(/[ \t]+/g, " ")
      .trim();

    if (!spoken) {
      return;
    }

    // Pass the whole script via -EncodedCommand (base64 UTF-16LE). This avoids
    // every quoting/newline/special-char footgun that breaks inline -Command
    // strings — the spoken text often contains newlines, apostrophes and
    // markdown, any of which would otherwise terminate the PowerShell string.
    // -NoProfile skips the user's profile.ps1 (which may load conda etc. and
    // print errors that have nothing to do with TTS).
    const textB64 = Buffer.from(spoken, "utf16le").toString("base64");
    const script =
      "Add-Type -AssemblyName System.Speech; " +
      "$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer; " +
      `$synth.Speak([System.Text.Encoding]::Unicode.GetString([System.Convert]::FromBase64String('${textB64}')))`;
    const encodedCommand = Buffer.from(script, "utf16le").toString("base64");

    return new Promise((resolve, reject) => {
      this.currentProcess = execFile(
        "powershell",
        ["-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand],
        (error) => {
          this.currentProcess = null;
          if (error) {
            // Ignore abort errors (we killed it via stop())
            if (error.killed) {
              resolve();
            } else {
              reject(error);
            }
          } else {
            resolve();
          }
        },
      );
    });
  }

  stop(): void {
    if (this.currentProcess) {
      this.currentProcess.kill();
      this.currentProcess = null;
    }
  }
}
