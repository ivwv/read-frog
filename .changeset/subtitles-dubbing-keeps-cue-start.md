---
"@read-frog/extension": patch
---

fix(subtitles): stop dubbing from clipping the opening words of a cue when the video plays faster than 1x

`timeupdate` is paced in wall-clock time (~250 ms), so the media time that passes
between ticks is `playbackRate x 250 ms`. The rate at which dubbing started a cue
was compared against a fixed 150 ms tolerance, so any speed above 1x made the
ordinary detection lag look like a seek into the middle of the cue: the sentence
joined part-way and lost its first characters. A cue is now spoken from its start
whenever it opened since the previous tick, and only joins mid-sentence for the
cases that genuinely miss part of the window — a seek into the cue, or dubbing
switched on while it is already playing.
