---
"@read-frog/extension": patch
---

fix(subtitles): hold the dubbing ready buffer to the configured concurrency

The dubbing buffer readout could climb past the concurrency it is tuned against —
a 12-line setting showed 15. Two causes, both fixed.

The prefetch window — how far ahead of the playhead audio is kept ready — was
scaled by the video's playback rate, so at 1.25x a setting of 12 aimed at 15
lines. The window is now exactly the concurrency setting, and the readout counts
only what that window holds, so the number cannot read past the setting. The
playback rate needs no factor there: concurrency is what decides how fast the
buffer refills, and depth beyond it only hedges against a stalled endpoint, which
raising the setting buys more directly. The MiMo tooltip now says the number is
capped this way.

The other cause was a seek. Audio behind the playhead is kept for a while so
seeking back stays instant, and seeking back re-exposed those clips — the count
added up every cached clip ahead of the new position, reading them as extra
depth. The readout now measures the window ahead of the new position; the clips
themselves are still kept.

Prefetch also stops starting work the buffer already holds: a pass skips cues
that are ready or already being synthesized, instead of spending its budget
re-checking them, and a finished request releases its concurrency slot before the
refill pass runs. Together those stop a seek from stacking a fresh batch on top of
the one it left behind, and let the buffer reach the configured number rather than
settling one short of it.
