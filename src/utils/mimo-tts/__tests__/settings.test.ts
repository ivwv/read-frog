import { storage } from "#imports"
import { beforeEach, describe, expect, it } from "vitest"
import {
  DEFAULT_MIMO_TTS_CONCURRENCY,
  DEFAULT_MIMO_TTS_SETTINGS,
  MAX_MIMO_TTS_CONCURRENCY,
  MIN_MIMO_TTS_CONCURRENCY,
  MIMO_TTS_STORAGE_ITEM,
} from "../constants"
import { getMimoTtsSettings, saveMimoTtsSettings } from "../settings"

describe("mimo tts settings", () => {
  beforeEach(async () => {
    await storage.setItem(MIMO_TTS_STORAGE_ITEM, null)
  })

  it("leaves Edge TTS in charge until MiMo is chosen", () => {
    expect(DEFAULT_MIMO_TTS_SETTINGS.engine).toBe("edge")
  })

  it("falls back to the defaults when nothing is stored", async () => {
    expect(await getMimoTtsSettings()).toEqual(DEFAULT_MIMO_TTS_SETTINGS)
  })

  /**
   * The reason this key needs no migration script: a record written before a
   * field existed is merged over the defaults rather than rejected, so callers
   * never receive `undefined` and no schema version has to be tracked.
   */
  it("merges a partial record over the defaults instead of requiring a migration", async () => {
    await storage.setItem(MIMO_TTS_STORAGE_ITEM, { engine: "mimo", voice: "苏打" })

    expect(await getMimoTtsSettings()).toEqual({
      ...DEFAULT_MIMO_TTS_SETTINGS,
      engine: "mimo",
      voice: "苏打",
    })
  })

  it("round-trips a saved record", async () => {
    const settings = {
      ...DEFAULT_MIMO_TTS_SETTINGS,
      engine: "mimo" as const,
      apiKey: "saved-key",
      model: "mimo-v2.5-tts-voicedesign",
      voice: "白桦",
      stylePrompt: "语速稍快",
      format: "wav" as const,
    }

    await saveMimoTtsSettings(settings)

    expect(await getMimoTtsSettings()).toEqual(settings)
  })

  it("keeps the MiMo settings out of the versioned config blob", async () => {
    await saveMimoTtsSettings({ ...DEFAULT_MIMO_TTS_SETTINGS, engine: "mimo" })

    // The key is its own `local:` entry, so `configSchema` never sees it and no
    // schema version bump or per-version fixture is involved.
    expect(MIMO_TTS_STORAGE_ITEM.startsWith("local:")).toBe(true)
    expect(MIMO_TTS_STORAGE_ITEM).not.toContain("config")
  })

  /**
   * A record from before this field existed has no `concurrency` at all, and a
   * hand-edited one can hold anything; both are clamped rather than trusted,
   * because the value becomes a request burst against a paid API.
   */
  it("fills in the default concurrency for a record that predates the field", async () => {
    await storage.setItem(MIMO_TTS_STORAGE_ITEM, { engine: "mimo", voice: "苏打" })

    expect((await getMimoTtsSettings()).concurrency).toBe(DEFAULT_MIMO_TTS_CONCURRENCY)
  })

  it("clamps an out-of-range or non-numeric stored concurrency", async () => {
    await storage.setItem(MIMO_TTS_STORAGE_ITEM, { concurrency: 999 })
    expect((await getMimoTtsSettings()).concurrency).toBe(MAX_MIMO_TTS_CONCURRENCY)

    await storage.setItem(MIMO_TTS_STORAGE_ITEM, { concurrency: 0 })
    expect((await getMimoTtsSettings()).concurrency).toBe(MIN_MIMO_TTS_CONCURRENCY)

    await storage.setItem(MIMO_TTS_STORAGE_ITEM, { concurrency: -5 })
    expect((await getMimoTtsSettings()).concurrency).toBe(MIN_MIMO_TTS_CONCURRENCY)

    await storage.setItem(MIMO_TTS_STORAGE_ITEM, { concurrency: "many" })
    expect((await getMimoTtsSettings()).concurrency).toBe(DEFAULT_MIMO_TTS_CONCURRENCY)
  })

  it("clamps a concurrency passed to the writer too", async () => {
    await saveMimoTtsSettings({ ...DEFAULT_MIMO_TTS_SETTINGS, concurrency: 100 })

    expect((await getMimoTtsSettings()).concurrency).toBe(MAX_MIMO_TTS_CONCURRENCY)
  })
})
