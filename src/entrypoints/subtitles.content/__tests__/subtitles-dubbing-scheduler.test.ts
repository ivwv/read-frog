import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  DEFAULT_DUBBING_AUDIO_SETTINGS,
  saveDubbingAudioSettings,
} from "@/utils/subtitles/dubbing-audio"
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
  beforeEach(async () => {
    vi.clearAllMocks()
    audioInstances = []
    audioStubQueue = []
    liveSchedulers = []
    installAudioGlobal()
    mockSynthesizeSuccess()
    mockConfig()
    // The levels live in storage, which outlives a test; reset them so one
    // test's setting cannot decide another's expectations.
    await saveDubbingAudioSettings(DEFAULT_DUBBING_AUDIO_SETTINGS)
    subtitlesStore.set(translatedTrackAtom, [])
    subtitlesStore.set(dubbingStateAtom, { enabled: false, readyCount: 0 })
  })

  afterEach(() => {
    // Unsubscribe before the store is touched again, or a stale scheduler reacts
    // to the reset below (see `liveSchedulers`).
    for (const scheduler of liveSchedulers) {
      scheduler.destroy()
    }
    liveSchedulers = []
    vi.unstubAllGlobals()
    subtitlesStore.set(translatedTrackAtom, [])
    subtitlesStore.set(dubbingStateAtom, { enabled: false, readyCount: 0 })
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

    await scheduler.setEnabled(true)
    await vi.waitFor(() => expect(sendMessage.mock.calls.length).toBeGreaterThan(0))

    // One request per cue may be in flight at a time; a burst is what trips
    // Edge TTS rate limiting and its circuit breaker.
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
})
