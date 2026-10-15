import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { dubbingStateAtom, subtitlesStore, translatedTrackAtom } from "../atoms"
import { SubtitlesDubbingScheduler } from "../subtitles-dubbing-scheduler"

const getLocalConfig = vi.hoisted(() => vi.fn<() => Promise<any>>())
const sendMessage = vi.hoisted(() => vi.fn<(...args: any[]) => any>())

vi.mock("@/utils/config/storage", () => ({ getLocalConfig }))
vi.mock("@/utils/message", () => ({ sendMessage }))

const AUDIO_B64 = "aGVsbG8="

/**
 * Mirrors the {@link HTMLAudioElement} surface the scheduler touches.
 *
 * `probeDuration` emulates the MP3-from-data-URL quirk that drove the sync fix:
 * `duration` starts as Infinity and only becomes real once a seek past the end
 * forces the browser to scan the whole stream (reported via `durationchange`).
 */
function createAudioStub(options: { duration?: number; probeDuration?: number } = {}) {
  const listeners = new Map<string, EventListener>()
  const probeDuration = options.probeDuration
  let duration = options.duration ?? Number.NaN

  const stub = {
    paused: false,
    ended: false,
    playbackRate: 1,
    muted: false,
    volume: 1,
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
    get duration() {
      return duration
    },
    set duration(value: number) {
      duration = value
    },
    currentTime: 0,
  }

  if (probeDuration !== undefined) {
    // A real element cannot expose the value before the stream is scanned.
    duration = Number.POSITIVE_INFINITY
    let currentTime = 0
    Object.defineProperty(stub, "currentTime", {
      get: () => currentTime,
      set: (value: number) => {
        currentTime = value
        if (value >= 1e6 || value > duration) {
          duration = probeDuration
          currentTime = probeDuration
          stub.emit("durationchange")
        }
      },
    })
  }

  return stub
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
/** Options handed to each stub the scheduler creates, consumed in order. */
let audioStubQueue: { duration?: number; probeDuration?: number }[] = []

function installAudioGlobal() {
  function AudioStub() {
    const options = audioStubQueue.shift() ?? {}
    const stub = createAudioStub(options)
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
    audioStubQueue = []
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

  it("speeds long audio up so it fits the cue window", async () => {
    const video = createVideo(0)
    track({ start: 0, end: 2_000, translation: "你好" })
    audioStubQueue.push({ duration: 3 }) // 3s of speech in a 2s window
    const scheduler = new SubtitlesDubbingScheduler({ videoElement: video })
    await scheduler.setEnabled(true)

    await vi.waitFor(() => expect(audioInstances.length).toBe(1))
    const audio = audioInstances[0]!
    audio.emit("loadedmetadata")

    // 3s of remaining audio / 2s of remaining window = 1.5x
    expect(audio.playbackRate).toBeCloseTo(1.5)
  })

  it("never slows a short sentence below natural speed", async () => {
    const video = createVideo(0)
    track({ start: 0, end: 10_000, translation: "好" })
    audioStubQueue.push({ duration: 3 }) // 3s of speech in a 10s window
    const scheduler = new SubtitlesDubbingScheduler({ videoElement: video })
    await scheduler.setEnabled(true)

    await vi.waitFor(() => expect(audioInstances.length).toBe(1))
    const audio = audioInstances[0]!
    audio.emit("loadedmetadata")

    expect(audio.playbackRate).toBe(1)
  })

  it("caps compression at the maximum rate", async () => {
    const video = createVideo(0)
    track({ start: 0, end: 2_000, translation: "你好" })
    audioStubQueue.push({ duration: 20 }) // Would need 10x; must clamp to 4.
    const scheduler = new SubtitlesDubbingScheduler({ videoElement: video })
    await scheduler.setEnabled(true)

    await vi.waitFor(() => expect(audioInstances.length).toBe(1))
    const audio = audioInstances[0]!
    audio.emit("loadedmetadata")

    expect(audio.playbackRate).toBe(4)
  })

  it("stacks compression with the video's own playback rate", async () => {
    const video = createVideo(0)
    video.playbackRate = 2
    track({ start: 0, end: 2_000, translation: "你好" })
    audioStubQueue.push({ duration: 3 }) // 1.5x needed for the window
    const scheduler = new SubtitlesDubbingScheduler({ videoElement: video })
    await scheduler.setEnabled(true)

    await vi.waitFor(() => expect(audioInstances.length).toBe(1))
    const audio = audioInstances[0]!
    audio.emit("loadedmetadata")

    expect(audio.playbackRate).toBeCloseTo(3) // 1.5 * 2, still under the cap
  })

  it("re-derives the rate as the window shrinks, correcting drift", async () => {
    const video = createVideo(0)
    track({ start: 0, end: 4_000, translation: "你好" })
    audioStubQueue.push({ duration: 4 }) // Exactly fits at the start
    const scheduler = new SubtitlesDubbingScheduler({ videoElement: video })
    await scheduler.setEnabled(true)

    await vi.waitFor(() => expect(audioInstances.length).toBe(1))
    const audio = audioInstances[0]!
    audio.emit("loadedmetadata")
    expect(audio.playbackRate).toBeCloseTo(1)

    // The audio fell behind (still 3s left) while only 1s of window remains.
    audio.currentTime = 1
    ;(video as unknown as { currentTime: number }).currentTime = 3
    video.dispatch("timeupdate")

    expect(audio.playbackRate).toBeCloseTo(3)
  })

  it("recovers the real duration when the element reports Infinity (MP3 quirk)", async () => {
    const video = createVideo(0)
    track({ start: 0, end: 2_000, translation: "你好" })
    // The bug users hit: without the probe the rate loop bails out and the
    // sentence overruns its window at 1x, then gets cut off by the next cue.
    audioStubQueue.push({ probeDuration: 4 })
    const scheduler = new SubtitlesDubbingScheduler({ videoElement: video })
    await scheduler.setEnabled(true)

    await vi.waitFor(() => expect(audioInstances.length).toBe(1))
    const audio = audioInstances[0]!
    audio.emit("loadedmetadata")

    // The probe resolved 4s for a 2s window: 2x, and playback restarts at 0.
    expect(audio.playbackRate).toBe(2)
    expect(audio.currentTime).toBe(0)
  })

  it("joins mid-cue playback at the matching offset instead of restarting", async () => {
    const video = createVideo(3) // 3s into a 4s cue
    track({ start: 0, end: 4_000, translation: "你好" })
    audioStubQueue.push({ duration: 4 })
    const scheduler = new SubtitlesDubbingScheduler({ videoElement: video })
    await scheduler.setEnabled(true)

    await vi.waitFor(() => expect(audioInstances.length).toBe(1))
    const audio = audioInstances[0]!
    await vi.waitFor(() => expect(audio.currentTime).toBeGreaterThan(0))

    // 75% through the cue → 75% into the audio, leaving 1s of speech for 1s.
    expect(audio.currentTime).toBeCloseTo(3, 1)
  })

  it("does not replay a sentence that already finished", async () => {
    const video = createVideo(0)
    track({ start: 0, end: 10_000, translation: "你好" })
    audioStubQueue.push({ duration: 2 })
    const scheduler = new SubtitlesDubbingScheduler({ videoElement: video })
    await scheduler.setEnabled(true)

    await vi.waitFor(() => expect(audioInstances.length).toBe(1))
    const audio = audioInstances[0]!
    audio.currentTime = 2
    audio.emit("ended")

    // The cue window is still open; the finished sentence must stay finished.
    ;(video as unknown as { currentTime: number }).currentTime = 5
    video.dispatch("timeupdate")

    expect(audioInstances.length).toBe(1)
  })

  it("replays a cue after an explicit seek back into it", async () => {
    const video = createVideo(0)
    track({ start: 0, end: 10_000, translation: "你好" })
    audioStubQueue.push({ duration: 2 }, { duration: 2 })
    const scheduler = new SubtitlesDubbingScheduler({ videoElement: video })
    await scheduler.setEnabled(true)

    await vi.waitFor(() => expect(audioInstances.length).toBe(1))
    audioInstances[0]!.emit("ended")

    ;(video as unknown as { currentTime: number }).currentTime = 3
    video.dispatch("seeking")
    video.dispatch("timeupdate")

    await vi.waitFor(() => expect(audioInstances.length).toBe(2))
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
