// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { createStore, Provider } from "jotai"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { configAtom } from "@/utils/atoms/config"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import App from "../app"

const savedTabs = vi.hoisted(() => ({ values: [] as string[] }))

// The page view is heavy (account menu, providers, hotkeys, site rules); this test
// is about which view the popup shows, so those rows stand in as markers.
vi.mock("../components/language-options-selector", () => ({
  default: () => <div>page-view-language-selector</div>,
}))
vi.mock("../components/providers-field", () => ({ default: () => <div>page-view-providers</div> }))
vi.mock("../components/translate-button", () => ({
  default: () => <div>page-view-translate-button</div>,
}))
vi.mock("../components/translate-prompt-selector", () => ({
  default: () => <div>page-view-prompt-selector</div>,
}))
vi.mock("../components/translation-mode-selector", () => ({
  default: () => <div>page-view-mode-selector</div>,
}))
vi.mock("../components/site-control-toggle", () => ({
  SiteControlToggle: () => <div>page-view-site-control</div>,
}))
vi.mock("../components/always-translate", () => ({
  AlwaysTranslate: () => <div>page-view-always-translate</div>,
}))
vi.mock("../components/node-translation-hotkey-selector", () => ({
  default: () => <div>page-view-hotkey</div>,
}))
vi.mock("../components/ai-smart-context", () => ({
  AISmartContext: () => <div>page-view-ai-context</div>,
}))
vi.mock("../components/store-review-prompt", () => ({
  StoreReviewPrompt: () => <div>store-review</div>,
}))
vi.mock("../components/more-menu", () => ({ MoreMenu: () => <div>more-menu</div> }))
vi.mock("../components/blog-notification", () => ({ default: () => <div>blog</div> }))
vi.mock("../components/discord-button", () => ({ DiscordButton: () => <div>discord</div> }))
vi.mock("../components/translation-hub-button", () => ({
  TranslationHubButton: () => <div>hub-button</div>,
}))
vi.mock("@/components/user-account-menu", () => ({
  UserAccountMenuPopup: () => <div>account</div>,
}))
vi.mock("@/utils/navigation", () => ({ openOptionsPage: vi.fn<() => Promise<void>>() }))

// The translation tab itself is covered by the hub's own tests; here it only has
// to prove it mounted.
vi.mock("../components/translation-tab", () => ({
  TranslationTab: () => <div>text-view-hub</div>,
}))

vi.mock("@/utils/popup/active-tab", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/popup/active-tab")>()),
  savePopupActiveTab: (tab: string) => {
    savedTabs.values.push(tab)
    return Promise.resolve()
  },
}))

function renderPopup() {
  const store = createStore()
  store.set(configAtom, DEFAULT_CONFIG)
  return render(
    <Provider store={store}>
      <App />
    </Provider>,
  )
}

// The tabs' sliding indicator reads this; jsdom has no matchMedia, and the
// indicator would throw from its MutationObserver after the test settles.
beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }),
  })
})

afterEach(() => {
  cleanup()
  savedTabs.values = []
})

describe("popup tabs", () => {
  it("offers both views as tabs and opens on the page view", () => {
    renderPopup()

    expect(screen.getByRole("tab", { name: /popup.tabs.page/ })).toBeInTheDocument()
    expect(screen.getByRole("tab", { name: /popup.tabs.text/ })).toBeInTheDocument()
    expect(screen.getByText("page-view-translate-button")).toBeInTheDocument()
    expect(screen.queryByText("text-view-hub")).not.toBeInTheDocument()
  })

  it("switches to the text view in place, without opening a new tab", () => {
    renderPopup()

    fireEvent.click(screen.getByRole("tab", { name: /popup.tabs.text/ }))

    expect(screen.getByText("text-view-hub")).toBeInTheDocument()
    expect(screen.queryByText("page-view-translate-button")).not.toBeInTheDocument()
  })

  it("remembers the view the user switched to", () => {
    renderPopup()

    fireEvent.click(screen.getByRole("tab", { name: /popup.tabs.text/ }))

    expect(savedTabs.values).toEqual(["text"])
  })
})
