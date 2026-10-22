import { beforeEach, describe, expect, it, vi } from "vitest"

const storageMock = vi.hoisted(() => ({
  getItem: vi.fn<(key: string) => Promise<unknown>>(async () => undefined),
  setItem: vi.fn<(key: string, value: unknown) => Promise<void>>(async () => {}),
}))

// `#imports` re-exports `wxt/utils/storage`, so the underlying module is what
// actually intercepts the call — mocking the alias alone leaves the real
// storage in place (see `config/__tests__/init.test.ts`).
vi.mock("#imports", () => ({ storage: storageMock }))
vi.mock("wxt/utils/storage", () => ({ storage: storageMock }))

const { clampTtsPlaybackRate, getTtsPlaybackRate, saveTtsPlaybackRate } =
  await import("../playback-rate")

describe("tts playback rate", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storageMock.getItem.mockResolvedValue(undefined)
  })

  it("defaults to natural speed when nothing is stored", async () => {
    await expect(getTtsPlaybackRate()).resolves.toBe(1)
  })

  it("keeps a stored speed the slider can produce", async () => {
    storageMock.getItem.mockResolvedValue(0.7)

    await expect(getTtsPlaybackRate()).resolves.toBe(0.7)
  })

  it("clamps a stored value to the range the slider offers", async () => {
    // A hand-edited or older record is untrusted: 0 would silence playback and
    // 100 would turn a sentence into a click.
    storageMock.getItem.mockResolvedValue(0)
    await expect(getTtsPlaybackRate()).resolves.toBe(0.1)

    storageMock.getItem.mockResolvedValue(100)
    await expect(getTtsPlaybackRate()).resolves.toBe(5)

    storageMock.getItem.mockResolvedValue("fast")
    await expect(getTtsPlaybackRate()).resolves.toBe(1)
  })

  it("stores the speed rounded to the tenth the slider writes", async () => {
    await saveTtsPlaybackRate(1.3000000000000003)

    expect(storageMock.setItem).toHaveBeenCalledWith("local:ttsPlaybackRate", 1.3)
  })

  it("rounds and clamps through the same helper on read and write", () => {
    expect(clampTtsPlaybackRate(2.46)).toBe(2.5)
    expect(clampTtsPlaybackRate(Number.NaN)).toBe(1)
    expect(clampTtsPlaybackRate(-4)).toBe(0.1)
  })
})
