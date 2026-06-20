// Shared Server-Sent-Events reader for the fetch-based streaming providers
// (Claude / OpenAI / OpenRouter). Gemini streams via the @google/genai SDK's
// async iterable and does not use this.
//
// In the Electron main process `fetch` is undici's, so `response.body` is a
// WHATWG ReadableStream exposing `getReader()` — no extra dependency needed.

/**
 * Read an SSE response body and invoke `onEvent` with the parsed JSON of each
 * `data:` line. Handles:
 *  - payloads split across network chunks (a persistent line buffer keeps any
 *    trailing partial line until its newline arrives),
 *  - the `[DONE]` sentinel (OpenAI / OpenRouter) — returns cleanly,
 *  - non-`data:` framing lines (`event:`, `id:`, comments, blank lines) — skipped,
 *  - keep-alive / non-JSON `data:` lines — skipped without throwing.
 *
 * Throwing inside `onEvent` (e.g. to surface a provider `error` event) aborts
 * the read and propagates to the caller.
 */
export async function readSSE(
  response: Response,
  onEvent: (json: unknown) => void
): Promise<void> {
  if (!response.body) {
    throw new Error("No response body to stream");
  }

  // `response.body` is a WHATWG ReadableStream in Electron/undici.
  const reader = (
    response.body as unknown as ReadableStream<Uint8Array>
  ).getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Consume only complete lines; keep any trailing partial in `buffer`.
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);

        if (!line.startsWith("data:")) continue; // event:/id:/comments/blanks
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") return;
        if (!payload) continue;

        let parsed: unknown;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue; // keep-alive or non-JSON data line — ignore
        }
        onEvent(parsed);
      }
    }
  } finally {
    reader.releaseLock();
  }
}
