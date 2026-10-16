// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createStore, Provider } from "jotai"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { storage } from "#imports"
import { DEFAULT_DUBBING_AUDIO_SETTINGS } from "@/utils/subtitles/dubbing-audio"
import { configFieldsAtomMap } from "@/utils/atoms/config"
import { dubbingStateAtom } from "../../../../atoms"
import { DubbingVolumeControls } from "../dubbing-toggle"

const setDubbingOriginalVolume = vi.hoisted(() => vi.fn<(...args: any[]) => any>())
const setDubbingVolume = vi.hoisted(() => vi.fn<(...args: any[]) => any>())

vi.mock("../../../subtitles-ui-context", () => ({
  useSubtitlesUI: () => ({ setDubbingOriginalVolume, setDubbingVolume }),
}))

const AUDIO_KEY = "local:dubbingAudioSettings"

function renderControls({
  dubbingEnabled = true,
  muteOriginal = false,
}: { dubbingEnabled?: boolean; muteOriginal?: boolean } = {}) {
  const store = createStore()
  store.set(dubbingStateAtom, { enabled: dubbingEnabled, readyCount: 0, failingSince: null, bufferedCount: 0, engine: null })
  // The config atom is async, so its setter resolves after the write.
  void store.set(configFieldsAtomMap.videoSubtitles, {
    dubbing: { enabled: dubbingEnabled, muteOriginal },
  } as never)

  render(
    <Provider store={store}>
      <DubbingVolumeControls />
    </Provider>,
  )
}

/** The two thumbs, in render order: original video, then dubbing. */
function thumbs() {
  return screen.getAllByRole("slider")
}

describe("dubbing volume controls", () => {
  beforeEach(async () => {
    setDubbingOriginalVolume.mockReset()
    setDubbingVolume.mockReset()
    await storage.setItem(AUDIO_KEY, { ...DEFAULT_DUBBING_AUDIO_SETTINGS })
  })

  afterEach(() => {
    cleanup()
  })

  it("renders a level for each audio source", async () => {
    renderControls()

    await waitFor(() => expect(thumbs()).toHaveLength(2))
    expect(screen.getByLabelText("subtitles.dubbing.originalVolume")).toBeDefined()
    expect(screen.getByLabelText("subtitles.dubbing.dubbingVolume")).toBeDefined()
  })

  it("shows nothing while dubbing is off", async () => {
    renderControls({ dubbingEnabled: false })

    await waitFor(() => expect(screen.queryByLabelText("subtitles.dubbing.originalVolume")).toBeNull())
  })

  it("disables the original level while the original is muted", async () => {
    renderControls({ muteOriginal: true })

    await waitFor(() => expect(thumbs()).toHaveLength(2))
    // The level has nothing to act on while the video is muted, so the control
    // says so rather than silently doing nothing. The dubbing level stays live.
    expect(thumbs()[0]).toBeDisabled()
    expect(thumbs()[1]).toBeEnabled()
  })

  it("keeps the original level usable while the original is audible", async () => {
    renderControls({ muteOriginal: false })

    await waitFor(() => expect(thumbs()).toHaveLength(2))
    expect(thumbs()[0]).toBeEnabled()
  })

  it("drives the audio while dragging and persists on release", async () => {
    renderControls()
    await waitFor(() => expect(thumbs()).toHaveLength(2))

    // Keyboard is the deterministic way to move a slider in jsdom.
    fireEvent.keyDown(thumbs()[1]!, { key: "ArrowLeft" })

    await waitFor(() => expect(setDubbingVolume).toHaveBeenCalled())
    expect(setDubbingOriginalVolume).not.toHaveBeenCalled()

    // The other row's stored value survives, because a commit patches the
    // record rather than writing a whole rendered object back.
    await waitFor(async () => {
      const stored = await storage.getItem<{ originalVolume: number }>(AUDIO_KEY)
      expect(stored?.originalVolume).toBe(DEFAULT_DUBBING_AUDIO_SETTINGS.originalVolume)
    })
  })
})
