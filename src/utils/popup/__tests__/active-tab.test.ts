import { beforeEach, describe, expect, it, vi } from "vitest"

const storageMock = vi.hoisted(() => ({
  getItem: vi.fn<(key: string) => Promise<unknown>>(async () => undefined),
  setItem: vi.fn<(key: string, value: unknown) => Promise<void>>(async () => {}),
}))

// `#imports` re-exports `wxt/utils/storage`, so the underlying module is what
// actually intercepts the call.
vi.mock("#imports", () => ({ storage: storageMock }))
vi.mock("wxt/utils/storage", () => ({ storage: storageMock }))

const { DEFAULT_POPUP_TAB, getPopupActiveTab, isPopupTab, savePopupActiveTab } = await import(
  "../active-tab"
)

describe("popup active tab", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storageMock.getItem.mockResolvedValue(undefined)
  })

  it("opens on the page view when nothing has been stored", async () => {
    // The page view is what the popup has always shown, so a fresh install and an
    // existing user both land where they expect.
    await expect(getPopupActiveTab()).resolves.toBe(DEFAULT_POPUP_TAB)
    expect(DEFAULT_POPUP_TAB).toBe("page")
  })

  it("reopens on the tab the user left", async () => {
    storageMock.getItem.mockResolvedValue("text")

    await expect(getPopupActiveTab()).resolves.toBe("text")
  })

  it("falls back to the page view for a stored value it does not know", async () => {
    // A hand-edited or older record must not leave the popup on a blank tab.
    storageMock.getItem.mockResolvedValue("something-else")
    await expect(getPopupActiveTab()).resolves.toBe("page")

    storageMock.getItem.mockResolvedValue(42)
    await expect(getPopupActiveTab()).resolves.toBe("page")
  })

  it("stores the chosen tab under its own local key", async () => {
    await savePopupActiveTab("text")

    expect(storageMock.setItem).toHaveBeenCalledWith("local:popupActiveTab", "text")
  })

  it("recognises only the two views", () => {
    expect(isPopupTab("page")).toBe(true)
    expect(isPopupTab("text")).toBe(true)
    expect(isPopupTab("settings")).toBe(false)
    expect(isPopupTab(null)).toBe(false)
  })
})
