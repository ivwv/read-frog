---
"@read-frog/extension": minor
---

feat(tts): add Xiaomi MiMo TTS as a selectable speech engine

Text to speech can now be synthesized by MiMo (`mimo-v2.5-tts`) instead of
Edge TTS. One switch under Options → Text to speech routes every surface through
the chosen engine, including the subtitles dubbing feature on YouTube.

MiMo has no numeric rate, pitch or volume parameters — delivery is steered by a
natural-language style instruction instead, so that field replaces the three
dials, and a preset voice (or the voice-design model) picks the speaker.

These settings are deliberately stored in their own `storage.local` key rather
than in the versioned config, so they need no schema version bump, no migration
script, and no per-version fixture. A stored record is merged over the defaults
on read, so it stays usable as fields are added.
