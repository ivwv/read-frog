---
"@read-frog/extension": patch
---

fix(subtitles): harden dubbing against ads, voice changes, and engine failures

- Dubbing now goes silent while a YouTube ad plays instead of reading the main
  video's cues against the ad's timeline, and resumes from the main clock when
  the ad ends.
- Cached dubbing clips are keyed by the synthesis inputs (engine, model, voice,
  style prompt, format), so switching the engine or voice no longer keeps
  speaking clips synthesized with the old one. Audio already synthesized is
  reused as later translation batches arrive, instead of being discarded and
  re-requested.
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
  rather than sitting silent until the cue window passes. Its bytes are dropped
  with it: leaving them cached made the next tick build another element from the
  same undecodable payload, four times a second, which is what crashed the video
  page while dubbing played.
- Dubbing releases each audio element when it is done with it — on completion, on
  failure, and on teardown — instead of leaving its decoded buffer and its copy of
  the data URL for the collector. Releasing no longer assigns an empty `src`,
  which resolves against the document and makes the browser report an `error` for
  a clip that had played fine.
- Cache eviction drops by distance from the playhead rather than strictly by
  cue end, so a backward seek keeps the cues it is about to reach.
- Dubbing decodes each clip once into a blob URL and plays from that, instead of
  caching base64 and rebuilding a `data:` URL on every play. That removes a second
  full copy of every clip and the base64 re-parse per play; the blob is handed back
  when its entry leaves the cache.
- Read-aloud clips are now held to a byte budget. Its cache had no ceiling at all,
  so a long selection kept one clip per chunk resident for ten minutes — a single
  two-minute chunk of MiMo WAV is about 7.7 MB of base64, and a dozen chunks is
  already tens of megabytes of page heap.
- The MiMo settings page states that the API key is sent to the configured base
  URL, and the stale credential-comment left from before the key was blanked is
  removed.
