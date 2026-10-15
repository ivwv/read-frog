import type { Config } from "@/types/config/config"
import type { TTSConfig } from "@/types/config/tts"
import type { SubtitlesFragment } from "@/utils/subtitles/types"
import { EDGE_TTS_FALLBACK_VOICE, getDefaultTTSVoiceForLanguage } from "@/types/config/tts"
import { getLocalConfig } from "@/utils/config/storage"
import { logger } from "@/utils/logger"
import { getMimoTtsSettings } from "@/utils/mimo-tts/settings"
import { synthesizeSpeech } from "@/utils/tts/synthesize-speech"
import { dubbingStateAtom, subtitlesStore, translatedTrackAtom } from "./atoms"

/** How many cues ahead of the playhead to keep synthesized audio ready. */
const PREFETCH_CUES = 4
/** Time-compression ceiling; browsers refuse playbackRate above roughly this. */
const MAX_PLAYBACK_RATE = 4
/** Speech is never slowed below natural speed: a drawl is worse than a small overrun. */
const MIN_BASE_RATE = 1
/** Floor for a cue window in the rate math, guarding against divide-by-zero. */
const MIN_CUE_DURATION_S = 0.2
/** Rewriting playbackRate every tick is audible churn; ignore deltas below this. */
const RATE_UPDATE_TOLERANCE = 0.03
/** Past a cue's end a sentence may still finish (never cut mid-word) for this long. */
const TAIL_GRACE_MS = 2_000
/** Cross-fade given to an overrunning cue before the next one takes over. */
const FADE_OUT_MS = 120
/** Re-read the config at most this often; the options page edits it live. */
const CONFIG_CACHE_MS = 30_000

interface SynthesizedCue {
  audioBase64: string
  contentType: string
  /**
   * Seconds of speech, learned from the element once its metadata is known.
   * Null until measured — the rate loop simply waits for it rather than guessing.
   */
  duration: number | null
}

export interface SubtitlesDubbingSchedulerOptions {
  videoElement: HTMLVideoElement
}

function cueKey(fragment: SubtitlesFragment): string {
  return `${fragment.start}\0${fragment.end}\0${fragment.translation ?? ""}`
}

/**
 * Reads translated cues aloud with Edge TTS or MiMo TTS, synchronized to the
 * video clock.
 *
 * The clock work is a control loop rather than a one-shot calculation, because a
 * spoken translation and its cue window almost never have the same length: a
 * sentence whose audio is longer than its window has to be sped up (and one that
 * is shorter must not be slowed down), and the ratio drifts as the video plays,
 * is scrubbed, or changes speed. On every tick the loop re-derives the rate from
 * *what is left to say* against *what is left of the window*, so it self-corrects
 * instead of accumulating error:
 *
 * - `baseRate = remainingAudio / remainingWindow`, clamped to [1, MAX]. The
 *   window is measured in video seconds, so the result is multiplied by the
 *   video's own playbackRate to land back in wall-clock seconds per second.
 * - A cue is spoken from its start whenever it opened since the previous tick; a
 *   cue the playhead was already inside (a seek into it, or dubbing switched on
 *   mid-sentence) joins the audio at the matching fraction instead, because
 *   replaying that sentence from its start would overflow the window.
 * - A cue that still overruns (rate capped) is faded out under the next one
 *   rather than cut mid-word, and a sentence is never replayed once finished.
 * - Audio for the next PREFETCH_CUES cues is synthesized ahead of the playhead,
 *   so a seek waits only on whatever is not yet cached.
 */
export class SubtitlesDubbingScheduler {
  private videoElement: HTMLVideoElement
  private configCache: { config: Config; at: number } | null = null

  private enabled = false
  private muteOriginal = false
  /** video.muted as the user left it before dubbing muted the element. */
  private userMutedState: boolean | null = null
  private unsubTranslatedTrack: (() => void) | null = null
  private currentAudio: HTMLAudioElement | null = null
  private currentCueKey: string | null = null
  /** Synthesized audio keyed by cue identity; cleared when the track changes. */
  private audioCache = new Map<string, SynthesizedCue>()
  private inFlight = new Map<string, Promise<void>>()
  private failedKeys = new Set<string>()
  /** Cues already spoken to completion; stops a short sentence from looping. */
  private completedCueKeys = new Set<string>()
  /**
   * Media time the previous tick observed, or null before the first one. This is
   * what tells a cue we caught on time apart from one we were already past.
   */
  private lastObservedTimeMs: number | null = null
  /** Join offset (fraction of its audio) chosen for the cue about to start. */
  private cueJoinFraction = 0
  private runId = 0

  constructor(options: SubtitlesDubbingSchedulerOptions) {
    this.videoElement = options.videoElement
  }

  /** Reads the local config with a short cache so voice edits land without a page reload. */
  private async readConfig(): Promise<Config | null> {
    const now = Date.now()
    if (this.configCache && now - this.configCache.at < CONFIG_CACHE_MS) {
      return this.configCache.config
    }
    const config = await getLocalConfig()
    this.configCache = config ? { config, at: now } : null
    return config
  }

  isEnabled(): boolean {
    return this.enabled
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (enabled === this.enabled) return

    if (enabled) {
      await this.start()
    } else {
      this.stop()
    }
  }

  async setMuteOriginal(mute: boolean): Promise<void> {
    this.muteOriginal = mute
    if (!this.enabled) return
    if (mute) {
      this.rememberUserMutedState()
    }
    this.applyMuteState()
  }

  /** Drop cached audio and stop playback; used when the translated track is replaced. */
  reset(): void {
    this.audioCache.clear()
    this.inFlight.clear()
    this.failedKeys.clear()
    this.completedCueKeys.clear()
    this.stopAudio()
    this.currentCueKey = null
    this.cueJoinFraction = 0
    this.lastObservedTimeMs = null
    this.publishState()
  }

  destroy(): void {
    this.runId++
    this.stop()
  }

  private async start(): Promise<void> {
    const runId = ++this.runId
    this.enabled = true
    this.publishState()

    // The mute preference lives in config; read it once per enable.
    try {
      const config = await getLocalConfig()
      if (runId !== this.runId) return
      this.muteOriginal = config?.videoSubtitles.dubbing.muteOriginal ?? false
      if (config) this.configCache = { config, at: Date.now() }
    } catch {
      // Keep the previous value; muting is best-effort.
    }

    this.rememberUserMutedState()
    this.applyMuteState()

    if (!this.unsubTranslatedTrack) {
      this.unsubTranslatedTrack = subtitlesStore.sub(translatedTrackAtom, () => {
        this.handleTrackChange()
      })
    }

    this.attachVideoListeners()
    this.tick()
  }

  private stop(): void {
    this.enabled = false
    this.runId++
    this.stopAudio()
    this.currentCueKey = null
    this.completedCueKeys.clear()
    // A fresh enable has observed nothing yet, so a cue already underway is
    // treated as a late entry rather than one caught on time.
    this.lastObservedTimeMs = null
    this.cueJoinFraction = 0
    this.detachVideoListeners()
    this.unsubTranslatedTrack?.()
    this.unsubTranslatedTrack = null
    this.restoreUserMutedState()
    this.publishState()
  }

  /**
   * Translation batches land continuously, so the track atom is re-set often.
   * Drop audio whose cue disappeared (a recut, or a source switch) but keep the
   * sentence that is playing — reloading it would restart speech mid-word.
   */
  private handleTrackChange(): void {
    const track = subtitlesStore.get(translatedTrackAtom)
    const liveKeys = new Set(track.map(cueKey))

    for (const key of [...this.audioCache.keys()]) {
      if (!liveKeys.has(key)) this.audioCache.delete(key)
    }
    for (const key of [...this.completedCueKeys]) {
      if (!liveKeys.has(key)) this.completedCueKeys.delete(key)
    }

    if (this.currentCueKey !== null && !liveKeys.has(this.currentCueKey)) {
      this.stopAudio(FADE_OUT_MS)
      this.currentCueKey = null
    }
  }

  private rememberUserMutedState(): void {
    if (this.userMutedState === null) {
      this.userMutedState = this.videoElement.muted
    }
  }

  private restoreUserMutedState(): void {
    if (this.userMutedState !== null) {
      this.videoElement.muted = this.userMutedState
      this.userMutedState = null
    }
  }

  private applyMuteState(): void {
    if (!this.enabled) return
    if (this.muteOriginal) {
      this.videoElement.muted = true
    } else if (this.userMutedState !== null) {
      this.videoElement.muted = this.userMutedState
    }
  }

  private attachVideoListeners(): void {
    this.videoElement.addEventListener("seeking", this.handleSeek)
    this.videoElement.addEventListener("pause", this.handlePause)
    this.videoElement.addEventListener("play", this.handlePlay)
    this.videoElement.addEventListener("ratechange", this.handleRateChange)
    this.videoElement.addEventListener("timeupdate", this.tick)
  }

  private detachVideoListeners(): void {
    this.videoElement.removeEventListener("seeking", this.handleSeek)
    this.videoElement.removeEventListener("pause", this.handlePause)
    this.videoElement.removeEventListener("play", this.handlePlay)
    this.videoElement.removeEventListener("ratechange", this.handleRateChange)
    this.videoElement.removeEventListener("timeupdate", this.tick)
  }

  private handleSeek = () => {
    this.stopAudio()
    this.currentCueKey = null
    // Seeking is an explicit jump: sentences may be listened to again.
    this.completedCueKeys.clear()
    // The tick below deliberately runs with the *pre-seek* baseline still in
    // place, so a seek that lands inside a cue is recognised as a late entry and
    // joins part-way rather than replaying the sentence from the top.
    this.tick()
  }

  private handlePause = () => {
    this.currentAudio?.pause()
  }

  private handlePlay = () => {
    // Only resume if we are still within the cue we paused in.
    const audio = this.currentAudio
    if (!audio || this.currentCueKey === null) return
    const cue = this.findCueByKey(this.currentCueKey)
    const timeMs = this.videoElement.currentTime * 1000
    if (cue && timeMs >= cue.start && timeMs <= cue.end) {
      this.applyAdaptiveRate(cue)
      void audio.play().catch(() => {})
    }
  }

  private handleRateChange = () => {
    const audio = this.currentAudio
    if (!audio || this.currentCueKey === null) return
    const cue = this.findCueByKey(this.currentCueKey)
    if (cue) {
      this.applyAdaptiveRate(cue)
    }
  }

  private findCueByKey(key: string): SubtitlesFragment | null {
    return subtitlesStore.get(translatedTrackAtom).find((f) => cueKey(f) === key) ?? null
  }

  private tick = (): void => {
    if (!this.enabled) return
    const track = subtitlesStore.get(translatedTrackAtom)
    if (track.length === 0) return

    const timeMs = this.videoElement.currentTime * 1000
    const activeCue = this.findActiveCue(track, timeMs)

    if (activeCue) {
      this.playCue(activeCue, timeMs)
      this.applyAdaptiveRate(activeCue)
    } else {
      // Between cues. A sentence that is still speaking is allowed to finish —
      // cutting it mid-word is worse than a short overrun — but the loop keeps
      // compressing it, and a runaway one is eventually dropped.
      const playingCue = this.currentCueKey ? this.findCueByKey(this.currentCueKey) : null
      if (playingCue) {
        if (timeMs > playingCue.end + TAIL_GRACE_MS) {
          this.stopAudio(FADE_OUT_MS)
        } else {
          this.applyAdaptiveRate(playingCue)
        }
      }
    }

    this.prefetchAhead(track, activeCue)
    // Recorded last: playCue above needs the *previous* tick's value to tell a
    // cue that opened since that look from one it was already past.
    this.lastObservedTimeMs = timeMs
  }

  private findActiveCue(track: SubtitlesFragment[], timeMs: number): SubtitlesFragment | null {
    return track.find((f) => f.start <= timeMs && f.end > timeMs && !!f.translation) ?? null
  }

  private playCue(cue: SubtitlesFragment, timeMs: number): void {
    const key = cueKey(cue)

    // Already speaking this cue, or it was spoken to the end: nothing to start.
    // (Without the completed-set a short sentence in a long cue would loop.)
    if (key === this.currentCueKey && this.currentAudio) return
    if (this.completedCueKeys.has(key)) return

    // Decided once, when the cue is first targeted: a deferred cue is only
    // started after synthesis, by which point the playhead has moved on, and the
    // question is what was missed when the cue was found — not the wait after.
    if (key !== this.currentCueKey) {
      this.cueJoinFraction = this.computeJoinFraction(cue, timeMs)
    }

    const cached = this.audioCache.get(key)
    if (!cached) {
      // Audio not ready yet. Prefetch only covers cues AFTER this one, so the
      // active cue has to synthesize here; when it lands, synthesizeCue
      // re-ticks and this method runs again with the cache populated.
      this.currentCueKey = key
      void this.synthesizeCue(cue)
      return
    }

    this.startCue(cue, cached)
  }

  private startCue(cue: SubtitlesFragment, entry: SynthesizedCue): void {
    const key = cueKey(cue)
    // Cross-fade rather than cut, in case the previous sentence overran.
    this.stopAudio(FADE_OUT_MS)
    this.currentCueKey = key

    const audio = new Audio(`data:${entry.contentType};base64,${entry.audioBase64}`)
    audio.volume = 1
    this.currentAudio = audio

    this.attachCueAudioListeners(audio, entry, cue, this.cueJoinFraction)

    // Start immediately to keep latency low; the settle pass corrects the rate
    // (and the join position) as soon as the duration is known.
    if (!this.videoElement.paused) {
      void audio.play().catch(() => {})
    }
  }

  /**
   * Brings a cue's element up to date: learns its true duration, places the
   * playhead (mid-cue join, or back to the start after a probe), then hands the
   * rate loop its first target.
   */
  private attachCueAudioListeners(
    audio: HTMLAudioElement,
    entry: SynthesizedCue,
    cue: SubtitlesFragment,
    joinFraction: number,
  ): void {
    const key = cueKey(cue)
    let positionApplied = false
    let probed = false
    // Set while a probe parks the element at its end, so the resulting `ended`
    // event is not mistaken for the sentence having been spoken.
    let probing = false

    const settle = () => {
      if (this.currentAudio !== audio) return
      const duration = this.measureDuration(audio, entry)

      if (duration === null) {
        // An MP3 data: URL can report Infinity until the browser has scanned to
        // the end. Seeking far past the end forces the real value out, and
        // `durationchange` calls us back. Guarded by `probed`, and the playhead
        // is repositioned below, so this can never skip real audio.
        if (!probed) {
          probed = true
          probing = true
          try {
            audio.currentTime = 1e6
          } catch {
            // Non-seekable source; the rate loop stays at natural speed.
          }
        }
        return
      }

      probing = false

      if (entry.duration === null) entry.duration = duration

      if (!positionApplied) {
        positionApplied = true
        // After a probe the element sits at the end, so the start position has
        // to be written explicitly even when the cue begins at its own start.
        if (probed || joinFraction > 0) {
          this.seekIntoAudio(audio, entry, joinFraction)
        }
      }

      this.applyAdaptiveRate(cue)

      // A late-arriving duration can mean playback was never kicked off.
      if (!this.videoElement.paused && audio.paused && !audio.ended) {
        void audio.play().catch(() => {})
      }
    }

    audio.addEventListener("loadedmetadata", settle)
    audio.addEventListener("durationchange", settle)
    audio.addEventListener("ended", () => {
      // An `ended` produced by the duration probe is not the sentence finishing.
      if (probing) {
        probing = false
        settle()
        return
      }
      // Playback end is the one duration measurement that cannot lie.
      if (audio.currentTime > 0) entry.duration = audio.currentTime
      this.completedCueKeys.add(key)
      if (this.currentAudio === audio) this.currentAudio = null
    })

    settle()
  }

  /**
   * How far into a cue its audio should join, as a fraction of the sentence.
   *
   * Zero means "say the whole thing", which is right whenever the cue opened
   * since the previous tick: the only part of it we can have missed is the gap
   * between ticks, and the audio is compressed to fit the window anyway.
   *
   * A cue that was *already* underway at the previous tick was missed for a real
   * reason — dubbing just switched on mid-sentence, or the playhead was seeked
   * into it — so the sentence joins part-way instead of overrunning what is left
   * of its window. A null baseline means nothing has been observed yet, which is
   * the switched-on-mid-cue case.
   *
   * The distinction is drawn against the previous tick rather than a fixed
   * tolerance because `timeupdate` is paced in *wall-clock* time (~250 ms, per
   * spec 15-250 ms): in media seconds the step between ticks is
   * `playbackRate x 250 ms`, so any constant bound is exceeded by the ordinary
   * detection lag as soon as the video plays above 1x — which is what made every
   * cue look like a mid-sentence entry and clip its opening words.
   */
  private computeJoinFraction(cue: SubtitlesFragment, timeMs: number): number {
    const missedMs = timeMs - cue.start
    if (missedMs <= 0) return 0

    const previousTimeMs = this.lastObservedTimeMs
    if (previousTimeMs !== null && cue.start > previousTimeMs) return 0

    const cueDurationMs = Math.max(cue.end - cue.start, 1)
    return Math.min(missedMs / cueDurationMs, 0.9)
  }

  /**
   * Seconds of speech for a cue. The element's own duration is authoritative
   * once known; before that we fall back to whatever the entry recorded (which
   * startCue fills in as soon as metadata or playback end reveals it).
   */
  private measureDuration(
    audio: HTMLAudioElement | null,
    entry: SynthesizedCue | undefined,
  ): number | null {
    if (audio && Number.isFinite(audio.duration) && audio.duration > 0) {
      return audio.duration
    }
    if (entry && entry.duration !== null && entry.duration > 0) return entry.duration
    return null
  }

  /**
   * Places the element's playhead. The target is written even when it is 0:
   * after a duration probe the element sits at its end, so "back to the start"
   * has to be an explicit assignment or the remaining audio reads as zero.
   */
  private seekIntoAudio(
    audio: HTMLAudioElement,
    entry: SynthesizedCue,
    fraction: number,
  ): void {
    const duration = this.measureDuration(audio, entry)
    if (duration === null) return
    const target = Math.min(Math.max(fraction * duration, 0), Math.max(duration - 0.5, 0))
    audio.currentTime = target
  }

  /**
   * The synchronization core: aim the remaining speech at the remaining window.
   * Called on every tick, so it converges instead of drifting, and it never
   * slows speech below natural speed.
   */
  private applyAdaptiveRate(cue: SubtitlesFragment): void {
    const audio = this.currentAudio
    if (!audio || audio.ended) return

    const duration = this.measureDuration(audio, this.audioCache.get(cueKey(cue)))
    if (duration === null) {
      // Duration not measured yet; the metadata handler primes the real rate
      // moments later rather than guessing here.
      return
    }

    const videoRate = this.videoElement.playbackRate > 0 ? this.videoElement.playbackRate : 1
    const timeMs = this.videoElement.currentTime * 1000
    const remainingWindowS = (cue.end - timeMs) / 1000

    let baseRate: number
    if (remainingWindowS <= 0) {
      // The window is already gone: sprint so the sentence lands as soon as it can.
      baseRate = MAX_PLAYBACK_RATE
    } else {
      const remainingAudioS = Math.max(duration - audio.currentTime, 0)
      baseRate = remainingAudioS / Math.max(remainingWindowS, MIN_CUE_DURATION_S)
    }

    if (!Number.isFinite(baseRate) || baseRate < MIN_BASE_RATE) {
      baseRate = MIN_BASE_RATE
    }

    // baseRate is in video seconds; multiplying by the video rate converts it to
    // wall-clock seconds, and the cap keeps the browser from rejecting the value.
    const finalRate = Math.min(baseRate * videoRate, MAX_PLAYBACK_RATE)
    if (Math.abs(audio.playbackRate - finalRate) > RATE_UPDATE_TOLERANCE) {
      audio.playbackRate = finalRate
    }
  }

  private prefetchAhead(track: SubtitlesFragment[], activeCue: SubtitlesFragment | null): void {
    const timeMs = this.videoElement.currentTime * 1000
    const startIndex = activeCue ? track.indexOf(activeCue) : -1

    const upcoming: SubtitlesFragment[] = []
    if (activeCue) {
      for (let i = startIndex + 1; i < track.length && upcoming.length < PREFETCH_CUES; i++) {
        const fragment = track[i]!
        if (fragment.translation) upcoming.push(fragment)
      }
    } else {
      // Between cues (or right after a seek): prefetch the next cues from now.
      for (const fragment of track) {
        if (upcoming.length >= PREFETCH_CUES) break
        if (fragment.start >= timeMs && fragment.translation) upcoming.push(fragment)
      }
    }

    for (const fragment of upcoming) {
      void this.synthesizeCue(fragment)
    }
    this.publishState()
  }

  private async synthesizeCue(fragment: SubtitlesFragment): Promise<void> {
    const key = cueKey(fragment)
    if (this.audioCache.has(key) || this.inFlight.has(key) || this.failedKeys.has(key)) {
      return
    }

    const runId = this.runId
    const deferred = (() => {
      let resolve: () => void
      const promise = new Promise<void>((r) => {
        resolve = r
      })
      return { promise, resolve: resolve! }
    })()
    this.inFlight.set(key, deferred.promise)

    try {
      // Failures throw and are reported by the catch below, which logs the
      // engine's own error code; there is no null result to branch on.
      const audio = await this.synthesize(fragment.translation!)
      if (runId !== this.runId) return
      this.audioCache.set(key, { ...audio, duration: null })
      // Synthesis may have completed a cue the playhead is already inside
      // (e.g. dubbing was just enabled); re-evaluate what should be playing.
      if (this.enabled && key === this.currentCueKey) {
        this.tick()
      }
    } catch (error) {
      if (runId === this.runId) {
        this.failedKeys.add(key)
        logger.warn("[SubtitlesDubbing] synthesis failed", error)
      }
    } finally {
      this.inFlight.delete(key)
      deferred.resolve()
    }
  }

  private async synthesize(text: string): Promise<{ audioBase64: string; contentType: string }> {
    // Read per cue rather than cached like the config: these settings are a
    // single cheap local read, and a voice change should land on the next
    // sentence instead of up to CONFIG_CACHE_MS later.
    const [config, settings] = await Promise.all([this.readConfig(), getMimoTtsSettings()])
    const ttsConfig: TTSConfig = config?.tts ?? ({} as TTSConfig)
    const targetLanguage = config?.language.targetCode

    return synthesizeSpeech({
      text,
      ttsConfig,
      settings,
      // Only reached on the Edge path; MiMo uses the voice in `settings`.
      resolveEdgeVoice: async () =>
        (targetLanguage ? getDefaultTTSVoiceForLanguage(targetLanguage) : undefined) ??
        ttsConfig.defaultVoice ??
        EDGE_TTS_FALLBACK_VOICE,
    })
  }

  /**
   * Stops the current element, optionally over a short fade so a handover to the
   * next cue is heard as a dip rather than a chopped word.
   */
  private stopAudio(fadeOutMs = 0): void {
    const audio = this.currentAudio
    if (!audio) return
    this.currentAudio = null

    if (fadeOutMs <= 0 || audio.paused) {
      this.releaseAudio(audio)
      return
    }

    const steps = 4
    let step = 0
    const timer = setInterval(() => {
      step++
      audio.volume = Math.max(0, 1 - step / steps)
      if (step >= steps) {
        clearInterval(timer)
        this.releaseAudio(audio)
      }
    }, Math.max(fadeOutMs / steps, 16))
  }

  private releaseAudio(audio: HTMLAudioElement): void {
    audio.pause()
    audio.src = ""
  }

  private publishState(): void {
    subtitlesStore.set(dubbingStateAtom, {
      enabled: this.enabled,
      readyCount: this.audioCache.size,
    })
  }
}
