import type { MimoTtsFormat, MimoTtsSettings, MimoTtsVoice } from "./types"

export const MIMO_TTS_DEFAULT_BASE_URL = "https://token-plan-cn.xiaomimimo.com/v1"

export const MIMO_TTS_DEFAULT_MODEL = "mimo-v2.5-tts"
export const MIMO_TTS_DEFAULT_VOICE: MimoTtsVoice = "冰糖"
export const MIMO_TTS_DEFAULT_FORMAT: MimoTtsFormat = "mp3"

/**
 * Preset voices accepted by `mimo-v2.5-tts`. Verified against the live API: any
 * other value is rejected with "Unknown voice: <name>" listing exactly these.
 */
export const MIMO_TTS_PRESET_VOICES: MimoTtsVoice[] = [
  "mimo_default",
  "冰糖",
  "茉莉",
  "苏打",
  "白桦",
  "Mia",
  "Chloe",
  "Milo",
  "Dean",
]

/**
 * `mimo-v2.5-tts` reads a preset voice. `voicedesign` invents one from the style
 * prompt instead (and then requires that prompt); `voiceclone` needs a reference
 * audio sample, so it is not offered here.
 */
export const MIMO_TTS_MODELS = ["mimo-v2.5-tts", "mimo-v2.5-tts-voicedesign"] as const

export const MIMO_TTS_FORMATS: MimoTtsFormat[] = ["mp3", "wav"]

/** The model that requires a style prompt, since that is where the voice comes from. */
export const MIMO_TTS_VOICE_DESIGN_MODEL = "mimo-v2.5-tts-voicedesign"

/**
 * Range for the user-set dubbing concurrency.
 *
 * The ceiling is a courtesy to the provider rather than a measured limit: this
 * many in-flight requests is what a 4x video needs to keep up with MiMo's
 * multi-second latency, and a user on a slower endpoint can raise it further
 * only by hitting 429s, which the engine retries once.
 */
export const MIN_MIMO_TTS_CONCURRENCY = 1
export const MAX_MIMO_TTS_CONCURRENCY = 12
export const DEFAULT_MIMO_TTS_CONCURRENCY = 4

/** A stored value is untrusted: it may predate this field, or be hand-edited. */
export function clampMimoTtsConcurrency(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_MIMO_TTS_CONCURRENCY
  }
  return Math.min(
    MAX_MIMO_TTS_CONCURRENCY,
    Math.max(MIN_MIMO_TTS_CONCURRENCY, Math.round(value)),
  )
}

export const DEFAULT_MIMO_TTS_SETTINGS: MimoTtsSettings = {
  engine: "edge",
  // Blank on purpose: the key is a per-user secret, entered and stored once in
  // the settings page. Nothing pre-filled belongs in tracked source.
  apiKey: "",
  baseUrl: MIMO_TTS_DEFAULT_BASE_URL,
  model: MIMO_TTS_DEFAULT_MODEL,
  voice: MIMO_TTS_DEFAULT_VOICE,
  stylePrompt: "",
  format: MIMO_TTS_DEFAULT_FORMAT,
  concurrency: DEFAULT_MIMO_TTS_CONCURRENCY,
}

export const MIMO_TTS_STORAGE_KEY = "mimoTtsSettings"

/**
 * A `storage.local` key of its own, next to — not inside — the versioned config
 * blob. `configSchema` never sees it, so no schema version bump, migration
 * script, or per-version fixture is involved.
 */
export const MIMO_TTS_STORAGE_ITEM = `local:${MIMO_TTS_STORAGE_KEY}` as const
