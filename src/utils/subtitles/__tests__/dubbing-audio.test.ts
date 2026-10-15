import { storage } from "#imports"
import { beforeEach, describe, expect, it } from "vitest"
import {
  DEFAULT_DUBBING_AUDIO_SETTINGS,
  getDubbingAudioSettings,
  MAX_DUBBING_VOLUME,
  MIN_DUBBING_VOLUME,
  saveDubbingAudioSettings,
  toElementVolume,
} from "../dubbing-audio"

// The key is not exported: tests reach it the same way a stale record would,
// through storage, which is also what keeps the module free to rename it.
const KEY = "local:dubbingAudioSettings"

describe("dubbing audio settings", () => {
  beforeEach(async () => {
    await storage.setItem(KEY, null)
  })

  it("defaults both levels to full", async () => {
    expect(await getDubbingAudioSettings()).toEqual(DEFAULT_DUBBING_AUDIO_SETTINGS)
  })

  /**
   * The reason this key needs no migration script: a record written before a
   * field existed is merged over the defaults rather than rejected.
   */
  it("merges a partial record over the defaults", async () => {
    await storage.setItem(KEY, { dubbingVolume: 40 })

    expect(await getDubbingAudioSettings()).toEqual({ originalVolume: 100, dubbingVolume: 40 })
  })

  it("round-trips a saved record", async () => {
    await saveDubbingAudioSettings({ originalVolume: 30, dubbingVolume: 55 })

    expect(await getDubbingAudioSettings()).toEqual({ originalVolume: 30, dubbingVolume: 55 })
  })

  it("clamps a hand-edited or out-of-range value", async () => {
    await storage.setItem(KEY, { originalVolume: 900, dubbingVolume: -20 })

    expect(await getDubbingAudioSettings()).toEqual({ originalVolume: 100, dubbingVolume: 0 })
  })

  it("falls back for a value that is not a number at all", async () => {
    await storage.setItem(KEY, { originalVolume: "loud", dubbingVolume: null })

    expect(await getDubbingAudioSettings()).toEqual(DEFAULT_DUBBING_AUDIO_SETTINGS)
  })

  it("converts the UI's percentage to the 0-1 an element wants", () => {
    expect(toElementVolume(0)).toBe(0)
    expect(toElementVolume(50)).toBe(0.5)
    expect(toElementVolume(100)).toBe(1)
    // Out of range is clamped rather than handed to the element, which would
    // throw on a value above 1.
    expect(toElementVolume(MAX_DUBBING_VOLUME + 50)).toBe(1)
    expect(toElementVolume(MIN_DUBBING_VOLUME - 50)).toBe(0)
  })
})
