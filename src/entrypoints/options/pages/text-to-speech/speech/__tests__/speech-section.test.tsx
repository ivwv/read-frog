// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createStore, Provider } from "jotai"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const storageMock = vi.hoisted(() => ({
  getItem: vi.fn<(key: string) => Promise<unknown>>(async () => undefined),
  setItem: vi.fn<(key: string, value: unknown) => Promise<void>>(async () => {}),
  // The config atoms subscribe on mount; nothing here needs the subscription to fire.
  watch: vi.fn<(...args: any[]) => () => void>(() => () => {}),
}))

vi.mock("#imports", () => ({ storage: storageMock }))
vi.mock("wxt/utils/storage", () => ({ storage: storageMock }))

const { SpeechSection } = await import("../index")

function renderSection() {
  return render(
    <Provider store={createStore()}>
      <SpeechSection />
    </Provider>,
  )
}

describe("speech speed slider", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storageMock.getItem.mockResolvedValue(undefined)
  })

  afterEach(() => {
    cleanup()
  })

  it("offers 0.1x-5x as a slider rather than a percentage number box", async () => {
    renderSection()

    const slider = await screen.findByRole("slider", { name: "options.tts.speech.rate.title" })

    expect(slider).toHaveAttribute("type", "range")
    expect(slider).toHaveAttribute("min", "0.1")
    expect(slider).toHaveAttribute("max", "5")
    expect(slider).toHaveAttribute("step", "0.1")
    expect(slider).toHaveAttribute("aria-valuetext", "1x")
    // The old control was a third spinbutton; pitch and volume keep theirs.
    expect(screen.getAllByRole("spinbutton")).toHaveLength(2)
  })

  it("shows the stored speed and writes a new one on release", async () => {
    storageMock.getItem.mockResolvedValue(2.5)

    renderSection()

    const slider = await screen.findByRole("slider", { name: "options.tts.speech.rate.title" })
    await waitFor(() => expect(slider).toHaveAttribute("aria-valuenow", "2.5"))

    // A keyboard press is the deterministic way to move a slider in jsdom.
    fireEvent.keyDown(slider, { key: "ArrowRight" })

    await waitFor(() => expect(storageMock.setItem).toHaveBeenCalled())
    const [key, value] = storageMock.setItem.mock.calls.at(-1)!
    expect(key).toBe("local:ttsPlaybackRate")
    expect(typeof value).toBe("number")
    expect(value as number).toBeGreaterThan(2.5)
    expect(value as number).toBeLessThanOrEqual(5)
  })
})
