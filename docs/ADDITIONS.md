# Additions Log

Chronological record of features, fixes, and changes added to the project.
Each entry is dated and time-stamped (local time, `Europe/Istanbul` / UTC+3
unless otherwise noted). Newest entries go at the top.

---

## 2026-06-20

### fix/tts-playback-gap — remove the dead air and CPU stutter between spoken sentences
**Time:** ~ (local, UTC+3)
**Branch:** `fix/tts-playback-gap`
**Components:** `src/services/tts/{kokoro,openai,elevenlabs}.ts`

Fixed two related TTS symptoms reported with the local Kokoro voice: the PC
stuttered at the start of each sentence, and the audio for each sentence came
in noticeably delayed after the previous one.

**Root cause**
Both came from the per-chunk audio playback, not from Kokoro's inference. Each
sentence chunk was played by spawning a fresh `powershell.exe` that ran
`Add-Type -AssemblyName presentationCore` (cold-loading the heavyweight WPF
PresentationCore assembly), opened a `MediaPlayer`, called `Play()`, then
`Start-Sleep`-ed for a *guessed* duration before the playback promise resolved
and the queue could advance.

- **Inter-sentence delay:** Kokoro slept `Math.ceil(duration) + 1` seconds —
  1–2s of guaranteed dead air after every sentence's audio actually ended.
  OpenAI estimated from MP3 byte size + 1s; ElevenLabs slept a hardcoded 8s
  regardless of clip length.
- **Per-sentence stutter:** spawning PowerShell and cold-loading the WPF
  assemblies for every chunk produced a CPU burst right as each sentence began,
  stacked on top of the concurrent Kokoro inference for the next chunk.

**Fix**
1. `kokoro.ts` (WAV output): play via `System.Media.SoundPlayer.PlaySync()`,
   which blocks for exactly the clip length and doesn't need PresentationCore.
   No more guessed `Start-Sleep`; duration is now used only to bound the
   process timeout.
2. `openai.ts`: switched the request from `response_format: "mp3"` to `"wav"`
   so it can use the same `SoundPlayer.PlaySync()` path.
3. `elevenlabs.ts` (MP3, no clean WAV option from the API): kept `MediaPlayer`
   but replaced the hardcoded 8s pad — it now polls until the file's
   `NaturalDuration` is known (capped at 5s so a load failure can't hang) and
   sleeps that exact span + a small 250ms tail.

**Verification**
- `npx tsc` exits 0.

---

### fix/truncated-point-tags — stop truncated responses from leaking half-formed POINT tags
**Time:** ~ (local, UTC+3)
**Branch:** `fix/truncated-point-tags`
**Components:** `src/services/{claude,openai-chat,openrouter-chat,gemini-chat}.ts`, `src/renderer/chat/index.html`

Fixed a bug where long assistant replies were cut off mid-POINT tag, causing
chat text to end with a visible fragment like `[POINT:4` and leaving the answer
incomplete.

**Root cause**
All four LLM providers capped their output at 1024 tokens. Replies that listed
several screen elements (e.g. multiple musical notes in a score) could hit that
limit while a `[POINT:x,y:label:screenN]` tag was still being emitted. The chat
renderer stripped only *complete* tags, so the trailing incomplete tag leaked
into the message bubble.

**Fix**
1. Raised the output-token limit from `1024` to `4096` on every provider:
   `claude.ts` (`max_tokens`), `openai-chat.ts` (`max_completion_tokens`),
   `openrouter-chat.ts` (`max_tokens`), and `gemini-chat.ts`
   (`maxOutputTokens`). This is the primary fix — it gives the model enough
   room to finish its sentence and any POINT tags.
2. Hardened the chat renderer to hide a trailing, unclosed `[POINT:...` fragment
   while streaming and in the final fallback display path. The raw accumulated
   text is kept intact so a later chunk can still complete the tag; only what
   the user sees is filtered. This prevents any leftover partial tag from being
   shown if a future response still gets truncated.

**Verification**
- `npx tsc` exits 0.

---

## 2026-06-20

### feat/streaming-inference — perf: reuse AI provider instances across queries
**Time:** ~ (local, UTC+3)
**Branch:** `feat/streaming-inference`
**Components:** `src/main/companion.ts`

**Old behavior:** `getAIProvider()` constructed a fresh `OpenAIChatService`,
`OpenRouterChatService`, `GeminiChatService`, or `ClaudeService` on every query,
and `refineTagAsync` constructed a fresh `ClaudeService` per POINT tag. Each new
instance meant a cold HTTP connection (TCP/TLS handshake, no HTTP2 reuse), adding
small but avoidable latency on every request.

**New behavior:** `CompanionManager` now lazily caches one instance of each
provider. The cached services still read `settings.get(...)` fresh on every call,
so model, API key, and proxy changes are picked up without recreating the
instance. The second-pass refinement path shares the same cached `ClaudeService`
instead of building its own.

**Verification**
- `npx tsc --noEmit` exits 0.

---

### feat/streaming-inference — post-review fixes for streaming reliability
**Time:** ~ (local, UTC+3)
**Branch:** `feat/streaming-inference`
**Components:** `src/renderer/chat/index.html`, `src/main/companion.ts`, `src/services/incremental.ts`

Addressed three issues found during PR review of the streaming-inference work:

1. **Stale chat bubbles on query supersession.** When a new query cancelled an
   in-flight one, the old streaming bubble was left in the DOM because
   `chat:stream-start` created a new bubble without removing the existing one.
   `src/renderer/chat/index.html` now removes any existing streaming bubble
   before opening a new one.
2. **Empty assistant replies dropped the user turn from history.**
   `src/main/companion.ts` previously skipped committing *both* turns when the
   model returned an empty response, silently erasing the user's question from
   later context. It now always commits the user turn and only skips an empty
   assistant turn.
3. **Unbounded raw buffer in sentence extractor.** A long unclosed `[` in
   streamed text (e.g. markdown or code) could cause `IncrementalSentenceExtractor`
   to buffer `raw` without limit. `src/services/incremental.ts` now caps the raw
   buffer and flushes everything before the last `[` once it exceeds twice the
   sentence chunk size.

All three fixes pass `npm run typecheck` and `npm run lint`.

---

### feat/streaming-inference — stream the LLM response end-to-end (text + cursor + voice)
**Time:** ~ (local, UTC+3)
**Branch:** `feat/streaming-inference`
**Author:** original streaming-inference implementer (previous agent — not the current user)
**Components:** `src/main/companion.ts`, `src/services/{claude,openai-chat,openrouter-chat,gemini-chat}.ts`, `src/services/{streaming,incremental}.ts`, `src/services/tts/queue.ts`, `src/preload/index.ts`, `src/renderer/{overlay,chat}/index.html`

Made the whole inference pipeline incremental so the user gets feedback while
the model is still generating, instead of staring at a spinner for the entire
response.

**Old behavior**
- `processQuery` did `await ai.query()` for the *entire* response (non-streaming
  on all four providers), then parsed all POINT tags, then ran a *blocking*
  Claude refinement pass over all of them, then sent points to the overlay, then
  started TTS on the full text.
- Nothing appeared until everything finished: no chat text, no cursor, no voice
  until the full generation + refinement round-trips completed.
- The overlay received one batched array of points; chat got the reply only as
  the IPC return value.

**New behavior**
- All four providers stream: Claude / OpenAI / OpenRouter via SSE (`stream: true`,
  shared reader in `src/services/streaming.ts` that buffers partial lines across
  network chunks), Gemini via `generateContentStream`. Each calls a new optional
  `onDelta(chunk)` and still returns the full final `{text}` (used for history
  and as a non-streaming fallback). A new `signal` aborts an in-flight request.
- As text streams in, `companion.ts` drives three consumers:
  - **Chat text** streams live via new `chat:stream-start` / `chat:stream-delta`
    / `chat:stream-end` IPC events (plain text while streaming, single markdown
    render at the end).
  - **POINT tags** are extracted incrementally (`IncrementalPointExtractor`,
    buffers a tag split across chunks) and each completed tag moves the overlay
    cursor immediately. For Claude, the refinement second pass now runs
    *concurrently* per-tag and nudges the already-shown point in place (raw →
    refined), instead of blocking the whole reply.
  - **TTS** speaks each completed sentence (`IncrementalSentenceExtractor`) while
    the rest still generates, via a new `TTSQueue` that serialises `speak()`
    calls on one provider instance (avoids each provider's `speak()`-calls-
    `stop()` from killing the previous sentence).
- The overlay handler is now an id-keyed queue with a minimum dwell: it preserves
  the sequential multi-step walkthrough, updates a point in place on a
  `kind:"refine"` message, and clears on `kind:"reset"` at the start of a query.
- Interruption: a newer query aborts the previous fetch + stops its TTS via an
  `AbortController`/`QuerySession`; conversation history is only committed on
  success (built locally first) so a cancelled/failed query leaves no dangling
  turn.
- Shared `splitText` extracted from `tts/kokoro.ts` + `tts/openai.ts` into
  `src/services/incremental.ts` (behavior-neutral dedupe).
- Note: Gemini's SDK exposes no AbortSignal, so its streaming aborts
  cooperatively (checked between chunks).

**Verification**
- `npx tsc` clean. Manual: Gemini/OpenAI with Kokoro TTS — chat text appears
  token-by-token, cursor moves on the first POINT tag before the sentence ends,
  voice starts on the first completed sentence. Claude — cursor appears raw then
  nudges to the refined spot. Multi-monitor routing preserved via `displayIndex`.

---

### feat/streaming-inference — warm up Kokoro TTS at startup
**Time:** ~ (local, UTC+3)
**Branch:** `feat/streaming-inference`
**Author:** original streaming-inference implementer (previous agent — not the current user)
**Components:** `src/services/tts/kokoro.ts`, `src/main/index.ts`

**Old behavior:** the Kokoro model loaded lazily on the first `speak()` call, so
the first spoken reply stalled ~1s (q4) on the cold load.

**New behavior:** added `prewarmKokoro(quality)` which triggers the existing
cached `loadModel`. `index.ts` calls it at startup (and on switching the TTS
provider / quality to Kokoro) when Kokoro is the active provider, so the model
is already resident before the first reply. Best-effort — if the model isn't
installed the rejection is swallowed and the real error still surfaces at speak
time as before.

---

### feat/streaming-inference — capture the screen in parallel with transcription
**Time:** ~ (local, UTC+3)
**Branch:** `feat/streaming-inference`
**Author:** original streaming-inference implementer (previous agent — not the current user)
**Components:** `src/main/audio.ts`, `src/main/companion.ts`

**Old behavior:** for voice queries, `audio.ts` awaited transcription and only
then called `processQuery`, which captured the screen — so capture (~0.3–1s) sat
serially after transcription.

**New behavior:** `audio:recording-complete` kicks off a new public
`CompanionManager.captureScreens()` the moment the mic stops (the screen state
the user is asking about) in parallel with transcription, then passes the result
into `processQuery(transcript, prefetched?)`. Capture now overlaps transcription
instead of adding to the serial path. If parallel capture fails it falls back to
inline capture. The text (`chat:query`) path is unchanged — no transcription to
overlap.

---

### feat/cursor-visual-states — refactor: replace cursor-buddy circle with 4-pointed spark
**Time:** ~ (local, UTC+3)
**Branch:** `feat/cursor-visual-states`
**Component:** `src/renderer/overlay/index.html`

Replaced the filled blue circle (`#cursor-buddy`) that tracked the mouse with a
4-pointed star (spark) SVG, anchored **below-right of the cursor tip** so it
never covers the hotspot.

- Shape: inline SVG `<path d="M7 0 L8.2 5.8 L14 7 …">`, 14×14 px, radial
  gradient white → cyan (`#22D3EE`) → blue (`#0EA5E9`).
- Position: `transform: translate(8px, 8px)` from the cursor tip (previously
  `translate(-50%, -50%)` which centred it on the cursor).
- Animation: slow 7 s full rotation (`sparkSpin`) + 2 s glow pulse
  (`sparkPulse`) via `drop-shadow` filter — no `::after` ring.
- Opacity when visible: `0.82` (was `1.0`).
- `prefers-reduced-motion`: both animations disabled, static position kept.

---

### feat/cursor-visual-states — refactor: replace cursor companion pill with bare animations
**Time:** ~ (local, UTC+3)
**Branch:** `feat/cursor-visual-states`
**Component:** `src/renderer/overlay/index.html`

Removed the opaque dark pill (background, border, text labels) from the cursor
companion indicator and replaced it with minimal, slightly transparent
animations that sit directly on air:

- **Listening**: 5 CSS `#eq-bars` equalizer bars with staggered `barDance`
  keyframes, glowing cyan — replaces the canvas-based scrolling wave.
- **Thinking**: existing conic-gradient `mini-spin` ring kept exactly as-is,
  with a small `drop-shadow` glow added.
- **Removed** `#recording-indicator` and `#processing-indicator` corner pills
  entirely (CSS + HTML).
- **Removed** all canvas wave JS (`initWave`, `drawWave`, `startWave`,
  `stopWave`, `requestAnimationFrame` loop).
- Companion `opacity` reduced to `0.72` (from `1.0`) when visible.
- Position changed from upper-right (`translate(14px, -34px)`) to
  lower-right (`translate(14px, 14px)`) of the cursor tip.

---

### feat/cursor-visual-states — feat: Escape cancels an in-progress recording
**Time:** ~ (local, UTC+3)
**Branch:** `feat/cursor-visual-states`
**Author:** Claude Code

Added a way to **abort** push-to-talk while listening, without transcribing or
querying the captured audio. The push-to-talk hotkey is a *toggle* (a global
shortcut fires once per press; there's no key-up), so previously the only way
out of a recording was to press the hotkey again — which always sent the audio
through the pipeline. Escape now bails out cleanly.

- `src/main/hotkey.ts` — `Escape` is registered as a global shortcut **only
  while recording** (`registerCancelKey` on start, `unregisterCancelKey` on
  stop), so it doesn't swallow Escape system-wide the rest of the time.
  Pressing it calls `cancelRecording()`, which flips `isRecording` off and
  broadcasts a new **`hotkey:recording-cancelled`** event. It deliberately does
  **not** send `recording-changed(false)` — that path transcribes + queries the
  very audio we're discarding.
- `src/preload/index.ts` — exposed `onRecordingCancelled`.
- `src/renderer/chat/index.html` — on cancel, sets a `discardRecording` flag and
  stops the recorder; `mediaRecorder.onstop` drops the chunks and resets the mic
  UI instead of sending them.
- `src/renderer/overlay/index.html` — on cancel, drops the companion state to
  idle and hides the indicator.

**Verification**
- `npx tsc` exits 0.
- Repro: hold the hotkey to start listening, press **Escape** → indicator
  disappears, no transcript, no query, mic released.

---

### feat/cursor-visual-states — feat: cursor-anchored state indicator (foundation)
**Time:** ~ (local, UTC+3)
**Branch:** `feat/cursor-visual-states`
**Author:** Claude Code

The foundation under the bare animations above: moving the "listening" /
"thinking" feedback from the screen-corner pills to the **cursor itself**, since
that's where the user is looking. Three layers:

- **`src/main/index.ts` — decoupled cursor tracking from the glow setting.** The
  60 fps tracking loop (`startCursorBuddy`) now runs **unconditionally** while
  the app is up and emits a new **`overlay:companion-anchor`** message
  (`{ active, x, y }`) every tick to drive the indicator's position. The glow
  dot's own messages (`overlay:cursor-buddy(-visible)`) stay gated behind
  `cursorBuddyEnabled`, so the glow behaves exactly as before. This lets the
  listening/thinking indicator anchor to the cursor **even when the glow dot is
  disabled**. The settings toggle no longer starts/stops the loop — it only
  gates the glow (and hides it immediately when turned off).
- **`src/preload/index.ts`** — exposed `onCompanionAnchor`.
- **`src/renderer/overlay/index.html` — state machine.** `companionState`
  (`idle | listening | thinking`) is driven by `onRecordingChanged` (→ listening)
  and `onStage` (any stage except `speaking`/`done` → thinking; those two →
  idle). The indicator shows only when the state isn't idle **and** the cursor is
  on that display (`anchor.active`), so on multi-monitor it appears only where
  the cursor is.

The visual treatment that rides on this foundation is documented in the
"replace cursor companion pill with bare animations" entry above.

**Verification**
- `npx tsc` exits 0.
- Listening/thinking indicators track the cursor and survive toggling the
  Cursor Companion glow off.

---

### feat/cursor-visual-states — fix: first push-to-talk after launch captured nothing
**Time:** ~ (local, UTC+3)
**Branch:** `feat/cursor-visual-states`
**Author:** Claude Code

Fixed a bug where the **first** voice request after launching the app did
nothing: the overlay showed its "listening" indicator, but no audio was
captured, and opening the Chat window afterwards showed an empty conversation —
as if nothing had been said.

**Root cause**
Push-to-talk mic capture (`getUserMedia` / `MediaRecorder`) lives **only** in
the chat window's renderer (`src/renderer/chat/index.html` — the sole renderer
with `getUserMedia`). The chat window is created lazily (it's a tray-resident
app), and the global hotkey never opened it. So if the user triggered
push-to-talk before ever opening Chat, there was no renderer alive to record:

1. Hotkey fires → `hotkey.ts` flips `isRecording` and broadcasts
   `hotkey:recording-changed` to all **open** windows.
2. The chat renderer is what listens and runs `startRecording()` — but it
   didn't exist yet.
3. `audio:recording-complete` was therefore never invoked → no transcript →
   nothing processed.

The `feat/cursor-visual-states` work made the failure *look* like success: the
always-alive overlay window now also listens to `hotkey:recording-changed` and
animates a cyan "listening" wave near the cursor. That indicator reacts to the
hotkey **broadcast**, not to any real mic stream, so it lit up even though no
window was recording — giving false confirmation that Clicky had heard the user.

**Fix**
Ensure a recording-capable renderer is alive and loaded **before** recording is
announced — but keep it **invisible**. The chat window doesn't need to be shown
to host the recorder; it only needs to exist and be loaded. Edits, all in the
main process:

- `src/main/hotkey.ts` — `HotkeyManager` now accepts an optional
  `ensureRecorderReady` hook (constructor arg). `toggleRecording` is `async`;
  when recording **starts**, it `await`s that hook before broadcasting
  `recording-changed`. Also guards the broadcast against destroyed windows.
- `src/main/index.ts` — split window creation from window *showing*:
  - `createChatWindow()` now always creates the window **hidden** (no auto-show
    on `ready-to-show`) and sets `webPreferences.backgroundThrottling: false`
    so timers / `MediaRecorder` keep running at full rate while hidden.
  - `ensureChatWindow()` — creates the hidden window if absent, returns it
    (never shows).
  - `ensureChatReady()` — `ensureChatWindow()` + resolves once the renderer has
    finished loading. This is the hook passed to `HotkeyManager`. **It does not
    show the window.**
  - `openChatWindow()` — the only path that *reveals* the window (waits for
    `ready-to-show` to avoid a white flash, then re-applies always-on-top). Used
    by the tray menu, the popover's "Open chat", and first-run.
  - At startup the hidden chat window is **pre-created** (`ensureChatWindow()`)
    so the recorder is warm and the very first hotkey press records instantly.

Net effect: push-to-talk works on the first try after launch (and every time)
**without the chat window ever popping onto the screen**. The conversation still
accumulates in the hidden chat window, so it's all there if the user later opens
chat. The overlay's "listening" indicator now always has a real recorder behind
it.

**Verification**
- `npx tsc` exits 0.
- Repro: launch app, press the hotkey *without* opening Chat, speak. Previously
  nothing was captured; now the request is processed and **no window appears**.

**Out of scope (deferred)**
- Fully overlay-only (chat-less) voice: moving mic capture into the always-alive
  overlay renderer and surfacing transcript/response purely via overlay + TTS.
  Not needed — the hidden-chat-window approach already gives a popup-free voice
  flow while keeping the existing recording + transcript-display architecture.

---

## 2026-06-14

### feat/june14fixes-after-kokoro — logging + TTS-label fixes
**Time:** ~14:30 (local, UTC+3)
**Branch:** `feat/june14fixes-after-kokoro` (cut from `feat/kokorotts`)
**Author:** Claude Code

Small post-Kokoro polish pass. Four independent fixes, all additive:

- **Provider-accurate response log.** `src/main/companion.ts` always logged
  `[Clicky] Claude response:` regardless of the active provider. Added a
  `providerLabel()` helper (anthropic → Claude, openai → OpenAI, openrouter →
  OpenRouter, gemini → Gemini, else the raw id) and the log line now reflects
  the real provider.
- **Console arrow mojibake.** The Unicode arrows (`→` / `←`) in log strings
  rendered as `ΓåÆ` / `ΓåÉ` in the Windows console (code-page mismatch).
  Replaced them with ASCII `->` / `<-` in `src/main/companion.ts` (4 lines)
  and `src/main/screenshot.ts` (1 line).
- **Readable TTS toggle labels.** The chat quick-toggle showed cramped codes
  `KOK` / `WIN` / `AI` (the `KOK` read as Greek "κοκ" to the user). Changed to
  full names `Kokoro` / `Windows` / `OpenAI` in
  `src/renderer/chat/index.html`. (Supersedes the `KOK/WIN/AI` labels noted in
  the Kokoro entry below.)
- **Log the transcript text.** `src/main/audio.ts` logged only
  `Transcript received, length: N`; it now logs the transcript content too:
  `Transcript received (length N): <text>`.

**Verification**
- `npx tsc` exits 0.

---

### feat/kokorotts — Kokoro as a local, offline TTS provider
**Time:** ~13:50 (local, UTC+3)
**Branch:** `feat/kokorotts` (cut from `develop`)
**Author:** Claude Code

Added **Kokoro** as a fourth TTS provider alongside ElevenLabs / OpenAI /
Windows SAPI. Kokoro is an 82M-parameter open-weight neural TTS model
(Apache-2.0) that sounds far more natural than Windows SAPI yet runs **entirely
on-device** — no API key, no server, no Python, nothing leaves the machine. It
strengthens the existing offline/HIPAA story (whisper-local + local TTS). Uses
[`kokoro-js`](https://www.npmjs.com/package/kokoro-js) (maintained by
Xenova / Hugging Face) running the `onnx-community/Kokoro-82M-v1.0-ONNX` weights
through `onnxruntime-node` in the main process. All additions are additive —
default TTS provider is unchanged.

Deliberately **not** over-engineered: Kokoro's voice list is fixed and baked
into the model, so there is **no API-key / Test-connection / dynamic-fetch**
machinery (unlike Groq/Gemini) — just a static dropdown.

**New code**
- `src/services/tts/kokoro.ts` — `KokoroTTS implements TTSProvider`. The model
  loads **once per dtype** into a module-level `Map` cache (the TTS factory
  builds a fresh provider per request — the heavy model must not be; keying by
  dtype lets the Fast/Best quality toggle swap variants on demand without
  discarding the one already in memory). Loading is forced **fully offline**
  (`@huggingface/transformers` `env.allowRemoteModels = false`,
  `env.localModelPath` → the resources dir, `from_pretrained("kokoro", { dtype,
  device: "cpu" })`). `speak()` splits long text on sentence boundaries
  (`MAX_CHARS = 180`, under Kokoro's ~510-token phoneme limit) and **pipelines**
  generation with playback — it kicks off generation of the *next* chunk before
  playing the current one, so CPU inference overlaps playback instead of stacking
  after it (removes the gaps between sentences). Playback reuses the PowerShell
  `MediaPlayer` pattern from the OpenAI/ElevenLabs providers, with exact duration
  from the raw 24 kHz samples instead of the MP3 byte-estimate hack. `stop()`
  sets a flag (checked between chunks) and kills the current player process.

**Wiring**
- `src/services/tts/interface.ts` — added `case "kokoro"` to the factory
  (lazy `require("./kokoro")`, passes `kokoroVoice` + `Number(kokoroSpeed)` +
  `kokoroQuality`).
- `src/main/settings.ts` — extended `ttsProvider` union to include `"kokoro"`;
  added `kokoroVoice` (default `af_heart`), `kokoroSpeed` (default `1.0`), and
  `kokoroQuality` (`"fast"` | `"best"`, default `"fast"`).
- `src/main/companion.ts` — **no change**; `createTTSProvider()` already routes
  by `ttsProvider` and the spoken text already has POINT tags stripped.

**Model assets + packaging**
- `package.json` — added `kokoro-js` (`^1.2.1`); it pulls in
  `@huggingface/transformers` (which includes the native `onnxruntime-node`
  binary).
- `forge.config.ts` — `extraResource: ["resources/kokoro"]` bundles the model
  folder into packaged builds (lands at `process.resourcesPath/kokoro`, resolved
  the same way `whisper-local.ts` resolves its model). The existing
  `@electron-forge/plugin-auto-unpack-natives` handles the onnxruntime `.node`
  binary.
- `.gitignore` — ignore `resources/kokoro/` (weights downloaded separately, like
  the Whisper binaries). Contents: `config.json`, `tokenizer.json`,
  `tokenizer_config.json`, and **both** ONNX variants —
  `onnx/model_q4.onnx` (~305 MB, the q4 "Fast" variant) and
  `onnx/model_quantized.onnx` (~92 MB, the q8 "Best" variant). The **voices**
  ship inside the `kokoro-js` package itself, so they need no bundling.

**Settings UI — `src/renderer/settings/index.html`**
- New `Kokoro (offline, natural)` option in the Default Voice dropdown.
- New `kokoroGroup` field block, conditionally shown when the voice is Kokoro
  (new `updateTtsUI()` toggle, mirroring `updateProviderUI()`): a voice
  `<select>` with the 28 voices in `<optgroup>`s by accent/gender, a Speed
  slider (0.5×–2×) with a live value label, and a **Quality** select
  (Fast / Best). `kokoroVoice` / `kokoroSpeed` / `kokoroQuality` added to the
  `fields` array so the existing save/load handlers persist them.
- Added a `select optgroup` CSS rule (readable header color + slightly darker
  background) — the browser default rendered the group labels as dark text on
  the dark field, which was unreadable.

**Chat window — `src/renderer/chat/index.html`**
- The quick voice toggle is now 4-state: `off → Kokoro (KOK) → Windows (WIN) →
  OpenAI (AI) → off`, putting the recommended offline voice one click away.
  Load logic recognizes a saved `kokoro` provider (previously any non-OpenAI
  enabled provider was mislabeled "WIN").

**Bug fix (pre-existing)**
- `src/renderer/settings/index.html` — the HIPAA-mode handler targeted a
  non-existent `#ttsProvider` element (would throw); fixed to `#defaultVoice`,
  and it now keeps Kokoro or Windows (both local) rather than always forcing
  Windows.

**Docs**
- `docs/voice-and-tts.md` — added Kokoro (and the previously-missing OpenAI) to
  the TTS providers table, plus a "Using Kokoro (No Cloud)" section with the
  model-download layout and enable steps.
- `AGENTS.md` — added Kokoro to the `tts/` architecture line, an External
  binaries note (bundled model, offline load, singleton), and the offline/HIPAA
  security note.
- `docs/hipaa-mode.md` — TTS row now reads "Local only — Kokoro or Windows SAPI".

**Performance + quality follow-up (same session)**
First live run "lagged a lot". Two root causes, both fixed:
1. **Sequential generate→play→generate stacking.** Benchmarked on a 4-sentence
   reply (11.6 s of audio): old path took **24.2 s** wall (≈2× the audio, with
   gaps between sentences). Pipelining generation with playback (above) cut it
   to **14.9 s** with no gaps — basically audio length + first-chunk latency.
2. **q8 is slow on CPU.** Benchmarked q8 vs q4 on the user's Ryzen 5 3600
   (6c/12t) at steady state (warm-up excluded):

   | dtype | First-word | Gen for ~13 s audio | Realtime factor |
   |-------|-----------|---------------------|-----------------|
   | q8    | ~3.5 s    | 14.4 s              | 1.12× (slower than realtime) |
   | q4    | ~0.8 s    | 3.4 s               | **0.26× (≈4× faster)** |

   Counter-intuitively `model_q4.onnx` is *larger* on disk (305 MB vs 92 MB) but
   hits a much faster compute path. Decision (user): **ship both, add a
   Fast (q4) / Best (q8) quality toggle, default Fast.** With Fast + pipelining,
   first word lands in <1 s and playback is gapless.

**Verification**
- `npx tsc` (emit) and `eslint` on changed files all exit 0.
- Confirmed `kokoro-js` + `@huggingface/transformers` load under CommonJS
  `require` and the native onnxruntime binary initializes.
- **Live end-to-end** (Node probe mirroring `kokoro.ts`): both q4 and q8 load
  fully offline from `resources/kokoro` and `generate(...)` → valid 24 kHz WAV;
  benchmark numbers above measured on the real machine.
- Initial symptom — `Unknown TTS provider: kokoro` at runtime — was the stale
  `dist/` trap (`npm run dev` had loaded a pre-`tsc` build); resolved by running
  `npx tsc`.

**Out of scope (deferred)**
- Warm-up at app startup (load + silent inference when Kokoro is selected) to
  remove the first-reply cold-start. Considered; not done — Fast/q4 made the
  cold start small enough.
- Streaming synthesis (`kokoro-js` offers `stream()` / `TextSplitterStream`);
  the current per-sentence pipelined chunking matches the existing providers'
  approach and is already gapless.
- Non-English voices (the model ships many; the dropdown lists the 28
  English/American/British voices `kokoro-js` v1.2.1 exposes).

### feat/groq-stt — Google Gemini as an LLM provider
**Time:** ~12:07 (local, UTC+3)
**Branch:** `feat/groq-stt` (continued)
**Author:** Claude Code

Added **Google Gemini** as a first-class vision-LLM provider, alongside the
existing Anthropic / OpenAI / OpenRouter options. Fully configurable from the
UI: base URL, API key, model (dynamic dropdown), reasoning, temperature, and a
Test API connection button. Mirrors the existing provider pattern
(`openrouter-chat.ts`) and the Groq STT test-connection / dynamic-model-list
mechanism — no existing behaviour changed (default provider is still Anthropic;
all additions are additive). Uses the official
[`@google/genai`](https://www.npmjs.com/package/@google/genai) SDK.

**New code**
- `src/services/gemini-chat.ts` — `GeminiChatService`. One `query()` call via
  `ai.models.generateContent`, screenshots passed as inline image parts
  (`inlineData` / `image/jpeg`), conversation history mapped to Gemini
  `contents` (`assistant` → `"model"`). Same POINT-tag system prompt as the
  other providers. No second-pass `refinePoint` (that stays Claude-only).
- **Reasoning** is unified behind one dropdown (Default / Off / Low / Medium /
  High). `buildThinkingConfig()` maps it to `thinkingLevel` for Gemini-3 models
  (`/gemini-3/` → MINIMAL/LOW/MEDIUM/HIGH) and to `thinkingBudget` for the 2.5
  series (0 / 1024 / 8192 / 24576). `Default` omits the config entirely.

**Wiring**
- `src/main/settings.ts` — extended `aiProvider` union to include `"gemini"`;
  added `geminiApiKey`, `geminiBaseUrl` (empty = SDK default
  `https://generativelanguage.googleapis.com`), `geminiModel`
  (default `gemini-3.5-flash`), `geminiReasoning` (default `"default"`),
  `geminiTemperature` (default `1`), and two cache fields
  (`geminiModelList`, `geminiModelListFetchedAt`).
- `src/main/companion.ts` — routes `aiProvider === "gemini"` to
  `GeminiChatService` in `getAIProvider()`.
- `package.json` — added `@google/genai` (`^2.8.0`) dependency.

**IPC + preload**
- `src/main/index.ts` — added `fetchGeminiModels` helper (GETs
  `${baseUrl}/v1beta/models?key=…`, keeps models supporting
  `generateContent`, strips the `models/` prefix, pins the default first) and
  the `settings:testGeminiKey` handler (verifies key + caches the list).
- `src/preload/index.ts` — exposed `testGeminiKey` to the renderer.

**Settings UI — `src/renderer/settings/index.html`**
- New Gemini API key field in the API Keys section, and a `Google (Gemini)`
  option in the AI Provider dropdown.
- New `geminiModelGroup`, conditionally shown when the provider is Gemini
  (same `updateProviderUI()` toggle pattern as the other model groups):
  base URL, dynamic model `<select>`, reasoning dropdown, temperature input,
  and a **Test API connection** button with inline ok/error feedback.
- Model dropdown is populated dynamically from the cached list
  (`renderGeminiModelDropdown`, clone of `renderGroqModelDropdown`), with
  `gemini-3.5-flash` pinned first. Test button refreshes it.

**Chat window first-run — `src/renderer/chat/index.html`**
- Added Gemini to the setup wizard: provider option, `key-gemini` field,
  static model list, badge/label handling, load + save logic, and included
  `geminiApiKey` in the "is configured?" check so a Gemini-only user can
  onboard without getting stuck. (Full base-URL / reasoning / temperature /
  test controls live in the Settings panel, consistent with how the other
  providers are handled in the wizard.)

**Docs**
- `CLAUDE.md` — added `gemini-chat.ts` to the architecture diagram and Gemini
  to the `AIProvider` list in the query-flow description.
- `README.md` — added Gemini to the multi-provider feature line and the
  services diagram.
- `SECURITY.md` — added Google Gemini to the "where screenshots go" row.

**Verification**
- `npx tsc` and `eslint` on all changed files both exit 0.
- Live API calls (Test connection, real query) require the user's Gemini key
  and the running GUI, so they were not exercised here.

**Out of scope (deferred)**
- Second-pass POINT refinement for Gemini (Claude-only today).
- Proxy support for Gemini requests (existing proxy is Claude-only).

### feat/groq-stt — Groq Whisper as the default STT provider
**Time:** ~11:35 → 12:01 (local, UTC+3)
**Branch:** `feat/groq-stt` (cut from `master` @ `c935b10`)
**Author:** opencode

Switched the default speech-to-text backend from AssemblyAI to
[Groq's Whisper Large V3 Turbo](https://console.groq.com/docs/speech-text)
endpoint. Groq's OpenAI-compatible STT API is fast, has a generous free
tier, and is the new out-of-the-box recommendation for new users.

**New code**
- `src/services/transcription/groq.ts` — `GroqTranscriptionProvider`.
  Batch transcription via `${baseUrl}/audio/transcriptions` with
  `temperature: 0`, `response_format: "verbose_json"`. Configurable
  `baseUrl` and `model` so a single implementation covers Groq Cloud,
  self-hosted gateways, and future model additions.

**Wiring**
- `src/services/transcription/interface.ts` — added `case "groq"` to the
  provider factory.
- `src/main/audio.ts` — added a Groq branch (with explicit "no API key
  configured" error message) and re-routed the OpenAI/AssemblyAI
  fallback so the old "if you have an OpenAI key, use it" last-resort
  path stays at the bottom.
- `src/main/settings.ts` — added `groqApiKey`, `groqBaseUrl`
  (default `https://api.groq.com/openai/v1`), `groqSttModel`
  (default `whisper-large-v3-turbo`), plus two cache fields
  (`groqSttModelList`, `groqSttModelListFetchedAt`). Default
  `transcriptionProvider` changed from `"assemblyai"` to `"groq"`.

**IPC + preload**
- `src/main/index.ts` — added `fetchGroqModels` helper and two
  handlers: `settings:testGroqKey` (verifies key + refreshes cache
  if stale) and `settings:refreshGroqModelList` (forces a refresh).
- `src/preload/index.ts` — exposed `testGroqKey` and
  `refreshGroqModelList` to the renderer.

**Settings UI — `src/renderer/settings/index.html`**
- New "Speech-to-Text (Groq)" section, conditionally shown only when
  `transcriptionProvider === "groq"` (mirrors the `claudeModelGroup`
  toggle pattern via a new `updateSttProviderUI()`).
- Fields: Groq API key (password), Groq base URL (text, pre-filled
  with the default), Groq model (dynamic `<select>`), Test API Key
  button.
- Model dropdown is populated dynamically from Groq's `/models`
  endpoint filtered to `id.includes("whisper")`, with
  `whisper-large-v3-turbo` always pinned first. An "Updated N days
  ago · click Test to refresh" hint sits underneath.
- **5-day TTL** on the cached model list. Refresh triggers:
  1. Clicking Test API Key (always; if cache is stale, list is
     refetched and the timestamp is bumped).
  2. Opening the settings panel (silent, non-blocking; same TTL
     check).
- Reordered the `transcriptionProvider` `<select>` so Groq is
  first, with "(default · recommended)" tag in the label.
- Added new styles: `.test` button, `.hint` / `.hint.ok` /
  `.hint.error` for the inline result line and model list hint.
- HIPAA toggle still forces `whisper-local` — no change.

**Chat window first-run — `src/renderer/chat/index.html`**
- Added `key-groq` to the optional-keys block. Save handler writes
  `groqApiKey` and auto-selects Groq as the transcription provider
  only when no other STT key is present. The base URL / model /
  test button stay in the full Settings panel (chat is keys-only,
  consistent with how OpenAI/AssemblyAI are handled).

**Docs**
- `docs/voice-and-tts.md` — added Groq to the providers table (top
  row, "default"), added a "Setting Up Groq Whisper" section with
  the API-key flow, free-tier note, base-URL override note, and a
  paragraph on the dynamic model dropdown.
- `docs/getting-started.md` — added Groq to the API keys table.
- `CLAUDE.md` — updated the architecture diagram and the audio
  pipeline description to list Groq as a transcription option.
- `README.md` — added Groq to the Setup keys list and the Voice
  Input features list.

**Out of scope (deferred)**
- Streaming/partial transcripts from Groq (no realtime STT endpoint
  on Groq side — batch only, same as OpenAI Whisper).
- Proxy support for Groq requests (existing proxy is Claude-only).
- Broader STT model-family filter (currently `id.includes("whisper")`
  — covers everything Groq lists today).

### Lint cleanup
**Time:** ~12:01 (local, UTC+3)
**Branch:** `feat/groq-stt` (continued)

`npm run lint` was broken on `master` — the repo had
`@typescript-eslint` packages installed but no ESLint config file at
all, so ESLint 9's "couldn't find an eslint.config" error tripped
immediately. Fixed it on this branch so the lint gate is meaningful
going forward.

- **`eslint.config.js`** (new) — ESLint 9 flat config using
  `FlatCompat` from `@eslint/eslintrc` to extend
  `plugin:@typescript-eslint/recommended`. Ignores `dist/`, `out/`,
  `node_modules/`, `.webpack/`, `release/`, `*.d.ts`.
- **`package.json`** — dropped the deprecated `--ext .ts,.tsx` flag
  from the `lint` and `lint:fix` scripts (ESLint v9 removed it; the
  config's `files` patterns handle file selection now).
- **`src/services/transcription/interface.ts`** and
  **`src/services/tts/interface.ts`** — file-level
  `/* eslint-disable @typescript-eslint/no-require-imports */`
  since both files use `require()` deliberately for lazy provider
  loading (unchanged behaviour, just ESLint-quiet).
- **`src/main/audio.ts`** — per-line
  `// eslint-disable-next-line @typescript-eslint/no-require-imports`
  for the new Groq `require()`.
- **`src/main/companion.ts`** — removed pre-existing dead var
  `ttsProv` (assigned, never used).
- **`src/main/index.ts`** — removed pre-existing dead var `tray`
  (assigned, never used).

`npm run lint` and `npm run typecheck` both exit 0 after these
changes.
