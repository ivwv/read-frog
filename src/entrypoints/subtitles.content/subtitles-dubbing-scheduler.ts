import type { Config } from "@/types/config/config"
import type { TTSConfig } from "@/types/config/tts"
import type { SubtitlesFragment } from "@/utils/subtitles/types"
import { getDefaultTTSVoiceForLanguage } from "@/types/config/tts"
import { getLocalConfig } from "@/utils/config/storage"
import { sendMessage } from "@/utils/message"
import { logger } from "@/utils/logger"
import { dubbingStateAtom, subtitlesStore, translatedTrackAtom } from "./atoms"

/** How many cues ahead of the playhead to keep synthesized audio ready. */
const PREFETCH_CUES = 4
/** Hard ceiling for time-compression; browsers reject playbackRate above ~4. */
const MAX_PLAYBACK_RATE = 4
/** A cue shorter than this compresses to garbage; clamp instead. */
const MIN_CUE_DURATION_S = 0.2
/** Skip cues whose window already ended this far in the past (ms after seek). */
const STALE_CUE_TOLERANCE_MS = 500
/** Re-read the config at most this often; the options page edits it live. */
const CONFIG_CACHE_MS = 30_000

interface SynthesizedCue {
  audioBase64: string
  contentType: string
}

export interface SubtitlesDubbingSchedulerOptions {
  videoElement: HTMLVideoElement
}

function cueKey(fragment: SubtitlesFragment): string {
  return `${fragment.start}\0${fragment.end}\0${fragment.translation ?? ""}`
}

function toSignedValue(value: number, unit: "%" | "Hz"): string {
  return `${value >= 0 ? "+" : ""}${value}${unit}`
}

/**
 * Reads translated cues aloud with Edge TTS, synchronized to the video clock.
 *
 * - Subscribes to `translatedTrackAtom` (the scheduler's translated cues) and
 *   prefetches audio for the next PREFETCH_CUES cues, so a seek only waits on
 *   synthesis for whatever is not yet cached.
 * - On each cue entry plays its audio, time-compressed into the cue window when
 *   the audio is longer (never stretched below 1x — slow speech sounds worse
 *   than an overrun), and multiplied by the video's own playbackRate.
 * - Muting is applied to `videoElement.muted` only while the feature is on,
 *   restoring whatever the user had when it turns off.
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

  /** Drop cached audio and stop playback; used when the translated track changes. */
  reset(): void {
    this.audioCache.clear()
    this.inFlight.clear()
    this.failedKeys.clear()
    this.stopAudio()
    this.currentCueKey = null
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
        // A recut or a source switch invalidates every cached cue.
        this.reset()
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
    this.detachVideoListeners()
    this.unsubTranslatedTrack?.()
    this.unsubTranslatedTrack = null
    this.restoreUserMutedState()
    this.publishState()
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
      void audio.play().catch(() => {})
    }
  }

  private handleRateChange = () => {
    const audio = this.currentAudio
    if (!audio || this.currentCueKey === null) return
    const cue = this.findCueByKey(this.currentCueKey)
    if (cue) {
      this.applyPlaybackRate(audio, cue)
    }
  }

  private findCueByKey(key: string): SubtitlesFragment | null {
    return (
      subtitlesStore.get(translatedTrackAtom).find((f) => cueKey(f) === key) ?? null
    )
  }

  private tick = (): void => {
    if (!this.enabled) return
    const track = subtitlesStore.get(translatedTrackAtom)
    if (track.length === 0) return

    const timeMs = this.videoElement.currentTime * 1000
    const activeCue = this.findActiveCue(track, timeMs)

    if (activeCue) {
      this.playCue(activeCue)
    } else if (this.currentAudio && !this.currentAudio.paused) {
      // Tolerance band so a gap between cues does not clip the tail of speech.
      const cue = this.currentCueKey ? this.findCueByKey(this.currentCueKey) : null
      if (!cue || timeMs > cue.end + STALE_CUE_TOLERANCE_MS) {
        this.stopAudio()
      }
    }

    this.prefetchAhead(track, activeCue)
  }

  private findActiveCue(track: SubtitlesFragment[], timeMs: number): SubtitlesFragment | null {
    return track.find((f) => f.start <= timeMs && f.end > timeMs && !!f.translation) ?? null
  }

  private playCue(cue: SubtitlesFragment): void {
    const key = cueKey(cue)
    if (key === this.currentCueKey && this.currentAudio && !this.currentAudio.ended) {
      // Already playing this cue (or paused in it); rate changes handled elsewhere.
      return
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

    this.stopAudio()
    this.currentCueKey = key

    const audio = new Audio(`data:${cached.contentType};base64,${cached.audioBase64}`)
    this.currentAudio = audio

    audio.addEventListener("loadedmetadata", () => {
      if (this.currentAudio === audio && !Number.isNaN(audio.duration)) {
        this.applyPlaybackRate(audio, cue)
      }
    })
    audio.addEventListener("ended", () => {
      if (this.currentAudio === audio) {
        this.currentAudio = null
      }
    })

    if (!this.videoElement.paused) {
      this.applyPlaybackRate(audio, cue)
      void audio.play().catch(() => {})
    }
  }

  /**
   * Time-compress the audio into the cue window. Only ever speeds up (an
   * overrun into the next cue beats slow-motion speech), and stacks with the
   * video's own playbackRate.
   */
  private applyPlaybackRate(audio: HTMLAudioElement, cue: SubtitlesFragment): void {
    const cueDurationS = Math.max((cue.end - cue.start) / 1000, MIN_CUE_DURATION_S)
    const audioDuration = audio.duration
    if (!audioDuration || Number.isNaN(audioDuration)) return

    let baseRate = audioDuration / cueDurationS
    if (baseRate < 1) baseRate = 1

    audio.playbackRate = Math.min(baseRate * this.videoElement.playbackRate, MAX_PLAYBACK_RATE)
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
      const audioBase64 = await this.synthesize(fragment.translation!)
      if (runId !== this.runId) return
      if (audioBase64 === null) {
        this.failedKeys.add(key)
      } else {
        this.audioCache.set(key, audioBase64)
        // Synthesis may have completed a cue the playhead is already inside
        // (e.g. dubbing was just enabled); re-evaluate what should be playing.
        if (this.enabled && key === this.currentCueKey) {
          this.tick()
        }
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

  private async synthesize(
    text: string,
  ): Promise<{ audioBase64: string; contentType: string } | null> {
    const config = await this.readConfig()
    const ttsConfig: TTSConfig = config?.tts ?? ({} as TTSConfig)
    const targetLanguage = config?.language.targetCode
    const voice =
      (targetLanguage ? getDefaultTTSVoiceForLanguage(targetLanguage) : undefined) ??
      ttsConfig.defaultVoice ??
      "en-US-AndrewMultilingualNeural"

    const response = await sendMessage("edgeTtsSynthesize", {
      text,
      voice,
      rate: toSignedValue(ttsConfig.rate ?? 0, "%"),
      pitch: toSignedValue(ttsConfig.pitch ?? 0, "Hz"),
      volume: toSignedValue(ttsConfig.volume ?? 0, "%"),
    })

    if (!response.ok || !response.audioBase64) {
      return null
    }
    return { audioBase64: response.audioBase64, contentType: response.contentType }
  }

  private stopAudio(): void {
    if (this.currentAudio) {
      this.currentAudio.pause()
      this.currentAudio.src = ""
      this.currentAudio = null
    }
  }

  private publishState(): void {
    subtitlesStore.set(dubbingStateAtom, {
      enabled: this.enabled,
      readyCount: this.audioCache.size,
    })
  }
}
