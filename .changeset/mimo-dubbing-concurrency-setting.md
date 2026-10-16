---
"@read-frog/extension": patch
---

feat(tts): make MiMo dubbing concurrency a setting

MiMo's dubbing concurrency was a fixed constant, but throughput is
`concurrency / latency`, so the budget that keeps up at 1x falls behind at 2x-4x
and the dubbing starts skipping sentences. The Text to speech settings page now
has a Dubbing concurrency slider (1-8, default 4) for the MiMo engine, and
MiMo's prefetch window scales with the video's playback rate as well, so a
faster video prepares proportionally more cues ahead of the playhead.

The value is clamped on both read and write: a record written before the field
existed, or a hand-edited one, cannot turn into an unbounded request burst
against the user's own paid endpoint. Edge TTS keeps its own lower budget,
which exists to stay under its rate limiter, and the slider does not affect it.
