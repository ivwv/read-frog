import type { MimoTtsSettings } from "./types"
import { storage } from "#imports"
import { DEFAULT_MIMO_TTS_SETTINGS, MIMO_TTS_STORAGE_ITEM } from "./constants"

/**
 * Reads the MiMo settings, merged over the defaults.
 *
 * The merge is what lets this key skip the migration machinery entirely: a
 * record written by an earlier build of this feature may be missing fields, and
 * layering it over the defaults yields a complete object instead of handing
 * callers `undefined`. No version number is tracked, because none is needed.
 *
 * The key sits beside — never inside — the versioned config blob, so
 * `configSchema` never sees these fields and no schema bump, migration script,
 * or per-version fixture is involved.
 */
export async function getMimoTtsSettings(): Promise<MimoTtsSettings> {
  const stored = await storage.getItem<Partial<MimoTtsSettings>>(MIMO_TTS_STORAGE_ITEM)
  return { ...DEFAULT_MIMO_TTS_SETTINGS, ...(stored ?? {}) }
}

/**
 * Writes the whole object rather than patching a freshly read one: the settings
 * page holds the authoritative copy in component state, and a read-modify-write
 * per keystroke would let two in-flight writes drop one another's fields.
 */
export async function saveMimoTtsSettings(settings: MimoTtsSettings): Promise<void> {
  await storage.setItem<MimoTtsSettings>(MIMO_TTS_STORAGE_ITEM, settings)
}
