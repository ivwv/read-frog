---
"@read-frog/extension": minor
---

feat(subtitles): add original-video and dubbing volume controls to video subtitles

The video subtitles panel now has a level slider for each audio source dubbing
mixes: the video's own audio, and the spoken translation. The original-video
slider is disabled while "Mute original video audio" is on, since the level has
nothing to act on then.

The level applies to the video while dubbing plays and the player is unmuted, and
is put back when dubbing stops, so enabling and disabling leaves the player's own
volume exactly as it was found. A level change is heard immediately, including on
a sentence that is already speaking; the value is written to storage on release
rather than per frame.

These levels live in their own `storage.local` key rather than in the versioned
config, so they need no schema version bump, no migration script, and no
per-version fixture. A stored record is merged over the defaults on read, so it
stays usable as fields are added.
