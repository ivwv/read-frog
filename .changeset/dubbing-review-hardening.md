---
"@read-frog/extension": patch
---

fix(subtitles): harden dubbing against ads, voice changes, and engine failures

- Dubbing now goes silent while a YouTube ad plays instead of reading the main
  video's cues against the ad's timeline, and resumes from the main clock when
  the ad ends.
- Cached dubbing clips are keyed by the synthesis inputs (engine, model, voice,
  style prompt, format), so switching the engine or voice no longer keeps
  speaking clips synthesized with the old one.
- The user's per-language voice mapping from the TTS settings is honored by
  dubbing, matching the selection toolbar's read-aloud.
- MiMo TTS gets a wider synthesis concurrency window than Edge: its round trips
  take seconds, and Edge's tighter budget — tuned to avoid rate limiting — made
  dubbing fall permanently behind on longer videos.
- MiMo TTS retries transient failures (429, 5xx, timeout) once with a short
  backoff, consuming the `retryable` flag it already reported.
- A dubbing failure streak now surfaces as a hint on the dubbing switch in the
  player settings panel, in all ten UI languages, instead of failing silently.
- A clip that fails to decode releases its element and marks the cue for retry
  rather than sitting silent until the cue window passes.
- Cache eviction drops by distance from the playhead rather than strictly by
  cue end, so a backward seek keeps the cues it is about to reach.
- The MiMo settings page states that the API key is sent to the configured base
  URL, and the stale credential-comment left from before the key was blanked is
  removed.
