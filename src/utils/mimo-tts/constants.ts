import type { MimoTtsFormat, MimoTtsSettings, MimoTtsVoice } from "./types"

export const MIMO_TTS_DEFAULT_BASE_URL = "https://token-plan-cn.xiaomimimo.com/v1"

/**
 * Prefilled because this is a personal fork built for one machine, and the
 * alternative is re-pasting the key after every reinstall.
 *
 * It is a real credential sitting in tracked source. Rotate it at the provider
 * and blank this out before the branch is ever pushed anywhere public — the
 * settings page still works with the field emptied, since the stored value wins.
 */
export const MIMO_TTS_DEFAULT_API_KEY = "tp-c68023i15td7bogn098591k51hbi00wznicmaqz43lp3gfj7"

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

export const DEFAULT_MIMO_TTS_SETTINGS: MimoTtsSettings = {
  engine: "edge",
  apiKey: MIMO_TTS_DEFAULT_API_KEY,
  baseUrl: MIMO_TTS_DEFAULT_BASE_URL,
  model: MIMO_TTS_DEFAULT_MODEL,
  voice: MIMO_TTS_DEFAULT_VOICE,
  stylePrompt: "",
  format: MIMO_TTS_DEFAULT_FORMAT,
}

export const MIMO_TTS_STORAGE_KEY = "mimoTtsSettings"

/**
 * A `storage.local` key of its own, next to — not inside — the versioned config
 * blob. `configSchema` never sees it, so no schema version bump, migration
 * script, or per-version fixture is involved.
 */
export const MIMO_TTS_STORAGE_ITEM = `local:${MIMO_TTS_STORAGE_KEY}` as const
