# NEXT — Phase 2: true speech-gated step advancement

Follow-up to `feat/overlay-numbered-map` (the Numbered Map overlay). Ship this as
a **separate PR** on its own branch off `develop`.

## Why

Phase 1 advances the numbered map on a **reading-time estimate** — each step is
held for `max(reveal time, words × CAP_MS_PER_WORD, 1400 ms)`, capped at 9 s
(see `mapArmDwell` in `src/renderer/overlay/index.html`). That's only an
approximation. When TTS is on, the request was "the next pointer appears only
when the current one is **100 % finished**" — i.e. when its words have actually
been *spoken*, not when a guess says they should be.

Phase 2 makes a step advance the moment that step's speech finishes playing, and
keeps the estimate as a fallback (TTS off, synthesis error, or the alignment is
unknown).

## The core problem: points and speech are extracted on separate tracks

In `src/main/companion.ts` `processQuery`, the streamed reply feeds **two
independent** consumers in `onDelta`:

- `IncrementalPointExtractor` → emits each `[POINT:…]` tag (now with its lead-in
  `text`). This is what drives the badges/steps.
- `IncrementalSentenceExtractor` → strips POINT tags and emits **sentences**,
  which are handed to `TTSQueue.enqueue` one at a time.

So there is no existing link between "step N" and "the sentences that belong to
step N." Phase 2 has to create that link and surface a per-step "spoken" signal.
`TTSQueue.whenIdle()` (`src/services/tts/queue.ts`) only resolves when **all**
audio is done — too coarse.

## Approach: boundary markers through the TTS queue

Insert a lightweight, no-audio **marker** into the playback order at each point
boundary. When playback *crosses* a marker, fire a callback — that's the moment
step N's speech has finished and step N+1 can light up.

### 1. `src/services/tts/queue.ts` — add markers to both playback paths

`TTSQueue` has two paths (see the class): a **pipelined** path (`this.texts`
array, `pump()`) for providers that implement `synthesize()` (e.g. Kokoro), and
a **sequential** path (`this.chain` promise) for everyone else. A marker must be
honored in playback order on **both**.

- Add an `onMarker?: (id: string) => void` constructor option (or a setter).
- Add `enqueueMarker(id: string): void`:
  - **Pipelined path:** push a sentinel into `this.texts` instead of a string —
    e.g. wrap items so the queue holds `{ kind: 'text', text }` or
    `{ kind: 'marker', id }`. In `pump()`, when the shifted item is a marker,
    **don't** call `synthesize()/play()`; just invoke `onMarker(id)` and continue.
    Markers must not break the "generate one ahead" prefetch — only `text`
    items are prefetched; a marker is a zero-cost step.
  - **Sequential path:** chain the callback so it runs *after* the previous
    `speak()` resolves: `this.chain = this.chain.then(() => { if (!this.cancelled) onMarker(id); })`.
    (No `seqActive++`, so it doesn't affect `isIdle()`.)
- `cancel()` must drop pending markers too (it already resets `this.texts` and
  `this.chain`); make sure no marker fires after cancel.
- Keep `whenIdle()`/`isIdle()` semantics unchanged — markers are not "active
  audio," so they must not keep the queue from reaching idle.

> Watch the existing footgun comment in `pump()`: it prefetches the *next* text
> while the current plays. With markers interleaved, only prefetch past markers
> to the next real text, and fire any marker(s) you skip over **in order** at the
> right playback moment (i.e. after the current clip finishes, before the next).

### 2. `src/main/companion.ts` — map sentences→steps and enqueue markers

Today each completed sentence is enqueued as it streams. To know *which* step a
sentence belongs to, track the current step while feeding the sentence extractor.

Two workable options — pick the simpler that holds up:

- **(a) Tag-position split (preferred).** The point's lead-in `text` already
  comes from `IncrementalPointExtractor`. Extend the same idea so the orchestrator
  knows, for each emitted sentence, whether a point boundary fell before it. In
  practice: when a `raw` point is emitted for `id`, remember it; the **next**
  `enqueueMarker(prevId)` is placed right before the sentences that follow that
  tag. Concretely, enqueue a marker for step N at the moment step N+1's tag is
  seen (the prose up to N+1 belongs to N).
- **(b) Coarser fallback.** If precise alignment is fragile, enqueue a marker
  after the last sentence that contained/preceded each tag. Approximate but still
  far better than the global estimate.

Wire `new TTSQueue(this.settings, { onMarker: (id) => { if (!session.cancelled) this.pointSpoken(id); } })`
and add a small `pointSpoken(id)` that does
`this.notifyAll("overlay:point-spoken", { id })`. Gate on `session.cancelled`
like the other late callbacks (e.g. the `whenIdle().then(...)` that emits
`companion:speaking-ended`).

Note the alignment is inherently approximate (sentences are split independently
of tags), so the overlay must keep the estimate as a backstop — never hang a
step waiting for a marker that never comes.

### 3. `src/preload/index.ts` — expose the new channel

Add `onPointSpoken(cb: (data: { id: string }) => void)` subscribing to
`overlay:point-spoken`, mirroring the existing `onSpeakingEnded` wiring.

### 4. `src/renderer/overlay/index.html` — prefer the spoken signal

In the map engine, advancement is driven by `mapArmDwell()` →
`setTimeout(mapAdvance, dwellMs)`. Phase 2:

- Keep `mapArmDwell` as the **fallback** timer (rename intent: it's now a
  backstop, not the primary clock).
- Add `window.clicky.onPointSpoken(({ id }) => { if (id === mapActiveId) mapAdvance(); })`.
  `mapAdvance()` already clears `mapAdvanceTimer` at the top, so whichever fires
  first (marker or fallback) wins and the other is cancelled — no double-advance.
- Only honor the signal when TTS is actually producing audio. With TTS off, no
  markers arrive and the fallback timer drives the walk exactly as in Phase 1.
  (Safe by construction: `onPointSpoken` simply never fires when TTS is off.)
- Guard against a stale marker from a superseded query: ignore it unless
  `mapOwnsPill && id === mapActiveId` and the id is still in `mapPoints`.

## Edge cases to cover

- **Estimate vs marker race** — `mapAdvance` clearing its own timer already makes
  this safe; verify a marker arriving *after* the fallback already advanced is a
  no-op (`id !== mapActiveId`).
- **Marker for a step that was never shown** (alignment drift / dropped point) —
  ignore if `id` isn't the active step; the fallback keeps the walk moving.
- **Query superseded mid-speech** — `TTSQueue.cancel()` drops pending markers;
  overlay `reset` clears `mapActiveId`, so a late marker is ignored.
- **Last step** — the final step's marker (or fallback) reaches `mapAdvance`,
  finds no next point; with `mapStreamEnded` it calls `mapFinish()`. Confirm the
  pill lingers `CAP_LINGER` after the *voice* ends, not before.
- **`companion:speaking-ended`** still fires once at the very end (global); it's
  independent of per-step markers and need not change.

## Verification

- `npx tsc` clean.
- Unit-test `TTSQueue` marker ordering on **both** paths: enqueue
  `text, marker(a), text, marker(b)` and assert `onMarker` fires after the
  correct clip, in order, and never after `cancel()`. Use a fake provider
  (resolve `synthesize`/`speak` on a tick).
- `npm run dev` with TTS **on** (Kokoro = pipelined; an API TTS = sequential):
  ask a 3-step question and confirm each badge advances exactly when its
  sentence finishes speaking — not on a fixed timer.
- TTS **off**: behavior is identical to Phase 1 (estimate-driven).
- Add a `docs/ADDITIONS.md` entry.
