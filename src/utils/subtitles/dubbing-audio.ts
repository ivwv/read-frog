import { storage } from "#imports"

/**
 * Levels for the two audio sources the dubbing feature mixes: the video's own
 * track and the spoken translation.
 *
 * Deliberately NOT part of the versioned config. Adding a field there costs a
 * schema version bump, a migration script, and a fixture for every historical
 * version (the migration suite replays all of them against the current schema),
 * which is a large, conflict-prone diff against upstream. A `storage.local` key
 * of its own needs none of that: a record written by an earlier build is merged
 * over the defaults on read, so it stays usable as fields are added.
 */
export const MIN_DUBBING_VOLUME = 0
export const MAX_DUBBING_VOLUME = 100

export interface DubbingAudioSettings {
  /** The video's own audio level, used while dubbing plays and it is not muted. */
  originalVolume: number
  /** The level of the spoken translation. */
  dubbingVolume: number
}

export const DEFAULT_DUBBING_AUDIO_SETTINGS: DubbingAudioSettings = {
  originalVolume: 100,
  dubbingVolume: 100,
}

const DUBBING_AUDIO_STORAGE_ITEM = "local:dubbingAudioSettings"

/** A stored value is untrusted: it may predate a field, or have been hand-edited. */
function clampVolume(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.min(MAX_DUBBING_VOLUME, Math.max(MIN_DUBBING_VOLUME, Math.round(value)))
}

export async function getDubbingAudioSettings(): Promise<DubbingAudioSettings> {
  const stored = await storage.getItem<Partial<DubbingAudioSettings>>(DUBBING_AUDIO_STORAGE_ITEM)
  return {
    originalVolume: clampVolume(
      stored?.originalVolume,
      DEFAULT_DUBBING_AUDIO_SETTINGS.originalVolume,
    ),
    dubbingVolume: clampVolume(stored?.dubbingVolume, DEFAULT_DUBBING_AUDIO_SETTINGS.dubbingVolume),
  }
}

export async function saveDubbingAudioSettings(settings: DubbingAudioSettings): Promise<void> {
  await storage.setItem<DubbingAudioSettings>(DUBBING_AUDIO_STORAGE_ITEM, {
    originalVolume: clampVolume(
      settings.originalVolume,
      DEFAULT_DUBBING_AUDIO_SETTINGS.originalVolume,
    ),
    dubbingVolume: clampVolume(settings.dubbingVolume, DEFAULT_DUBBING_AUDIO_SETTINGS.dubbingVolume),
  })
}

/** The 0-1 an `HTMLMediaElement` wants, from the 0-100 the UI and storage speak. */
export function toElementVolume(percent: number): number {
  return clampVolume(percent, MAX_DUBBING_VOLUME) / MAX_DUBBING_VOLUME
}
