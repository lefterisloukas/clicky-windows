# Additions Log

Chronological record of features, fixes, and changes added to the project.
Each entry is dated and time-stamped (local time, `Europe/Istanbul` / UTC+3
unless otherwise noted). Newest entries go at the top.

---

## 2026-06-21

### feat/overlay-numbered-map — PR #7 review fixes (pill migrates across monitors)
**Branch:** `feat/overlay-numbered-map`
**Components:** `src/renderer/overlay/index.html`

Three follow-ups from the PR #7 review:

- **Caption pill now migrates across monitors.** Previously the pill anchored on
  the cursor's display at reveal time and froze there — moving the mouse to
  another monitor left it stranded. A new per-window `capOwner` flag tracks which
  display currently shows the pill; in the `overlay:companion-anchor` handler, the
  display the cursor moves *onto* takes over the pill (jumping straight to the
  fully-revealed text so it stays in sync with the voice rather than replaying the
  typewriter), and the display it leaves hides and releases it (dropping its anchor
  so a later delta can't re-show a hidden pill). Only active while following (the
  tray toggle); pinned mode never migrates. `maybeFinish` now gates the
  "don't fade mid-type" wait on `capOwner` (not `capAnchor`), and `fadeAll` clears
  `capActive`/`capOwner` up front so a mouse move into another display can't
  re-acquire a pill that's already fading.
- **TTS-on hang backstop padded.** The estimate-based `fallbackTimer` is now padded
  by `VOICE_HANG_PAD` (10 s) when TTS is on, so it acts purely as a backstop for a
  dropped `companion:speaking-ended` and can never preempt speech that started late;
  with TTS off it remains the tight estimate that drives the absorb hold.
- **Dropped dead `voiceStarted` state** — it was set and reset but never read
  (`revealStarted` already guards `beginReveal`).

### feat/overlay-numbered-map — caption pill follows the cursor (tray toggle)
**Branch:** `feat/overlay-numbered-map`
**Components:** `src/main/settings.ts`, `src/main/tray.ts`, `src/main/index.ts`,
`src/renderer/overlay/index.html`

The caption pill anchored once and stayed put. It now **follows the cursor by
default**, with a tray menu checkbox **"Caption follows cursor"** that, when
unchecked, restores the anchored-once behavior.

No new cursor feed was needed: `overlay:companion-anchor` already streams the live
cursor position every 16 ms (`startCursorBuddy`); the pill simply never re-read it.

- New setting `overlayCaptionFollowCursor` (default `true`).
- `tray.ts` takes the `SettingsStore` and adds a `checkbox` item reading/writing
  it (the tray is the only writer, so Electron's checkbox state stays in sync
  without a rebuild).
- Overlay caches `captionFollow` (with `capEnabled`/`ttsOn`); in the existing
  `onCompanionAnchor` handler it updates `capAnchor` + `captionPlace()` each tick
  while a caption is live and following. The `#response` `left/top` transition was
  shortened to `0.15s` so following glides instead of jittering. Off → `capAnchor`
  is never updated after `beginReveal`, so the pill stays put.
- Read at the next query's `stream-start` (cached), like `overlayCaptionEnabled`.
  Badges always stay anchored to their elements, in both modes.

### feat/overlay-numbered-map — lock the "cursor pill + numbered constellation" behavior
**Branch:** `feat/overlay-numbered-map`
**Components:** `src/renderer/overlay/index.html`, `src/services/incremental.ts`,
`src/services/prompt.ts`, `src/main/companion.ts`, `src/preload/index.ts`,
`src/main/settings.ts`, `src/renderer/settings/index.html`

Replaces the numbered-map **walk** (badges advancing one-at-a-time on a
reading-time dwell, the pill riding the active badge with per-point text). In
practice the caption reveal and the voice never stayed in sync — text streamed at
pill 3 while the voice was on pill 1 — because there is no reliable per-sentence
voice timing. After product exploration we locked a simpler, sync-proof behavior
and **removed the now-dead machinery**.

**Hard rule:** the caption is ONE block in ONE place (anchored once at the cursor,
full reply, never relocates/re-segments); pointers all appear together; the only
timed events are reveal (voice-start) and fade (voice-end + hold).

**Locked behavior**
- **No pointer:** full reply in a pill at the cursor.
- **One pointer:** plain dot + short label chip on the element, + the cursor pill.
- **Multiple:** numbered dots (each with a label chip) that **cascade in** (~500 ms
  apart — a quick entrance, not a voice-paced walk), + the cursor pill.
- **Shared:** reveal gated on `companion:speaking-started` (TTS off begins promptly,
  with a 4 s backstop for the 0-point / voice-error case); after the voice ends (or
  a word-count estimate when TTS is off) hold an absorb buffer — **5000 ms for ≥2
  points, else 1500 ms** — then the pill and all badges fade together. New query
  resets instantly.

**Numbering:** plain dot for a single pointer, global step number for ≥2. Driven by
a new `overlay:point-count` broadcast (`companion.ts` → `preload onPointCount` →
overlay `applyNumbering`): each overlay window only sees its own display's points,
so the global total must come from the main process. Multi-monitor numbers stay
globally sequential (e.g. screen A shows 1, 3; screen B shows 2).

**Removals (dead under the lock):**
- `IncrementalPointExtractor` reverted to `push(): RawPointTag[]` (dropped the
  per-point lead-in `text` + `sinceTag`); `ExtractedPoint` deleted.
- `prompt.ts` reverted to inline-anywhere tag placement (the end-of-sentence
  contract only mattered for per-point text, which is gone).
- `overlay:point` payload dropped `text` (keeps `index`).
- The **legacy walking-dot** path and the **`overlayNumberedMap`** setting/toggle
  removed — the constellation is the only pointer behavior. `overlayCaptionEnabled`
  (pill text on/off) stays.

**Overlay engine:** the per-step walk (`mapAdvance`/`mapShowChunk`/`mapArmDwell`/
`mapFinish`/dwell state) and the legacy dot are gone. The caption now always
anchors at the cursor (reusing the typewriter/placement/flip mechanics) and a small
**constellation module** (`makeBadge`/`scheduleReveal` reveal-on-arrival-with-min-gap/
`applyNumbering`/`beginReveal`/`finishAll`/`resetAll`) renders the badges. A single
`finishAll(holdMs)` funnel (gated on caption-reveal-done so a fast voice can't fade
text mid-type) fades pill + badges together; a `token` guards the post-fade clear so
a superseded query can't wipe the next answer's badges.
**Branch:** `feat/overlay-numbered-map`
**Components:** `src/services/tts/queue.ts`, `src/main/companion.ts`,
`src/preload/index.ts`, `src/renderer/overlay/index.html`

The numbered map advanced on a pure time estimate, independent of TTS. In
practice the badges raced ahead while TTS was still spinning up the first
sentence — the voice for step 1 could begin only as the *last* badge was
showing. The dominant cause was startup latency, not pacing: the walk began the
instant points streamed in, seconds before any audio was audible.

Interim fix (not full Phase 2): **gate the first reveal on the voice actually
starting.**
- `TTSQueue` gained an optional `onFirstPlay` constructor callback, fired exactly
  once the first clip begins playing — hooked into both the pipelined `pump()`
  (before `synth.play()`) and the sequential `chain` (before `speak()`).
- `companion.ts` passes it, broadcasting `companion:speaking-started` (gated on
  `!session.cancelled`).
- `preload` exposes `onSpeakingStarted`.
- The overlay holds the first `mapAdvance()` until that signal (new `startWalk`):
  it starts at once if speech has already begun or TTS is off (`mapTtsOn`,
  cached from `ttsEnabled`), otherwise waits, with `MAP_START_FALLBACK` (4 s) as
  a backstop if no voice signal ever arrives (e.g. a TTS error). All gate state
  (`mapStarted`, `mapVoiceStarted`, `mapStartTimer`) resets in `mapReset`.

Once aligned at the start, the existing `words × CAP_MS_PER_WORD` dwell keeps
later steps roughly tracking speech. This is the start-alignment slice; true
per-step speech gating remains Phase 2 (`NEXT.md`), and the `onFirstPlay` hook is
a reusable step toward it.

### feat/overlay-numbered-map — move POINT tags to end-of-sentence (prompt↔parser contract)
**Branch:** `feat/overlay-numbered-map`
**Components:** `src/services/prompt.ts`, `src/services/incremental.ts` (doc only)

⚠️ **Surgical / critical — read before touching either file.** This couples the
shared system prompt to the point-text parser. They must change together.

**Why.** The numbered map shows each step's text beside its pointer. That text
comes from `IncrementalPointExtractor`, which assigns each tag "the prose since
the previous tag." The prompt, however, taught the model to embed tags
*mid-sentence* (`...click the "Share" button [POINT…] in the top right corner.`),
so the per-step text came out fragmented: step 1 lost "in the top right corner"
and step 2 inherited that orphan clause; a trailing clause after the last tag was
dropped entirely. Observed live on Gemini with a Trello "share / add list / add
card" query.

**Decision.** Fix it prompt-side, not parser-side. We considered a sentence-aware
parser (robust to any placement) but it adds ~40 lines of streaming
sentence-segmentation. Since the model's tag placement is something we control
via the prompt, and the existing lead-in extractor already yields a whole
sentence *when the tag sits at the sentence end*, the cheaper, equally-correct fix
is to require that placement. The coordinate space is unchanged (coords live in
the tag regardless of position), so pointing accuracy is unaffected. The
sentence-aware parser stays in reserve if a model proves non-compliant.

**Change.** `prompt.ts` now requires each element's POINT tag at the **end** of
its sentence (after the closing punctuation), one sentence = one step = one tag:
- New "Tag placement" section + rewritten rule 3 & 4 (was "tags can appear inline
  anywhere").
- All worked examples moved to end-of-sentence; added a multi-step example.
- Counter-example added for the mid-sentence mistake; the old "correct" example
  (which itself showed an inline tag) fixed to end-of-sentence.
- New pre-send checklist item: each tag at the end of its sentence.

`incremental.ts` is unchanged in behavior — only a CONTRACT note added on
`ExtractedPoint` documenting that the lead-in text reads as a whole instruction
**only** because the prompt guarantees end-of-sentence placement.

**Verification.** `npx tsc` clean. Live: re-run a multi-step query and confirm
each step's pill shows one complete sentence (no orphan leading clause, no dropped
trailing clause). If a provider slips a tag mid-sentence, that one step will
fragment — the signal to revive the sentence-aware parser.

### feat/overlay-numbered-map — guide multi-point answers one step at a time
**Branch:** `feat/overlay-numbered-map`
**Components:** `src/services/incremental.ts`, `src/main/companion.ts`,
`src/preload/index.ts`, `src/main/settings.ts`,
`src/renderer/settings/index.html`, `src/renderer/overlay/index.html`

When the model pointed at 2–3 UI elements in one answer, the overlay split the
user's attention: a single blue dot walked points 1→2→3 on a blind 2-second
timer while the text pill anchored once to point 1 and streamed the whole reply
there — so the full answer sat at point 1 while the dot was already at point 3.

The new **Numbered Map** replaces that choreography. Every point gets a
persistent numbered badge (①②③) that stays on screen as a route map; exactly one
badge glows at a time, covered steps dim into a "done" trail, and the pill rides
the **active** badge showing only **that step's** text — so words and the
highlighted target are always co-located. Steps advance sequentially, never
before the current one has been read.

**How it works**
- **Per-point text.** `IncrementalPointExtractor.push` now returns
  `{ tag, text }[]`, where `text` is the prose that preceded each tag (its
  lead-in narration). A `sinceTag` accumulator carries settled prose across
  pushes so a point's lead-in survives the bounded-buffer trim, and the bytes of
  a tag split across network chunks are never mistaken for prose.
- **Numbering.** `companion.ts` assigns a query-local 1-based `index` to each
  rendered point and sends `index` + `text` on the `overlay:point` payload
  (`refine` carries `index` only). Numbering is assigned centrally so it stays
  globally sequential across monitors (each overlay window sees only its own
  display's subset).
- **Renderer.** `overlay/index.html` gains a `#badges` layer and a `mapOnPoint`
  /`mapAdvance` engine. The shared `#response` pill is reused per-step by setting
  the `cap*` state and calling the existing `captionRender/Place/Show/StartTyping`
  helpers; `captionMaybeFinish` early-returns while `mapOwnsPill`, so only
  `mapFinish` hides the pill (at the end of the walk, not between steps).
- **Advancement (phased).** A step is held for a reading-time estimate
  (`max(reveal time, words × CAP_MS_PER_WORD, 1400 ms)`, capped at 9 s), so the
  next pointer never appears before the current step is read. *Phase 2 (separate
  PR)* will gate on true speech-finished via per-step markers through the TTS
  queue.
- **Trail lifecycle.** The badge map stays up while you work through it, then
  auto-clears: the pill fades `CAP_LINGER` (1.5 s) after the last step, and the
  badges fade out `MAP_CLEAR_AFTER` (10 s) after the walk ends (`mapFinish`).
  Two cancellable timers (`mapClearTimer` wait, `mapRemoveTimer` fade) back this
  so a new query's `mapReset` wipes the trail instantly and a pending clear can
  never erase the next answer's badges.

**Setting.** New `overlayNumberedMap` toggle (default **on**), shown in settings
as "Numbered steps". The existing `overlayCaptionEnabled` stays the master
"show any pill text" switch — captions off + map on gives a silent numbered
trail. Toggling off restores the legacy walking-dot choreography (kept intact as
a fallback). The flag is read at each query's stream-start.

**Edge cases handled.** Zero-point answers fall back to the cursor-anchored full
caption (decided at stream-end so a sentence of preamble before the first point
doesn't trigger it early); single-point answers show one badge + pill; refine
nudges the badge (and the pill if it's the active step); a superseded query's
reset clears badges, timers, and the pill; `prefers-reduced-motion` drops the
glow/pulse and reveals text instantly while still honoring the read dwell.

### fix/forgotten-fixes — apply leftover PR #1 review fixes
**Branch:** `fix/forgotten-fixes`
**Components:** `src/main/index.ts`, `src/services/gemini-chat.ts`,
`src/renderer/chat/index.html`, `src/renderer/settings/index.html`

A set of post-review fixes from `feat/single-settings-surface` that did not make
it into `develop` when the settings popover was first merged. Intentionally
excluded: the `audio.ts` logging change (full transcript content is kept for
debugging) and the `companion.ts` optimistic history push (the current
`develop` implementation already avoids the dangling-user-turn problem by
pushing after a successful query).

- **Gemini history turn matching by index** (`src/services/gemini-chat.ts`).
  The current turn was matched by `entry.content === params.transcript`, which
  attached screenshots to the wrong message when the user sent the same text
  twice. Now matches by index (`i === lastIdx`).
- **baseUrl scheme validation** (`src/main/index.ts`). The Groq/Gemini base URL
  passed from the renderer was forwarded to `fetch()` without validation. It now
  rejects non-`https://` schemes before any network call (SSRF guard).
- **Popover size saved on explicit close only** (`src/main/index.ts`).
  `popoverWidth`/`popoverHeight` were persisted on every blur event; now they
  save only when the popover is explicitly closed.
- **Removed duplicate IPC handler** (`src/main/index.ts`). The
  `settings:testGroqKey` and `settings:refreshGroqModelList` handlers were
  identical; extracted to a shared helper.
- **First-run CTA hidden state** (`src/renderer/chat/index.html`). `#setup-cta`
  had `class="hidden"` and inline `style="display:flex"` but no matching
  `.hidden` rule, so the CTA was permanently visible. Added the missing rule.
- **Kokoro speed slider debounced** (`src/renderer/settings/index.html`). The
  slider called `save()` (IPC + disk write) on every `input` event; it now
  updates the label on `input` and persists only on `change`.

---

## 2026-06-20

### feat/overlay-response-caption — stream the reply near the cursor (the "Companion Pill")
**Time:** ~ (local, UTC+3)
**Branch:** `feat/overlay-response-caption`
**Components:** `src/renderer/overlay/index.html` (primary),
`src/services/tts/queue.ts`, `src/main/companion.ts`, `src/preload/index.ts`,
`src/main/settings.ts`, `src/renderer/settings/index.html`

Until now the model's reply surfaced only in the chat window (full text) and via
TTS voice; the transparent overlay showed just the animated cursor dot and a tiny
per-POINT *label* (the element name). This adds a streaming **response caption** —
a glass "Companion Pill" that reveals the full answer letter-by-letter near the
cursor, roughly in step with the voice, so the user never has to look away to the
chat window.

**Design**
Picked from a 3-way design exploration (pill vs. karaoke subtitle vs. ink-pour).
The pill reuses the existing overlay identity — dark glass with a cyan-tinted
border (`#22D3EE`), matching the companion capsule.

**How it works**
- The reply reaches the overlay via the existing `chat:stream-start/delta/end`
  broadcast to every window (`CompanionManager.notifyAll`), bridged through
  preload. The overlay listens to the same stream the chat window does.
- POINT tags are stripped with the same logic as `chat/index.html`
  (`stripPointTags`), kept in sync as the source of truth.
- A **catch-up typewriter** (`CAP_CHAR_INTERVAL`, ~14 cps) decouples bursty
  network deltas from a smooth, steady reveal with a blinking caret.
- Voice-synced timing is provided by a new `companion:speaking-ended` signal:
  `TTSQueue.whenIdle()` resolves once playback fully drains, `companion.ts`
  broadcasts the event off the critical path, and the overlay holds the pill
  until the voice ends.
- The caption **anchors once per reply**: to the first POINT tag (and rides that
  point's pass-2 refinement), or — if the answer points at nothing — near the
  real mouse cursor, using the `overlay:companion-anchor` position the overlay
  already tracks. A ~400 ms grace window lets a point win over the cursor.
- The existing per-point `#label` is untouched and keeps hopping with the dot.
- Edge-aware placement flips the pill left/above to stay on-screen.
- Respects `prefers-reduced-motion` (instant text, no caret/scale).

**Setting**
New `overlayCaptionEnabled` (default **ON**) with a "Response caption" toggle in
the settings popover, mirroring the cursor-buddy glow toggle. The overlay reads
it via `getSettings()` and refreshes on each stream-start.

**Known limitation**
Renderer-only overlays can't coordinate across monitors. On a multi-monitor
setup, if an answer's POINT lands on a screen that doesn't hold the cursor while
the cursor's screen takes the no-point fallback, the pill can briefly appear on
two screens. Harmless and rare; the robust fix (a main-routed, per-display
`overlay:caption` channel) was deferred.

**Follow-up — timing + overlap fix**
Live testing surfaced two issues, both now fixed:
- *Caption vanished mid-speech and revealed too fast.* The reveal was ~45 cps and
  the pill hid on a timer keyed to the *text reveal*, which finishes near
  generation end while TTS audio plays on (especially local Kokoro on CPU). Added
  a real **`companion:speaking-ended`** signal: `TTSQueue.whenIdle()` resolves
  once playback fully drains (both the pipelined and sequential paths), `companion.ts`
  awaits it off the critical path after the final sentence is enqueued and
  broadcasts the event, and the overlay holds the pill until the *voice* ends,
  then lingers ~1.5 s. Reveal slowed to ~14 cps (reading pace). When TTS is off or
  errors (no signal), an estimated-speech-duration fallback hides the pill so it
  can't hang. Gated on `!session.cancelled` so a superseded query stays silent.
- *The per-point label and the response pill overlapped at the first element.*
  Switched to a **unified card**: the pointed element's name becomes a small
  header inside the pill (reply streams below), and the floating `#label` is
  suppressed only at the caption's anchor point. Later points (step 2, 3…) keep
  their hopping label unchanged.

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

**Follow-up — CPU saturation during Kokoro generation**
After the playback fix, the machine still stuttered during multi-sentence
replies. Root cause: onnxruntime-node defaults its CPU execution provider to one
intra-op thread *per logical core* (12+ here), so each sentence's inference
pegged every core — and because generation is pipelined with playback, that
saturation was near-continuous. kokoro-js doesn't forward `session_options`
through `from_pretrained`, so we cap the intra-op pool to half the cores by
wrapping the shared `InferenceSession.create` that transformers.js calls (same
onnxruntime-node instance — verified). The wrap is idempotent and fail-safe: if
a future dependency upgrade changes how ORT is loaded, it silently no-ops back
to the default thread count rather than breaking. q4 inference is
memory-bandwidth bound, so the cap costs little speed while leaving headroom for
the OS and UI.

**Follow-up 2 — generation moved off the main process (the actual lag fix)**
The thread cap reduced CPU load but the UI still janked. Measuring with an
event-loop probe pinned the real cause: Kokoro's work (phonemization + ONNX
inference + WAV encoding) ran *in the Electron main process* and blocked its
event loop ~190 ms per sentence, stalling overlay/chat IPC — the felt "lag at
the start of each sentence." It was never raw CPU saturation (CPU only hit
50–70%); it was heavy synchronous work on the UI thread.

Fix: a new `src/services/tts/kokoro-worker.ts` runs the entire model in a Node
`worker_thread`. `kokoro.ts` now only posts text and awaits finished WAV bytes
(transferred zero-copy), so the main thread never stalls. The thread cap moved
into the worker (where ORT now loads); the per-sentence WAV write is now async.
The model lives only in the worker (~305 MB out of the main process). Measured
with the compiled worker: main-thread event-loop lag dropped from **188 ms to
14 ms**, generation unchanged at ~1 s/sentence.

Note: in dev (`npm run dev`) the worker loads from `dist/`. For packaged builds,
confirm `worker_threads` can load the entry from the asar archive (Electron
supports this in recent versions, but it's worth a smoke test before release).

**Follow-up 3 — pipeline generation across sentences (the inter-sentence gap)**
With the freeze gone, a ~1s delay before each *next* sentence remained. Cause:
`TTSQueue` chained `speak()` one sentence at a time, awaiting generation *and*
playback before starting the next — and since each sentence is a single chunk,
the existing within-`speak()` pipelining never engaged. So every sentence's ~1s
generation happened during the silence after the previous one finished.

Fix: an optional `synthesize()` capability on the provider interface
(`PipelinedTTSProvider`) that splits synthesis from playback. `TTSQueue` now
detects it and runs a prefetch-by-one pump: it generates sentence N+1 *while*
sentence N is still playing, keeping playback strictly sequential. Kokoro
implements `synthesize()`; the other providers are untouched and keep the old
sequential `speak()` path. Measured (real worker generation, playback simulated
at true clip duration): max inter-sentence silence dropped from **1323 ms to
0 ms**.

**Verification**
- `npx tsc` exits 0.
- Standalone worker benchmark: main-thread event-loop lag 14 ms (was 188 ms).
- Pipeline benchmark: inter-sentence silence 0 ms (was 1323 ms).

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
