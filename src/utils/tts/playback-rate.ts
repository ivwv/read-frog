import { storage } from "#imports"

/**
 * How fast speech is played back, as a multiplier of the voice's own pace.
 *
 * Lives in its own `storage.local` key rather than in the versioned config, the
 * same way the MiMo settings do: adding a field to `configSchema` would mean a
 * schema bump, a migration script and a fixture for every historical version —
 * a large, conflict-prone diff for one self-contained number.
 *
 * The speed is applied to the audio element at playback rather than to
 * synthesis. Edge TTS silently clamps the SSML prosody rate it is handed to
 * roughly 0.5x-2x, so a percentage could never reach 5x; `playbackRate` has no
 * such ceiling, which is what makes the whole range real.
 */
export const MIN_TTS_PLAYBACK_RATE = 0.1
export const MAX_TTS_PLAYBACK_RATE = 5
export const DEFAULT_TTS_PLAYBACK_RATE = 1

export const TTS_PLAYBACK_RATE_STORAGE_KEY = "ttsPlaybackRate"

const TTS_PLAYBACK_RATE_STORAGE_ITEM = `local:${TTS_PLAYBACK_RATE_STORAGE_KEY}` as const

/** Rounded to the tenth the slider writes, so 1.3000000000000003 can't be stored. */
function roundRate(value: number): number {
  return Math.round(value * 10) / 10
}

/** A stored value is untrusted: it may predate this key, or be hand-edited. */
export function clampTtsPlaybackRate(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_TTS_PLAYBACK_RATE
  }
  return roundRate(Math.min(MAX_TTS_PLAYBACK_RATE, Math.max(MIN_TTS_PLAYBACK_RATE, value)))
}

export async function getTtsPlaybackRate(): Promise<number> {
  const stored = await storage.getItem<unknown>(TTS_PLAYBACK_RATE_STORAGE_ITEM)
  return clampTtsPlaybackRate(stored)
}

export async function saveTtsPlaybackRate(rate: number): Promise<void> {
  await storage.setItem<number>(TTS_PLAYBACK_RATE_STORAGE_ITEM, clampTtsPlaybackRate(rate))
}
