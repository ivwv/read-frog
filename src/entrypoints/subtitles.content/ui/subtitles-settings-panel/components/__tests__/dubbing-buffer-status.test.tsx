// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { createStore, Provider } from "jotai"
import { afterEach, describe, expect, it, vi } from "vitest"
import { dubbingStateAtom } from "../../../../atoms"
import { DubbingBufferStatus } from "../dubbing-toggle"

// The tooltip renders through a portal whose container comes from this context;
// a plain object stands in so no shadow host has to be built.
vi.mock("@/utils/react-shadow-host/create-shadow-host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/react-shadow-host/create-shadow-host")>()),
  ShadowWrapperContext: (await import("react")).createContext(null),
}))

function renderStatus(state: {
  enabled: boolean
  bufferedCount: number
  engine: "edge" | "mimo" | null
}) {
  const store = createStore()
  store.set(dubbingStateAtom, {
    readyCount: 0,
    failingSince: null,
    ...state,
  })

  return render(
    <Provider store={store}>
      <DubbingBufferStatus />
    </Provider>,
  )
}

describe("dubbing buffer status", () => {
  afterEach(() => {
    cleanup()
  })

  it("renders nothing while dubbing is off", () => {
    renderStatus({ enabled: false, bufferedCount: 0, engine: null })

    expect(screen.queryByText("subtitles.dubbing.buffered")).toBeNull()
  })

  it("shows how many lines are ready to play", () => {
    renderStatus({ enabled: true, bufferedCount: 5, engine: "mimo" })

    // The mocked i18n returns the key with its substitutions appended.
    expect(screen.getByText("subtitles.dubbing.buffered")).toBeDefined()
    expect(screen.getByText("5")).toBeDefined()
  })

  it("marks an empty buffer while dubbing is on", () => {
    renderStatus({ enabled: true, bufferedCount: 0, engine: "mimo" })

    // Nothing ready to speak on a running video is the state the user acts on,
    // so it is coloured rather than left looking like a normal reading.
    expect(screen.getByText("0").className).toContain("amber")
  })

  it("leaves a healthy buffer uncoloured", () => {
    renderStatus({ enabled: true, bufferedCount: 3, engine: "mimo" })

    expect(screen.getByText("3").className).not.toContain("amber")
  })
})
