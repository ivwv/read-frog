---
"@read-frog/extension": patch
---

feat(subtitles): show how much spoken audio is buffered ahead of the video

The dubbing settings panel now has a "N ready" row showing how many translated
lines have been synthesized and are waiting to play. It is the visible signal
that synthesis is losing ground: a video played faster than the engine answers
drains the buffer to 0 and starts dropping sentences, and the count turns amber
at that point so the fix is obvious — lower the playback speed, or raise the
MiMo dubbing concurrency.

The readout counts only audio ahead of the playhead that has not been spoken, so
it reads as "waiting to play" rather than "cached". Its tooltip names the two
knobs that change it, and only mentions the concurrency setting for the MiMo
engine, since Edge TTS keeps its own fixed budget.

The engine is also now read when dubbing is enabled rather than only after the
first synthesis completes. Previously the cold start — the moment the buffer
most needs to fill — sized its prefetch window and request budget from Edge's
smaller defaults even under MiMo, delaying the first cues.
