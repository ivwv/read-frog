---
"@read-frog/extension": patch
---

fix(subtitles): keep the original audio playing until subtitle dubbing actually speaks, and bound its audio cache

The dubbing scheduler used to mute the video the moment it was enabled, before
the translation pipeline had produced anything. On a page reload that was heard
as a second or two of the original audio, a cut, and then silence until the
first cue was both translated and synthesized. The video's own audio now stays
audible until the first cue's audio really starts, the scheduler is armed before
the subtitle fetch instead of after it, and a fresh translation triggers a pass
immediately rather than waiting for the next `timeupdate`.

Synthesized clips were also kept for the whole session, so a long video grew the
in-memory cache without limit — hundreds of megabytes on a multi-hour video, and
more with a WAV-format engine. Cached audio is now bounded by both entry count
and resident bytes, with cues that ended well behind the playhead evicted first.
A cue whose synthesis fails transiently is retried after a short window instead
of being silenced for the rest of the video, prefetch concurrency is capped to
avoid tripping rate limits, and unchanged dubbing state no longer re-renders the
settings panel on every tick.
