---
"@read-frog/extension": patch
---

feat(tts): make read-aloud speed a 0.1x-5x playback multiplier

The speech settings page now has a speed slider from 0.1x to 5x instead of a
number box for a -100 to 100 percent offset. The offset could never really reach
5x: it was sent to Edge TTS as an SSML `prosody` rate, and the service silently
clamps whatever it is given to roughly 0.5x-2x — asking for 100 (the old top of
the scale) still came back at 2x.

So the speed is no longer part of synthesis at all. Edge TTS always returns the
voice at its natural pace, and the multiplier is applied to the audio element at
playback (`playbackRate`, with pitch correction on), where no such ceiling
exists. That also means changing the speed no longer invalidates cached audio,
and the slider is stored on its own `storage.local` key rather than in the
versioned config.

Video dubbing keeps its own synchronization loop: it derives each sentence's
rate from the cue window it has to fit, so the read-aloud speed does not apply
to it.
