// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { APP_NAME } from "@/utils/constants/app"
import { i18n } from "@/utils/i18n"
import { subtitlesSettingsPanelOpenAtom, subtitlesStore, subtitlesVisibleAtom } from "../atoms"
import { SubtitlesSettingsPanel } from "../ui/subtitles-settings-panel"
import { SubtitlesTranslateButton } from "../ui/subtitles-translate-button"
import { SubtitlesProviders } from "../ui/subtitles-ui-context"

const toggleSubtitlesManually = vi.fn<(enabled: boolean) => void>()

/** The subtitles master switch, distinguished from the panel's other switches by name. */
function getSubtitlesToggle(): HTMLElement {
  return screen.getByRole("switch", {
    name: `${APP_NAME} ${i18n.t("options.videoSubtitles.title")}`,
  })
}

describe("subtitles toggle across navigation", () => {
  beforeEach(() => {
    subtitlesStore.set(subtitlesVisibleAtom, true)
    subtitlesStore.set(subtitlesSettingsPanelOpenAtom, true)
    toggleSubtitlesManually.mockClear()
  })

  afterEach(cleanup)

  it("reflects the next video's off state after the hidden panel opens", () => {
    render(
      <SubtitlesProviders
        adapter={
          {
            embedded: false,
            supportsAiSubtitles: false,
            supportsSidebar: false,
            getControlsConfig: () => undefined,
            toggleSubtitlesManually,
          } as any
        }
      >
        <SubtitlesTranslateButton />
        <SubtitlesSettingsPanel />
      </SubtitlesProviders>,
    )

    // The panel now hosts more than one switch, so target the subtitles one.
    const toggle = getSubtitlesToggle()
    expect(toggle).toHaveAttribute("data-checked")
    expect(screen.getByText("ON")).toBeInTheDocument()

    act(() => subtitlesStore.set(subtitlesSettingsPanelOpenAtom, false))
    act(() => subtitlesStore.set(subtitlesVisibleAtom, false))
    act(() => subtitlesStore.set(subtitlesSettingsPanelOpenAtom, true))

    expect(getSubtitlesToggle()).toHaveAttribute("data-unchecked")
    expect(screen.getByText("OFF")).toBeInTheDocument()
    fireEvent.click(getSubtitlesToggle())
    expect(toggleSubtitlesManually).toHaveBeenCalledWith(true)
  })
})
