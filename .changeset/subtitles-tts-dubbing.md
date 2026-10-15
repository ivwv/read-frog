---
"@read-frog/extension": minor
---

feat(subtitles): read translated subtitles aloud with Edge TTS, kept in sync with the video

Adds a "Read translated subtitles aloud" toggle to the in-video subtitles panel, plus a
"Mute original video audio" switch for listening to the translation on its own.

Dubbing follows the video clock with an adaptive-rate control loop instead of a fixed
speed: a translated sentence whose audio is longer than its cue window is compressed to
fit, one that is shorter is never slowed below natural speed, and a cue still overrunning
is faded out under the next one rather than cut mid-word. Because MP3 audio from a data
URL often reports an unusable duration, the real length is probed from the stream first —
without it speech played at 1x, overran its subtitle, and was chopped off. Seeking into
the middle of a cue joins the audio at the matching offset, and audio for the upcoming
cues is synthesized ahead of the playhead so a seek barely waits.
