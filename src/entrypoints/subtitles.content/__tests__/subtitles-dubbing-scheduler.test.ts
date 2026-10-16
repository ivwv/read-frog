import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  DEFAULT_DUBBING_AUDIO_SETTINGS,
  saveDubbingAudioSettings,
} from "@/utils/subtitles/dubbing-audio"
import { adPlayingAtom, dubbingStateAtom, subtitlesStore, translatedTrackAtom } from "../atoms"
import { SubtitlesDubbingScheduler } from "../subtitles-dubbing-scheduler"

const getLocalConfig = vi.hoisted(() => vi.fn<() => Promise<any>>())
const sendMessage = vi.hoisted(() => vi.fn<(...args: any[]) => any>())
const getMimoTtsSettings = vi.hoisted(() => vi.fn<() => Promise<any>>())

vi.mock("@/utils/config/storage", () => ({ getLocalConfig }))
vi.mock("@/utils/message", () => ({ sendMessage }))
vi.mock("@/utils/mimo-tts/settings", () => ({ getMimoTtsSettings }))

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
    load: vi.fn<() => void>(),
    removeAttribute: vi.fn<(name: string) => void>(),
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
    volume: 1,
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

/**
 * Every scheduler built in a test, so the teardown can unsubscribe it.
 *
 * `translatedTrackAtom` is a module-level store shared by the whole file, and a
 * scheduler subscribes to it for as long as it is enabled. A test that leaves
 * one enabled would have it react to the next test's `track()` calls — and,
 * since that scheduler's video stub is long gone, its cues would synthesize
 * against a stale element and inflate the Audio count the next test asserts on.
 */
let liveSchedulers: SubtitlesDubbingScheduler[] = []

function createScheduler(video: HTMLVideoElement): SubtitlesDubbingScheduler {
  const scheduler = new SubtitlesDubbingScheduler({ videoElement: video })
  liveSchedulers.push(scheduler)
  return scheduler
}

function installAudioGlobal() {
  function AudioStub(url?: string) {
    const options = audioStubQueue.shift() ?? {}
    const stub = createAudioStub(options)
    // A real element exposes the source it was constructed with.
    if (typeof url === "string") stub.src = url
    audioInstances.push(stub)
    return stub
  }
  vi.stubGlobal("Audio", AudioStub)
}

const createObjectURLDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL")
const revokeObjectURLDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL")

/** Every blob URL the scheduler created, and every one it handed back. */
let createdObjectUrls: string[] = []
let revokedObjectUrls: string[] = []

function installObjectUrlGlobals() {
  const create = vi.fn<(...args: any[]) => any>(() => {
    const url = `blob:dubbing-test-${createdObjectUrls.length}`
    createdObjectUrls.push(url)
    return url
  })
  const revoke = vi.fn<(...args: any[]) => any>((url: string) => {
    revokedObjectUrls.push(url)
  })

  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: create })
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revoke })
}

function restoreObjectUrlGlobals() {
  if (createObjectURLDescriptor) {
    Object.defineProperty(URL, "createObjectURL", createObjectURLDescriptor)
  } else {
    delete (URL as { createObjectURL?: unknown }).createObjectURL
  }
  if (revokeObjectURLDescriptor) {
    Object.defineProperty(URL, "revokeObjectURL", revokeObjectURLDescriptor)
  } else {
    delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL
  }
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
  beforeEach(async () => {
    vi.clearAllMocks()
    audioInstances = []
    audioStubQueue = []
    liveSchedulers = []
    createdObjectUrls = []
    revokedObjectUrls = []
    installAudioGlobal()
    installObjectUrlGlobals()
    mockSynthesizeSuccess()
    mockConfig()
    // The engine defaults to Edge; the concurrency test overrides this per test.
    getMimoTtsSettings.mockResolvedValue({
      engine: "edge",
      apiKey: "",
      baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
      model: "mimo-v2.5-tts",
      voice: "冰糖",
      stylePrompt: "",
      format: "mp3",
      concurrency: 4,
    })
    // The levels live in storage, which outlives a test; reset them so one
    // test's setting cannot decide another's expectations.
    await saveDubbingAudioSettings(DEFAULT_DUBBING_AUDIO_SETTINGS)
    subtitlesStore.set(adPlayingAtom, false)
    subtitlesStore.set(translatedTrackAtom, [])
    subtitlesStore.set(dubbingStateAtom, { enabled: false, readyCount: 0, failingSince: null, bufferedCount: 0, engine: null })
  })

  afterEach(() => {
    // Unsubscribe before the store is touched again, or a stale scheduler reacts
    // to the reset below (see `liveSchedulers`).
    for (const scheduler of liveSchedulers) {
      scheduler.destroy()
    }
    liveSchedulers = []
    // clearAllMocks drops call records but keeps implementations, so a
    // Date.now spy mocked forward in one test would keep every later test in
    // the future — restore them instead.
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    restoreObjectUrlGlobals()
    subtitlesStore.set(adPlayingAtom, false)
    subtitlesStore.set(translatedTrackAtom, [])
    subtitlesStore.set(dubbingStateAtom, { enabled: false, readyCount: 0, failingSince: null, bufferedCount: 0, engine: null })
  })

  it("starts and publishes enabled state", async () => {
    const video = createVideo()
    const scheduler = createScheduler(video)

    await scheduler.setEnabled(true)

    expect(scheduler.isEnabled()).toBe(true)
    expect(subtitlesStore.get(dubbingStateAtom).enabled).toBe(true)
  })

  it("synthesizes and plays the cue covering the playhead", async () => {
    const video = createVideo(1)
    track({ start: 0, end: 2_000, translation: "你好" })
    const scheduler = createScheduler(video)

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
    const scheduler = createScheduler(video)

    await scheduler.setEnabled(true)

    // The current cue is synthesized first; the rest of the window follows as
    // the in-flight budget frees up rather than as one unbounded burst.
    await vi.waitFor(() => expect(sendMessage.mock.calls.length).toBeGreaterThanOrEqual(2))
    const texts = synthRequests().map((r) => r.text)
    expect(texts).toContain("一")
    expect(texts).toContain("二")
  })

  it("keeps synthesis concurrency bounded on enable", async () => {
    const video = createVideo(0)
    track(
      { start: 0, end: 2_000, translation: "一" },
      { start: 2_000, end: 4_000, translation: "二" },
      { start: 4_000, end: 6_000, translation: "三" },
      { start: 6_000, end: 8_000, translation: "四" },
    )
    const scheduler = createScheduler(video)

    // Park every synthesis in flight, so the request count *is* the number of
    // concurrent requests rather than a total over time (Edge legitimately
    // starts one after another as each lands).
    sendMessage.mockImplementation(() => new Promise(() => {}))

    await scheduler.setEnabled(true)
    await vi.waitFor(() => expect(sendMessage.mock.calls.length).toBeGreaterThan(0))
    await new Promise((resolve) => setTimeout(resolve, 0))

    // Two at a time at most: a burst is what trips Edge TTS rate limiting and
    // its circuit breaker.
    const inFlightCalls = synthRequests().length
    expect(inFlightCalls).toBeLessThanOrEqual(2)
  })

  it("does not synthesize cues without a translation", async () => {
    const video = createVideo(1)
    track(
      { start: 0, end: 2_000 },
      { start: 2_000, end: 4_000, translation: "有" },
    )
    const scheduler = createScheduler(video)

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
    const scheduler = createScheduler(video)
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
    const scheduler = createScheduler(video)
    await scheduler.setEnabled(true)

    await vi.waitFor(() => expect(audioInstances.length).toBe(1))
    const audio = audioInstances[0]!

    video.dispatch("pause")
    expect(audio.pause).toHaveBeenCalled()

    video.dispatch("play")
    await vi.waitFor(() => expect(audio.play).toHaveBeenCalled())
  })

  it("keeps the video's own audio until the first cue actually speaks", async () => {
    mockConfig({
      videoSubtitles: { dubbing: { enabled: true, muteOriginal: true } },
    })
    const video = createVideo(1)
    video.muted = false
    // A cue the playhead is inside, so the first tick targets it immediately.
    track({ start: 0, end: 60_000, translation: "你好" })
    const scheduler = createScheduler(video)

    await scheduler.setEnabled(true)

    // Armed but not speaking: the original audio must still be audible, or the
    // translation pipeline's cold start would be heard as silence.
    expect(video.muted).toBe(false)

    await vi.waitFor(() => expect(audioInstances.length).toBe(1))
    await vi.waitFor(() => expect(video.muted).toBe(true))

    await scheduler.setEnabled(false)
    expect(video.muted).toBe(false)
  })

  it("mutes the video while enabled with muteOriginal, restores on stop", async () => {
    mockConfig({
      videoSubtitles: { dubbing: { enabled: true, muteOriginal: true } },
    })
    const video = createVideo(1)
    video.muted = false
    track({ start: 0, end: 60_000, translation: "你好" })
    const scheduler = createScheduler(video)

    await scheduler.setEnabled(true)
    await vi.waitFor(() => expect(audioInstances.length).toBe(1))
    await scheduler.setMuteOriginal(true)
    await vi.waitFor(() => expect(video.muted).toBe(true))

    await scheduler.setEnabled(false)
    expect(video.muted).toBe(false)
  })

  it("restores the pre-existing muted state, not just unmute", async () => {
    const video = createVideo(1)
    video.muted = true
    track({ start: 0, end: 60_000, translation: "你好" })
    const scheduler = createScheduler(video)

    await scheduler.setEnabled(true)
    await vi.waitFor(() => expect(audioInstances.length).toBe(1))
    await scheduler.setMuteOriginal(true)
    expect(video.muted).toBe(true)

    await scheduler.setEnabled(false)
    // Was muted by the user before enabling: keep it muted.
    expect(video.muted).toBe(true)
  })

  it("plays the dubbing voice at the stored level", async () => {
    await saveDubbingAudioSettings({ originalVolume: 100, dubbingVolume: 40 })
    const video = createVideo(0)
    track({ start: 0, end: 2_000, translation: "你好" })
    const scheduler = createScheduler(video)

    await scheduler.setEnabled(true)

    await vi.waitFor(() => expect(audioInstances.length).toBe(1))
    expect(audioInstances[0]!.volume).toBeCloseTo(0.4)
  })

  it("does not mute the video before the first cue's audio is ready", async () => {
    mockConfig({
      videoSubtitles: { dubbing: { enabled: true, muteOriginal: true } },
    })
    const video = createVideo(0)
    video.muted = false
    // The translation pipeline has not delivered anything yet.
    track()
    const scheduler = createScheduler(video)

    await scheduler.setEnabled(true)
    await Promise.resolve()

    // Nothing to speak, so nothing was taken over: the original audio plays on
    // instead of the video going silent until the first translation lands.
    expect(video.muted).toBe(false)
  })

  it("applies the stored level to the video while it is not muted", async () => {
    await saveDubbingAudioSettings({ originalVolume: 30, dubbingVolume: 100 })
    const video = createVideo(0)
    track({ start: 0, end: 60_000, translation: "你好" })
    const scheduler = createScheduler(video)

    await scheduler.setEnabled(true)
    // The level is the user's own until the first cue takes the element over.
    await vi.waitFor(() => expect(audioInstances.length).toBe(1))

    await vi.waitFor(() => expect(video.volume).toBeCloseTo(0.3))
  })

  it("leaves the video's own level alone while the original is muted", async () => {
    await saveDubbingAudioSettings({ originalVolume: 30, dubbingVolume: 100 })
    mockConfig({ videoSubtitles: { dubbing: { enabled: true, muteOriginal: true } } })
    const video = createVideo(0)
    video.volume = 0.8
    track({ start: 0, end: 60_000, translation: "你好" })
    const scheduler = createScheduler(video)

    await scheduler.setEnabled(true)
    await vi.waitFor(() => expect(audioInstances.length).toBe(1))

    await vi.waitFor(() => expect(video.muted).toBe(true))
    // Writing the level here would make unmuting land somewhere the user never
    // chose, so the muted branch must not touch it.
    expect(video.volume).toBe(0.8)

    // Unmuting is when the configured level takes over.
    await scheduler.setMuteOriginal(false)
    expect(video.muted).toBe(false)
    expect(video.volume).toBeCloseTo(0.3)
  })

  it("restores the user's own video level when dubbing stops", async () => {
    await saveDubbingAudioSettings({ originalVolume: 30, dubbingVolume: 100 })
    const video = createVideo(0)
    video.volume = 0.8
    track({ start: 0, end: 60_000, translation: "你好" })
    const scheduler = createScheduler(video)

    await scheduler.setEnabled(true)
    await vi.waitFor(() => expect(audioInstances.length).toBe(1))
    await vi.waitFor(() => expect(video.volume).toBeCloseTo(0.3))

    await scheduler.setEnabled(false)
    expect(video.volume).toBe(0.8)
  })

  it("follows a level change on the sentence already speaking", async () => {
    const video = createVideo(0)
    track({ start: 0, end: 60_000, translation: "你好" })
    const scheduler = createScheduler(video)
    await scheduler.setEnabled(true)

    await vi.waitFor(() => expect(audioInstances.length).toBe(1))
    const audio = audioInstances[0]!

    await scheduler.setDubbingVolume(25)

    expect(audio.volume).toBeCloseTo(0.25)
  })

  it("speeds long audio up so it fits the cue window", async () => {
    const video = createVideo(0)
    track({ start: 0, end: 2_000, translation: "你好" })
    audioStubQueue.push({ duration: 3 }) // 3s of speech in a 2s window
    const scheduler = createScheduler(video)
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
    const scheduler = createScheduler(video)
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
    const scheduler = createScheduler(video)
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
    const scheduler = createScheduler(video)
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
    const scheduler = createScheduler(video)
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
    const scheduler = createScheduler(video)
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
    const scheduler = createScheduler(video)
    await scheduler.setEnabled(true)

    await vi.waitFor(() => expect(audioInstances.length).toBe(1))
    const audio = audioInstances[0]!
    await vi.waitFor(() => expect(audio.currentTime).toBeGreaterThan(0))

    // 75% through the cue → 75% into the audio, leaving 1s of speech for 1s.
    expect(audio.currentTime).toBeCloseTo(3, 1)
  })

  /**
   * The reported bug: above 1x, nearly every cue lost its opening words.
   *
   * `timeupdate` is paced in wall-clock time (~250ms), so the media time that
   * passes between ticks is `playbackRate x 250ms`. The tick that first sees a
   * cue therefore lands that far past its start, and the old fixed 150ms
   * tolerance read that ordinary detection lag as "the playhead was already
   * inside this cue" — joining part-way and clipping the first characters.
   */
  it("speaks a cue from its start when the tick that finds it is one cadence late", async () => {
    const video = createVideo(0)
    video.playbackRate = 2
    track({ start: 1_000, end: 3_000, translation: "你好世界" })
    audioStubQueue.push({ duration: 4 })
    const scheduler = createScheduler(video)

    // A first tick before the cue opens, as a running scheduler would have.
    await scheduler.setEnabled(true)
    ;(video as unknown as { currentTime: number }).currentTime = 1.4
    video.dispatch("timeupdate")

    await vi.waitFor(() => expect(audioInstances.length).toBe(1))
    const audio = audioInstances[0]!
    audio.emit("loadedmetadata")

    // 400ms late at 2x is one tick of lag, not a mid-sentence entry: no seek.
    expect(audio.currentTime).toBe(0)
  })

  it("still joins when a seek lands inside a cue at higher playback rates", async () => {
    const video = createVideo(0)
    video.playbackRate = 2
    track({ start: 0, end: 4_000, translation: "你好世界" })
    audioStubQueue.push({ duration: 4 })
    const scheduler = createScheduler(video)
    await scheduler.setEnabled(true)

    await vi.waitFor(() => expect(audioInstances.length).toBe(1))

    // Drag the playhead 3s into the cue.
    ;(video as unknown as { currentTime: number }).currentTime = 3
    video.dispatch("seeking")

    await vi.waitFor(() => expect(audioInstances.length).toBe(2))
    const audio = audioInstances[1]!
    audio.emit("loadedmetadata")

    // 75% through the cue → 75% into the audio.
    expect(audio.currentTime).toBeCloseTo(3, 1)
  })

  it("speaks from the start when a seek lands before a cue and playback runs into it", async () => {
    const video = createVideo(0)
    track({ start: 2_000, end: 4_000, translation: "你好世界" })
    audioStubQueue.push({ duration: 4 })
    const scheduler = createScheduler(video)
    await scheduler.setEnabled(true)

    // Seek backwards to before the cue, then let playback reach it naturally.
    ;(video as unknown as { currentTime: number }).currentTime = 1
    video.dispatch("seeking")
    ;(video as unknown as { currentTime: number }).currentTime = 2.3
    video.dispatch("timeupdate")

    await vi.waitFor(() => expect(audioInstances.length).toBe(1))
    const audio = audioInstances[0]!
    audio.emit("loadedmetadata")

    expect(audio.currentTime).toBe(0)
  })

  it("does not replay a sentence that already finished", async () => {
    const video = createVideo(0)
    track({ start: 0, end: 10_000, translation: "你好" })
    audioStubQueue.push({ duration: 2 })
    const scheduler = createScheduler(video)
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
    const scheduler = createScheduler(video)
    await scheduler.setEnabled(true)

    await vi.waitFor(() => expect(audioInstances.length).toBe(1))
    audioInstances[0]!.emit("ended")

    ;(video as unknown as { currentTime: number }).currentTime = 3
    video.dispatch("seeking")
    video.dispatch("timeupdate")

    await vi.waitFor(() => expect(audioInstances.length).toBe(2))
  })

  /**
   * The reported crash: the YouTube tab kept dying while dubbing played.
   *
   * A clip that fails to decode stayed in the cache, so the next tick found a
   * "cached" cue, built another element from the same undecodable payload and
   * failed again — one new element, one fresh copy of the whole data URL and one
   * media-pipeline buffer per `timeupdate`, four times a second, for as long as
   * the cue's window lasted.
   */
  it("does not rebuild an element for a clip that failed to decode", async () => {
    const video = createVideo(0)
    track({ start: 0, end: 60_000, translation: "你好" })
    const scheduler = createScheduler(video)
    await scheduler.setEnabled(true)
    await vi.waitFor(() => expect(audioInstances.length).toBe(1))

    audioInstances[0]!.emit("error")

    for (let tick = 0; tick < 4; tick++) {
      video.dispatch("timeupdate")
      await Promise.resolve()
    }

    // The bad bytes are gone, so no second element is built from them.
    expect(audioInstances.length).toBe(1)
    expect((scheduler as any).audioCache.size).toBe(0)
    expect((scheduler as any).failedKeys.size).toBe(1)
    // And the blob behind them went with the entry.
    expect(revokedObjectUrls).toEqual(createdObjectUrls)
  })

  /**
   * A cached clip holds a blob alive for as long as its object URL exists, so
   * dropping the entry without revoking would leak the whole clip.
   */
  it("revokes a clip's blob URL when its entry is dropped", async () => {
    const video = createVideo(1)
    track(
      { start: 0, end: 2_000, translation: "一" },
      { start: 2_000, end: 4_000, translation: "二" },
    )
    const scheduler = createScheduler(video)

    await scheduler.setEnabled(true)
    await vi.waitFor(() => expect((scheduler as any).audioCache.size).toBe(2))
    expect(createdObjectUrls).toHaveLength(2)
    expect(revokedObjectUrls).toEqual([])

    // A recut removes the second cue: its clip is no longer reachable.
    track({ start: 0, end: 2_000, translation: "一" })

    expect((scheduler as any).audioCache.size).toBe(1)
    expect(revokedObjectUrls).toEqual([createdObjectUrls[1]])
  })

  it("plays from the clip's blob URL instead of a data URL", async () => {
    const video = createVideo(1)
    track({ start: 0, end: 2_000, translation: "你好" })
    const scheduler = createScheduler(video)

    await scheduler.setEnabled(true)
    await vi.waitFor(() => expect(audioInstances.length).toBe(1))

    // A blob URL is built once, from the bytes; no per-play string is assembled.
    expect(createdObjectUrls).toHaveLength(1)
    expect((scheduler as any).currentAudio.src).toBe(createdObjectUrls[0])
  })

  /**
   * Releasing an element must not point it at an empty URL.
   *
   * `src = ""` is not "no source": it resolves against the document, so the
   * browser starts loading the page itself as media, fails, and raises `error`
   * on the element — which the error handler then read as that clip failing.
   */
  it("releases an element without handing it an empty URL", async () => {
    const video = createVideo(0)
    track({ start: 0, end: 60_000, translation: "你好" })
    const scheduler = createScheduler(video)
    await scheduler.setEnabled(true)
    await vi.waitFor(() => expect(audioInstances.length).toBe(1))
    const audio = audioInstances[0]!

    // A seek tears the element down immediately.
    video.dispatch("seeking")

    expect(audio.removeAttribute).toHaveBeenCalledWith("src")
    expect(audio.load).toHaveBeenCalled()
    // Nothing failed here; the clip played fine until it was released.
    expect((scheduler as any).failedKeys.size).toBe(0)
  })

  it("ignores an error raised after the element was torn down", async () => {
    const video = createVideo(0)
    track({ start: 0, end: 60_000, translation: "你好" })
    // A real duration keeps the probe out of the way, so `ended` here means the
    // sentence finished rather than the probe parking the element at its end.
    audioStubQueue.push({ duration: 4 })
    const scheduler = createScheduler(video)
    await scheduler.setEnabled(true)
    await vi.waitFor(() => expect(audioInstances.length).toBe(1))
    const audio = audioInstances[0]!

    audio.emit("ended")
    // A real element can still report an error for the load it was doing when it
    // was released; that is not the clip failing to decode.
    audio.emit("error")

    expect((scheduler as any).failedKeys.size).toBe(0)
    expect((scheduler as any).audioCache.size).toBe(1)
  })

  it("clears cached audio when the translated track is replaced", async () => {
    const video = createVideo(1)
    track({ start: 0, end: 2_000, translation: "你好" })
    const scheduler = createScheduler(video)
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

  /**
   * The reported bug: playback re-requested a whole window of cues every time a
   * new line started.
   *
   * Translation batches land continuously and each one re-publishes the track as
   * a fresh array with more cues appended, so this handler runs every few
   * seconds. Pruning compared the cache's keys — which carry the synthesis
   * fingerprint — against a set of bare cue identities, so nothing ever matched
   * and every batch dropped the entire cache, throwing away audio that had
   * already been paid for.
   */
  it("keeps already-synthesized audio when a later batch appends to the track", async () => {
    const video = createVideo(1)
    track(
      { start: 0, end: 2_000, translation: "一" },
      { start: 2_000, end: 4_000, translation: "二" },
    )
    const scheduler = createScheduler(video)

    await scheduler.setEnabled(true)
    await vi.waitFor(() => expect((scheduler as any).audioCache.size).toBe(2))

    // A batch lands: same cues, one more appended. Nothing here was invalidated.
    // The atom subscription runs synchronously, so the cache can be read right
    // after the write instead of racing the re-synthesis it would trigger.
    track(
      { start: 0, end: 2_000, translation: "一" },
      { start: 2_000, end: 4_000, translation: "二" },
      { start: 4_000, end: 6_000, translation: "三" },
    )

    // Both cues are still in the track, so both must still be cached. Dropping
    // them is what made playback re-request a whole window every few seconds.
    expect((scheduler as any).audioCache.size).toBe(2)
  })

  it("still drops audio whose cue disappeared from the track", async () => {
    const video = createVideo(1)
    track(
      { start: 0, end: 2_000, translation: "一" },
      { start: 2_000, end: 4_000, translation: "二" },
    )
    const scheduler = createScheduler(video)

    await scheduler.setEnabled(true)
    await vi.waitFor(() => expect((scheduler as any).audioCache.size).toBe(2))

    // A recut removes the second cue entirely.
    track({ start: 0, end: 2_000, translation: "一" })

    expect((scheduler as any).audioCache.size).toBe(1)
  })

  it("synthesizes the cue covering the playhead as soon as the track lands", async () => {
    const video = createVideo(0)
    // Enabled with nothing translated yet, as the auto-start path does.
    const scheduler = createScheduler(video)
    await scheduler.setEnabled(true)
    expect(sendMessage).not.toHaveBeenCalled()

    // No timeupdate is dispatched: the track change itself has to be what makes
    // the scheduler notice there is something to say.
    track({ start: 0, end: 2_000, translation: "你好" })

    await vi.waitFor(() =>
      expect(synthRequests().some((r) => r.text === "你好")).toBe(true),
    )
  })

  it("drops cached audio for cues far behind the playhead", async () => {
    const video = createVideo(0)
    track(
      { start: 0, end: 2_000, translation: "一" },
      { start: 2_000, end: 4_000, translation: "二" },
    )
    const scheduler = createScheduler(video)
    await scheduler.setEnabled(true)
    await vi.waitFor(() => expect(sendMessage.mock.calls.length).toBeGreaterThanOrEqual(2))

    const before = (scheduler as any).audioCache.size
    expect(before).toBeGreaterThan(0)

    // Jump far ahead: every cached cue ended well over the keep-behind window
    // ago, so the cache must not carry them any further.
    ;(video as unknown as { currentTime: number }).currentTime = 600
    video.dispatch("seeking")

    expect((scheduler as any).audioCache.size).toBeLessThan(before)
  })

  it("keeps the cache bounded by entry count", async () => {
    const video = createVideo(0)
    const cues = Array.from({ length: 200 }, (_, index) => ({
      start: index * 2_000,
      end: (index + 1) * 2_000,
      translation: `句${index}`,
    }))
    track(...cues)
    const scheduler = createScheduler(video)

    await scheduler.setEnabled(true)
    // Walk the whole video so every cue gets synthesized.
    for (let index = 0; index < cues.length; index++) {
      ;(video as unknown as { currentTime: number }).currentTime = index * 2 + 1
      video.dispatch("timeupdate")
      await Promise.resolve()
    }

    expect((scheduler as any).audioCache.size).toBeLessThanOrEqual(64)
  })

  it("retries a cue whose synthesis failed, once the retry window has passed", async () => {
    const video = createVideo(0)
    track({ start: 0, end: 60_000, translation: "你好" })
    sendMessage.mockRejectedValueOnce(new Error("boom"))
    const scheduler = createScheduler(video)

    await scheduler.setEnabled(true)
    await vi.waitFor(() =>
      expect(synthRequests().filter((r) => r.text === "你好").length).toBe(1),
    )

    // Still inside the window: no retry, or a failing engine would be hammered.
    ;(video as unknown as { currentTime: number }).currentTime = 1
    video.dispatch("timeupdate")
    await Promise.resolve()
    expect(synthRequests().filter((r) => r.text === "你好").length).toBe(1)

    // Past the window the cue is eligible again instead of being silenced for
    // the rest of the video.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60_000)
    ;(video as unknown as { currentTime: number }).currentTime = 2
    video.dispatch("timeupdate")

    await vi.waitFor(() =>
      expect(synthRequests().filter((r) => r.text === "你好").length).toBe(2),
    )
  })

  it("does not rewrite dubbing state when nothing about it changed", async () => {
    const video = createVideo(0)
    track({ start: 0, end: 60_000, translation: "你好" })
    const scheduler = createScheduler(video)
    await scheduler.setEnabled(true)
    await vi.waitFor(() => expect(audioInstances.length).toBe(1))

    const published = subtitlesStore.get(dubbingStateAtom)
    // A tick with no synthesis and no eviction must not hand the panel a new
    // object a few times a second.
    ;(video as unknown as { currentTime: number }).currentTime = 5
    video.dispatch("timeupdate")

    expect(subtitlesStore.get(dubbingStateAtom)).toBe(published)
  })

  it("goes silent while an ad plays and resumes when it ends", async () => {
    const video = createVideo(1)
    track({ start: 0, end: 60_000, translation: "你好" })
    const scheduler = createScheduler(video)
    await scheduler.setEnabled(true)
    await vi.waitFor(() => expect(audioInstances.length).toBe(1))
    const firstAudio = audioInstances[0]!

    // The ad takes over the same <video> and its own timeline.
    subtitlesStore.set(adPlayingAtom, true)

    // The handover fades out rather than cutting; either way the element must
    // be parked quickly, and no new cue may open against the ad's clock.
    await vi.waitFor(() => expect(firstAudio.pause).toHaveBeenCalled())

    ;(video as unknown as { currentTime: number }).currentTime = 10
    video.dispatch("timeupdate")
    expect(audioInstances.length).toBe(1)

    // Back to the main video: speech is re-evaluated from the real clock.
    subtitlesStore.set(adPlayingAtom, false)
    ;(video as unknown as { currentTime: number }).currentTime = 3
    video.dispatch("timeupdate")
    expect(subtitlesStore.get(adPlayingAtom)).toBe(false)
  })

  it("does not speak a completed cue again after an ad, nor mid-ad", async () => {
    const video = createVideo(1)
    track({ start: 0, end: 60_000, translation: "你好" })
    const scheduler = createScheduler(video)
    await scheduler.setEnabled(true)
    await vi.waitFor(() => expect(audioInstances.length).toBe(1))

    subtitlesStore.set(adPlayingAtom, true)
    // Mid-ad ticks must not open a new cue against the ad's clock.
    ;(video as unknown as { currentTime: number }).currentTime = 10
    video.dispatch("timeupdate")
    expect(audioInstances.length).toBe(1)
  })

  it("invalidates cached audio when the engine or voice changes", async () => {
    const video = createVideo(0)
    track({ start: 0, end: 60_000, translation: "你好" })
    const scheduler = createScheduler(video)
    await scheduler.setEnabled(true)
    await vi.waitFor(() => expect(synthRequests().length).toBeGreaterThan(0))
    expect((scheduler as any).audioCache.size).toBeGreaterThan(0)

    // A voice change must not keep playing clips synthesized with the old one.
    getLocalConfig.mockResolvedValue({
      tts: { defaultVoice: "zh-CN-YunxiNeural", rate: 0, pitch: 0, volume: 0 },
      language: { targetCode: "cmn" },
      videoSubtitles: { dubbing: { enabled: true, muteOriginal: false } },
    })

    ;(video as unknown as { currentTime: number }).currentTime = 20
    video.dispatch("seeking")
    ;(video as unknown as { currentTime: number }).currentTime = 21
    video.dispatch("timeupdate")

    await vi.waitFor(() => expect((scheduler as any).audioCache.size).toBeGreaterThan(0))
    // Every clip still cached was synthesized after the change landed.
    const fingerprint = (scheduler as any).synthesisFingerprintCache as string
    expect(fingerprint).toContain("edge")
  })

  it("prefers the user's per-language voice mapping over the built-in default", async () => {
    getLocalConfig.mockResolvedValue({
      tts: {
        defaultVoice: "en-US-AndrewMultilingualNeural",
        languageVoices: { cmn: "zh-CN-YunxiNeural" },
        rate: 0,
        pitch: 0,
        volume: 0,
      },
      language: { targetCode: "cmn" },
      videoSubtitles: { dubbing: { enabled: true, muteOriginal: false } },
    })
    const video = createVideo(0)
    track({ start: 0, end: 60_000, translation: "你好" })
    const scheduler = createScheduler(video)

    await scheduler.setEnabled(true)

    await vi.waitFor(() => expect(synthRequests().length).toBeGreaterThan(0))
    expect(synthRequests()[0]!.voice).toBe("zh-CN-YunxiNeural")
  })

  it("publishes a failure streak, and clears it on the next success", async () => {
    const video = createVideo(0)
    track({ start: 0, end: 60_000, translation: "你好" })
    // Every synthesis fails while the streak is being observed, then succeeds.
    sendMessage.mockRejectedValue(new Error("invalid key"))
    const scheduler = createScheduler(video)

    await scheduler.setEnabled(true)
    await vi.waitFor(() =>
      expect(subtitlesStore.get(dubbingStateAtom).failingSince).not.toBeNull(),
    )

    // Recovery: the panel's hint must drop as soon as one cue succeeds.
    sendMessage.mockResolvedValue({ ok: true, audioBase64: AUDIO_B64, contentType: "audio/mpeg" })
    // A different cue forces a fresh synthesis rather than a cached failure.
    track(
      { start: 0, end: 60_000, translation: "你好" },
      { start: 60_000, end: 120_000, translation: "世界" },
    )
    ;(video as unknown as { currentTime: number }).currentTime = 61
    video.dispatch("seeking")
    video.dispatch("timeupdate")

    await vi.waitFor(() =>
      expect(subtitlesStore.get(dubbingStateAtom).failingSince).toBeNull(),
    )
  })

  it("allows MiMo more synthesis concurrency than Edge", async () => {
    const video = createVideo(0)
    track(
      { start: 0, end: 60_000, translation: "一" },
      { start: 60_000, end: 120_000, translation: "二" },
      { start: 120_000, end: 180_000, translation: "三" },
      { start: 180_000, end: 240_000, translation: "四" },
      { start: 240_000, end: 300_000, translation: "五" },
    )
    const scheduler = createScheduler(video)

    // MiMo engine: read by `start()` and again per cue, which is what both the
    // fingerprint and the concurrency gate key off.
    getMimoTtsSettings.mockResolvedValue({
      engine: "mimo",
      apiKey: "k",
      baseUrl: "https://mimo.test/v1",
      model: "mimo-v2.5-tts",
      voice: "冰糖",
      stylePrompt: "",
      format: "mp3",
      concurrency: 4,
    })

    // Park every synthesis in flight so the concurrency window is observable
    // tick by tick instead of racing immediate mocks.
    sendMessage.mockImplementation(() => new Promise(() => {}))

    await scheduler.setEnabled(true)

    // The engine is known before the first tick (seeded in `start`), so the very
    // first pass already runs on MiMo's deeper budget — Edge's cap of 2 would
    // have started only 2, which is what delayed the cold-start buffer.
    await vi.waitFor(() => expect(synthRequests().length).toBeGreaterThan(2))
    expect(synthRequests().length).toBeLessThanOrEqual(4)
  })

  it("takes MiMo concurrency from the user's setting", async () => {
    const video = createVideo(0)
    const cues = Array.from({ length: 12 }, (_, index) => ({
      start: index * 60_000,
      end: (index + 1) * 60_000,
      translation: `句${index}`,
    }))
    track(...cues)
    const scheduler = createScheduler(video)

    getMimoTtsSettings.mockResolvedValue({
      engine: "mimo",
      apiKey: "k",
      baseUrl: "https://mimo.test/v1",
      model: "mimo-v2.5-tts",
      voice: "冰糖",
      stylePrompt: "",
      format: "mp3",
      concurrency: 2,
    })

    // Park synthesis so nothing drains the budget mid-test.
    sendMessage.mockImplementation(() => new Promise(() => {}))

    await scheduler.setEnabled(true)
    await vi.waitFor(() =>
      expect((scheduler as any).synthesisFingerprintCache?.startsWith("mimo")).toBe(true),
    )

    // A stored concurrency of 2 must cap the pass at 2, not at the old default.
    ;(video as unknown as { currentTime: number }).currentTime = 1
    video.dispatch("seeking")
    video.dispatch("timeupdate")
    await Promise.resolve()

    expect(synthRequests().length).toBeLessThanOrEqual(2)
  })

  it("keeps MiMo's ready buffer at the configured concurrency, whatever the playback rate", async () => {
    const video = createVideo(0)
    video.playbackRate = 4
    const cues = Array.from({ length: 12 }, (_, index) => ({
      start: index * 60_000,
      end: (index + 1) * 60_000,
      translation: `句${index}`,
    }))
    track(...cues)
    const scheduler = createScheduler(video)

    getMimoTtsSettings.mockResolvedValue({
      engine: "mimo",
      apiKey: "k",
      baseUrl: "https://mimo.test/v1",
      model: "mimo-v2.5-tts",
      voice: "冰糖",
      stylePrompt: "",
      format: "mp3",
      concurrency: 4,
    })

    await scheduler.setEnabled(true)
    await vi.waitFor(() =>
      expect((scheduler as any).synthesisFingerprintCache?.startsWith("mimo")).toBe(true),
    )

    // The depth is the user's number at any speed. Scaling it by the rate is what
    // let a 12-concurrency setting read "15 ready" at 1.25x — the readout then
    // measured a derived number instead of the one the user chose.
    expect((scheduler as any).prefetchWindow()).toBe(4)
  })

  it("leaves Edge's budget and window untouched by the MiMo setting", async () => {
    const video = createVideo(0)
    video.playbackRate = 4
    const scheduler = createScheduler(video)
    getMimoTtsSettings.mockResolvedValue({
      engine: "edge",
      apiKey: "",
      baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
      model: "mimo-v2.5-tts",
      voice: "冰糖",
      stylePrompt: "",
      format: "mp3",
      concurrency: 8,
    })
    track({ start: 0, end: 60_000, translation: "你好" })

    await scheduler.setEnabled(true)
    await vi.waitFor(() =>
      expect((scheduler as any).synthesisFingerprintCache?.startsWith("edge")).toBe(true),
    )

    // Edge's own limits stay put: the slider is a MiMo control, and Edge's
    // budget exists to stay under its rate limiter.
    expect((scheduler as any).synthesisConcurrency()).toBe(2)
    expect((scheduler as any).prefetchWindow()).toBe(4)
  })

  it("publishes how much spoken audio is waiting ahead of the playhead", async () => {
    const video = createVideo(0)
    track(
      { start: 0, end: 2_000, translation: "一" },
      { start: 2_000, end: 4_000, translation: "二" },
      { start: 4_000, end: 6_000, translation: "三" },
    )
    const scheduler = createScheduler(video)

    await scheduler.setEnabled(true)
    // Synthesis is immediate in this mock, so the prefetch fills quickly.
    await vi.waitFor(() => expect(subtitlesStore.get(dubbingStateAtom).bufferedCount).toBe(2))

    // Both cues after the active one are ready (Edge's window is 4, so this is a
    // partial fill of it). The cue covering the playhead is being spoken rather
    // than waiting, so it is not part of the buffer.
    expect(subtitlesStore.get(dubbingStateAtom).engine).toBe("edge")
  })

  it("counts only audio that is still ahead of the playhead", async () => {
    const video = createVideo(0)
    track(
      { start: 0, end: 2_000, translation: "一" },
      { start: 2_000, end: 4_000, translation: "二" },
      { start: 4_000, end: 6_000, translation: "三" },
    )
    const scheduler = createScheduler(video)

    await scheduler.setEnabled(true)
    await vi.waitFor(() => expect(subtitlesStore.get(dubbingStateAtom).bufferedCount).toBe(2))

    // Move the playhead into the last cue: everything the buffer holds is now
    // behind it, and a forward-looking readout has to drop to 0.
    ;(video as unknown as { currentTime: number }).currentTime = 5
    video.dispatch("timeupdate")

    expect(subtitlesStore.get(dubbingStateAtom).bufferedCount).toBe(0)
  })

  it("never reads past the configured concurrency when a seek re-exposes cached audio", async () => {
    const video = createVideo(0)
    const cues = Array.from({ length: 40 }, (_, index) => ({
      start: index * 5_000,
      end: (index + 1) * 5_000,
      translation: `句${index}`,
    }))
    track(...cues)
    const scheduler = createScheduler(video)

    getMimoTtsSettings.mockResolvedValue({
      engine: "mimo",
      apiKey: "k",
      baseUrl: "https://mimo.test/v1",
      model: "mimo-v2.5-tts",
      voice: "冰糖",
      stylePrompt: "",
      format: "mp3",
      concurrency: 12,
    })

    await scheduler.setEnabled(true)
    await vi.waitFor(() => expect(subtitlesStore.get(dubbingStateAtom).bufferedCount).toBe(12))

    // Play forward so the window slides and caches clips past it.
    ;(video as unknown as { currentTime: number }).currentTime = 30
    video.dispatch("timeupdate")
    await vi.waitFor(() => expect((scheduler as any).audioCache.size).toBeGreaterThan(12))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const requestsBeforeSeek = synthRequests().length

    // Now drag the playhead back into what is cached. Those clips are held on
    // purpose — seeking back to them stays instant — but they are not extra
    // depth: the buffer holds the window ahead of the *new* position and nothing
    // more, and nothing new is requested for audio it already holds.
    ;(video as unknown as { currentTime: number }).currentTime = 10
    video.dispatch("seeking")

    expect(subtitlesStore.get(dubbingStateAtom).bufferedCount).toBe(12)
    expect(synthRequests().length).toBe(requestsBeforeSeek)
  })

  it("starts no new synthesis while the window is already ready", async () => {
    const video = createVideo(0)
    const cues = Array.from({ length: 20 }, (_, index) => ({
      start: index * 5_000,
      end: (index + 1) * 5_000,
      translation: `句${index}`,
    }))
    track(...cues)
    const scheduler = createScheduler(video)

    getMimoTtsSettings.mockResolvedValue({
      engine: "mimo",
      apiKey: "k",
      baseUrl: "https://mimo.test/v1",
      model: "mimo-v2.5-tts",
      voice: "冰糖",
      stylePrompt: "",
      format: "mp3",
      concurrency: 4,
    })

    await scheduler.setEnabled(true)
    await vi.waitFor(() => expect(subtitlesStore.get(dubbingStateAtom).bufferedCount).toBe(4))
    const requestsWhenFull = synthRequests().length

    // Ticks that find the window ready must not start anything: this is the
    // "request only while ready < the setting" rule the readout is tuned against.
    for (let index = 0; index < 3; index++) {
      video.dispatch("timeupdate")
    }
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(synthRequests().length).toBe(requestsWhenFull)
  })

  it("reports zero buffer and no engine while dubbing is off", async () => {
    const video = createVideo(0)
    track(
      { start: 0, end: 2_000, translation: "一" },
      { start: 2_000, end: 4_000, translation: "二" },
    )
    const scheduler = createScheduler(video)

    await scheduler.setEnabled(true)
    await vi.waitFor(() =>
      expect(subtitlesStore.get(dubbingStateAtom).bufferedCount).toBeGreaterThan(0),
    )

    await scheduler.setEnabled(false)

    const state = subtitlesStore.get(dubbingStateAtom)
    expect(state.bufferedCount).toBe(0)
    expect(state.engine).toBeNull()
  })
})
