import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { dubbingStateAtom, subtitlesStore, translatedTrackAtom } from "../atoms"
import { SubtitlesDubbingScheduler } from "../subtitles-dubbing-scheduler"

const getLocalConfig = vi.hoisted(() => vi.fn<() => Promise<any>>())
const sendMessage = vi.hoisted(() => vi.fn<(...args: any[]) => any>())

vi.mock("@/utils/config/storage", () => ({ getLocalConfig }))
vi.mock("@/utils/message", () => ({ sendMessage }))

const AUDIO_B64 = "aGVsbG8="

function createAudioStub() {
  const listeners = new Map<string, EventListener>()
  return {
    paused: false,
    ended: false,
    duration: Number.NaN,
    playbackRate: 1,
    currentTime: 0,
    muted: false,
    src: "",
    play: vi.fn<() => Promise<void>>(() => Promise.resolve()),
    pause: vi.fn<() => void>(),
    addEventListener: vi.fn<(type: string, listener: EventListener) => void>(
      (type: string, listener: EventListener) => {
        listeners.set(type, listener)
      },
    ),
    removeEventListener: vi.fn<() => void>(),
    emit: (type: string) => listeners.get(type)?.(new Event(type)),
  }
}

function createVideo(currentTime = 0) {
  const listeners = new Map<string, EventListener>()
  return {
    currentTime,
    paused: false,
    playbackRate: 1,
    muted: false,
    addEventListener: vi.fn<(type: string, listener: EventListener) => void>(
      (type: string, listener: EventListener) => {
        listeners.set(type, listener)
      },
    ),
    removeEventListener: vi.fn<() => void>(),
    dispatch: (type: string) => listeners.get(type)?.(new Event(type)),
  } as unknown as HTMLVideoElement & { dispatch: (type: string) => void }
}

function mockSynthesizeSuccess() {
  sendMessage.mockResolvedValue({ ok: true, audioBase64: AUDIO_B64, contentType: "audio/mpeg" })
}

function mockConfig(overrides: Record<string, unknown> = {}) {
  getLocalConfig.mockResolvedValue({
    tts: { defaultVoice: "en-US-AndrewMultilingualNeural", rate: 0, pitch: 0, volume: 0 },
    language: { targetCode: "cmn" },
    videoSubtitles: { dubbing: { enabled: true, muteOriginal: false } },
    ...overrides,
  })
}

// The scheduler constructs real HTMLAudioElement instances; swap the global so
// tests control playback without jsdom media internals.
let audioInstances: ReturnType<typeof createAudioStub>[] = []

function installAudioGlobal() {
  function AudioStub() {
    const stub = createAudioStub()
    audioInstances.push(stub)
    return stub
  }
  vi.stubGlobal("Audio", AudioStub)
}

// @webext-core/messaging calls sendMessage(type, data) — data is index 1.
function synthRequests() {
  return sendMessage.mock.calls.map((call) => (call[1] ?? {}) as { text?: string; voice?: string })
}

function track(...cues: { start: number; end: number; translation?: string }[]) {
  subtitlesStore.set(
    translatedTrackAtom,
    cues.map((c) => ({ text: `t-${c.start}`, start: c.start, end: c.end, translation: c.translation })),
  )
}

describe("subtitles dubbing scheduler", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    audioInstances = []
    installAudioGlobal()
    mockSynthesizeSuccess()
    mockConfig()
    subtitlesStore.set(translatedTrackAtom, [])
    subtitlesStore.set(dubbingStateAtom, { enabled: false, readyCount: 0 })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    subtitlesStore.set(translatedTrackAtom, [])
    subtitlesStore.set(dubbingStateAtom, { enabled: false, readyCount: 0 })
  })

  it("starts and publishes enabled state", async () => {
    const video = createVideo()
    const scheduler = new SubtitlesDubbingScheduler({ videoElement: video })

    await scheduler.setEnabled(true)

    expect(scheduler.isEnabled()).toBe(true)
    expect(subtitlesStore.get(dubbingStateAtom).enabled).toBe(true)
  })

  it("synthesizes and plays the cue covering the playhead", async () => {
    const video = createVideo(1)
    track({ start: 0, end: 2_000, translation: "你好" })
    const scheduler = new SubtitlesDubbingScheduler({ videoElement: video })

    await scheduler.setEnabled(true)
    await vi.waitFor(() => expect(audioInstances.length).toBeGreaterThan(0))
    await vi.waitFor(() =>
      expect(synthRequests()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ text: "你好", voice: "zh-CN-XiaoxiaoMultilingualNeural" }),
        ]),
      ),
    )
  })

  it("prefetches upcoming cues but never skips the current one", async () => {
    const video = createVideo(1)
    track(
      { start: 0, end: 2_000, translation: "一" },
      { start: 2_000, end: 4_000, translation: "二" },
      { start: 4_000, end: 6_000, translation: "三" },
    )
    const scheduler = new SubtitlesDubbingScheduler({ videoElement: video })

    await scheduler.setEnabled(true)

    await vi.waitFor(() => expect(sendMessage.mock.calls.length).toBeGreaterThanOrEqual(3))
    const texts = synthRequests().map((r) => r.text)
    expect(texts).toContain("一")
    expect(texts).toContain("二")
  })

  it("does not synthesize cues without a translation", async () => {
    const video = createVideo(1)
    track(
      { start: 0, end: 2_000 },
      { start: 2_000, end: 4_000, translation: "有" },
    )
    const scheduler = new SubtitlesDubbingScheduler({ videoElement: video })

    await scheduler.setEnabled(true)
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalled())

    const texts = synthRequests().map((r) => r.text)
    expect(texts).not.toContain("t-0")
  })

  it("stops playback and re-ticks on seek", async () => {
    const video = createVideo(1)
    track(
      { start: 0, end: 2_000, translation: "一" },
      { start: 4_000, end: 6_000, translation: "二" },
    )
    const scheduler = new SubtitlesDubbingScheduler({ videoElement: video })
    await scheduler.setEnabled(true)

    await vi.waitFor(() => expect(audioInstances.length).toBeGreaterThan(0))
    const firstAudio = audioInstances[0]!

    ;(video as unknown as { currentTime: number }).currentTime = 5
    video.dispatch("seeking")

    expect(firstAudio.pause).toHaveBeenCalled()
    await vi.waitFor(() => {
      const seekTexts = synthRequests().map((r) => r.text)
      expect(seekTexts).toContain("二")
    })
  })

  it("pauses and resumes the audio with the video", async () => {
    const video = createVideo(1)
    track({ start: 0, end: 60_000, translation: "你好" })
    const scheduler = new SubtitlesDubbingScheduler({ videoElement: video })
    await scheduler.setEnabled(true)

    await vi.waitFor(() => expect(audioInstances.length).toBe(1))
    const audio = audioInstances[0]!

    video.dispatch("pause")
    expect(audio.pause).toHaveBeenCalled()

    video.dispatch("play")
    await vi.waitFor(() => expect(audio.play).toHaveBeenCalled())
  })

  it("mutes the video while enabled with muteOriginal, restores on stop", async () => {
    mockConfig({
      videoSubtitles: { dubbing: { enabled: true, muteOriginal: true } },
    })
    const video = createVideo(1)
    video.muted = false
    const scheduler = new SubtitlesDubbingScheduler({ videoElement: video })

    await scheduler.setEnabled(true)
    await scheduler.setMuteOriginal(true)
    expect(video.muted).toBe(true)

    await scheduler.setEnabled(false)
    expect(video.muted).toBe(false)
  })

  it("restores the pre-existing muted state, not just unmute", async () => {
    const video = createVideo(1)
    video.muted = true
    const scheduler = new SubtitlesDubbingScheduler({ videoElement: video })

    await scheduler.setEnabled(true)
    await scheduler.setMuteOriginal(true)
    expect(video.muted).toBe(true)

    await scheduler.setEnabled(false)
    // Was muted by the user before enabling: keep it muted.
    expect(video.muted).toBe(true)
  })

  it("time-compresses long audio into the cue window, never stretches", async () => {
    const video = createVideo(1)
    track({ start: 0, end: 2_000, translation: "你好" })
    const scheduler = new SubtitlesDubbingScheduler({ videoElement: video })
    await scheduler.setEnabled(true)

    await vi.waitFor(() => expect(audioInstances.length).toBe(1))
    const audio = audioInstances[0]!
    audio.duration = 6 // 6s of speech for a 2s cue -> 3x
    audio.emit("loadedmetadata")

    expect(audio.playbackRate).toBeCloseTo(3)
  })

  it("caps compression at the maximum rate", async () => {
    const video = createVideo(1)
    track({ start: 0, end: 2_000, translation: "你好" })
    const scheduler = new SubtitlesDubbingScheduler({ videoElement: video })
    await scheduler.setEnabled(true)

    await vi.waitFor(() => expect(audioInstances.length).toBe(1))
    const audio = audioInstances[0]!
    audio.duration = 20 // Would need 10x; must clamp to 4.
    audio.emit("loadedmetadata")

    expect(audio.playbackRate).toBe(4)
  })

  it("clears cached audio when the translated track is replaced", async () => {
    const video = createVideo(1)
    track({ start: 0, end: 2_000, translation: "你好" })
    const scheduler = new SubtitlesDubbingScheduler({ videoElement: video })
    await scheduler.setEnabled(true)
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalled())
    const firstSynthesisCount = sendMessage.mock.calls.length

    // A recut replaces the whole track.
    track({ start: 0, end: 3_000, translation: "你好世界" })
    ;(video as unknown as { currentTime: number }).currentTime = 1.5
    video.dispatch("timeupdate")

    await vi.waitFor(() =>
      expect(synthRequests().some((r) => r.text === "你好世界")).toBe(true),
    )
    // The old cue "你好" must not be re-synthesized from the stale cache.
    const after = synthRequests().filter((r) => r.text === "你好").length
    expect(after).toBeLessThanOrEqual(firstSynthesisCount)
  })
})
