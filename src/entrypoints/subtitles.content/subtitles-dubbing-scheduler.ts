import type { Config } from "@/types/config/config"
import type { TTSConfig } from "@/types/config/tts"
import type { MimoTtsEngine, MimoTtsSettings } from "@/utils/mimo-tts/types"
import type { SubtitlesFragment } from "@/utils/subtitles/types"
import { EDGE_TTS_FALLBACK_VOICE, getDefaultTTSVoiceForLanguage } from "@/types/config/tts"
import { getLocalConfig } from "@/utils/config/storage"
import { logger } from "@/utils/logger"
import { DEFAULT_MIMO_TTS_CONCURRENCY } from "@/utils/mimo-tts/constants"
import { getMimoTtsSettings } from "@/utils/mimo-tts/settings"
import { getDubbingAudioSettings, toElementVolume } from "@/utils/subtitles/dubbing-audio"
import { synthesizeSpeech } from "@/utils/tts/synthesize-speech"
import { adPlayingAtom, dubbingStateAtom, subtitlesStore, translatedTrackAtom } from "./atoms"

/**
 * How many cues ahead of the playhead to keep synthesized audio ready, for
 * Edge TTS. MiMo's window is derived from its configured concurrency instead:
 * see `prefetchWindow()`.
 */
const PREFETCH_CUES = 4
/** Most synthesis requests in flight at once (the active cue plus prefetch). */
const MAX_CONCURRENT_SYNTHESIS = 2
/**
 * MiMo's concurrency is a user setting (`MimoTtsSettings.concurrency`) rather
 * than a constant: throughput is `concurrency / latency`, so the budget that
 * keeps up at 1x falls permanently behind at 2x-4x. `DEFAULT_MIMO_TTS_CONCURRENCY`
 * in `@/utils/mimo-tts/constants` is the fallback before settings are read.
 */
/** Time-compression ceiling; browsers refuse playbackRate above roughly this. */
const MAX_PLAYBACK_RATE = 4
/**
 * Cache ceiling by entry count. With Edge TTS's 48 kbit/s MP3 (~32 KB per
 * four-second cue including base64) this bounds the cache around 2 MB, plenty
 * for seek-back-within-a-minute plus the prefetch window.
 */
const MAX_CACHE_ENTRIES = 64
/**
 * Cache ceiling by resident bytes, for engines whose clips are far larger per
 * cue (MiMo WAV is ~48 KB/s of PCM). Measured on the decoded blob, which is the
 * memory a cached clip actually holds.
 */
const MAX_CACHE_BYTES = 12 * 1024 * 1024
/**
 * Cues that ended this long before the playhead stay cached, so dragging back
 * a little to re-hear a sentence is still instant. Beyond that they are
 * dropped: the seek handler clears `completedCueKeys` anyway, so a far seek
 * re-synthesizes regardless.
 */
const CACHE_KEEP_BEHIND_MS = 90_000
/**
 * A transiently failed synthesis (rate limit, network blip) becomes eligible
 * for a retry after this long. Without a window, one 429 silenced that cue
 * for the rest of the video.
 */
const FAILED_RETRY_MS = 15_000
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
  /**
   * Object URL of the decoded clip, and the only handle playback needs.
   *
   * The base64 the engine returns is decoded once, here, rather than kept and
   * re-wrapped in a `data:` URL per play: that held two copies of every clip (the
   * cached string plus the URL built from it) and made the media pipeline re-parse
   * base64 on each play. A blob is the bytes themselves, and Chrome may page it
   * out of the JS heap.
   *
   * Owned by the cache: revoked when the entry is dropped, never on element
   * teardown, because a cached clip can be played again after a seek.
   */
  objectUrl: string
  /** Decoded size in bytes, for the cache's budget. */
  byteLength: number
  /**
   * Seconds of speech, learned from the element once its metadata is known.
   * Null until measured — the rate loop simply waits for it rather than guessing.
   */
  duration: number | null
  /**
   * Bare cue identity (see `cueKey`), kept alongside the map key because the
   * key also carries the synthesis fingerprint — which itself contains the
   * separator, so the identity cannot be recovered by splitting it back off.
   */
  cueIdentity: string
  /** Cue window, kept so cache eviction and the buffer readout can use the playhead. */
  start: number
  end: number
}

/**
 * Decodes a synthesized clip into a blob URL.
 *
 * Throws on a payload that decodes to nothing, which routes it through the same
 * failure path as an engine error — an empty clip must not be cached as a hit, or
 * that cue would stay silent for good.
 */
function decodeClipToObjectUrl(
  audioBase64: string,
  contentType: string,
): { objectUrl: string; byteLength: number } {
  const binary = atob(audioBase64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index)
  }
  if (bytes.byteLength === 0) {
    throw new Error("Synthesized audio decoded to zero bytes")
  }
  return {
    objectUrl: URL.createObjectURL(new Blob([bytes], { type: contentType })),
    byteLength: bytes.byteLength,
  }
}

/** Failure bookkeeping with an expiry, so transient errors can be retried. */
interface FailedCue {
  failedAt: number
}

/** How far a cached cue's window sits from the playhead, in ms. */
function distanceFromPlayhead(entry: { end: number }, nowMs: number): number {
  if (!Number.isFinite(nowMs)) return entry.end
  // Measured to the cue's end: behind the playhead that is its nearest edge,
  // and ahead of it the end is at least as far as the start.
  return Math.abs(entry.end - nowMs)
}

export interface SubtitlesDubbingSchedulerOptions {
  videoElement: HTMLVideoElement
}

function cueKey(fragment: SubtitlesFragment): string {
  return `${fragment.start}\0${fragment.end}\0${fragment.translation ?? ""}`
}

/**
 * Everything about the synthesis inputs, other than the text, that changes the
 * produced bytes: the engine plus the parameters it reads. Cached audio is
 * keyed by this too, so switching the engine or the voice does not keep
 * speaking the old clips (mirrors what the read-aloud hook puts in its query
 * key — see `use-text-to-speech`).
 */
function synthesisFingerprint(config: TTSConfig | null, settings: MimoTtsSettings): string {
  if (settings.engine === "mimo") {
    return [
      "mimo",
      settings.model,
      settings.voice,
      settings.stylePrompt.trim(),
      settings.format,
    ].join("\0")
  }
  return ["edge", config?.rate ?? 0, config?.pitch ?? 0, config?.volume ?? 0].join("\0")
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
  /** video.volume as the user left it before dubbing took the element over. */
  private userVolumeState: number | null = null
  /** The video's own level while dubbing plays and it is not muted. */
  private originalVolume = 1
  /** The level the spoken translation is played at. */
  private dubbingVolume = 1
  private unsubTranslatedTrack: (() => void) | null = null
  private unsubAdPlaying: (() => void) | null = null
  private currentAudio: HTMLAudioElement | null = null
  private currentCueKey: string | null = null
  /**
   * Tears down the element that is currently playing, listeners included.
   *
   * Every release goes through this rather than calling `releaseAudio` directly,
   * so there is one teardown path: a second one that skipped the listeners is
   * what let a released element's late `error` be read as its clip failing.
   */
  private disposeCurrentAudio: (() => void) | null = null
  /** Synthesized audio keyed by fingerprint+cue identity; trimmed by budget and position. */
  private audioCache = new Map<string, SynthesizedCue>()
  /** The synthesis inputs the cache was built with; a change invalidates it. */
  private synthesisFingerprintCache: string | null = null
  /**
   * MiMo concurrency as last read from settings. `prefetchAhead` is synchronous
   * and runs on every tick, so the value is cached here by `synthesize` (which
   * already reads the settings per cue) rather than awaited per tick.
   */
  private mimoConcurrency = DEFAULT_MIMO_TTS_CONCURRENCY
  private inFlight = new Map<string, Promise<void>>()
  private failedKeys = new Map<string, FailedCue>()
  /** Cues already spoken to completion; stops a short sentence from looping. */
  private completedCueKeys = new Set<string>()
  /**
   * True while dubbing is enabled but has not actually spoken yet. The video
   * element is left untouched until the first cue's audio really starts, so a
   * slow translation pipeline (or a failed one) is heard as the original audio
   * continuing, never as a mute-then-silence gap.
   */
  private mutePending = false
  /**
   * Media time the previous tick observed, or null before the first one. This is
   * what tells a cue we caught on time apart from one we were already past.
   */
  private lastObservedTimeMs: number | null = null
  /** Join offset (fraction of its audio) chosen for the cue about to start. */
  private cueJoinFraction = 0
  private runId = 0
  /** Last object handed to `dubbingStateAtom`, so unchanged states skip the write. */
  private lastPublishedState: {
    enabled: boolean
    readyCount: number
    failingSince: number | null
    bufferedCount: number
    engine: MimoTtsEngine | null
  } | null = null
  /** First failure in the current streak, null after any success. */
  private failingSince: number | null = null

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
    // While mute is pending (dubbing armed but not yet speaking) the video is
    // still playing its own audio at the user's level; the stored state is
    // applied when the first cue commits the takeover.
    if (!this.mutePending) {
      this.applyMuteState()
    }
  }

  /** Takes a 0-100 level, the same scale the settings panel and storage use. */
  async setOriginalVolume(percent: number): Promise<void> {
    this.originalVolume = toElementVolume(percent)
    if (!this.enabled || this.mutePending) return
    this.applyMuteState()
  }

  /** Takes a 0-100 level; a sentence already speaking follows the slider. */
  async setDubbingVolume(percent: number): Promise<void> {
    this.dubbingVolume = toElementVolume(percent)
    if (this.currentAudio) {
      this.currentAudio.volume = this.dubbingVolume
    }
  }

  /** Drop cached audio and stop playback; used when the translated track is replaced. */
  reset(): void {
    this.clearAudioCache()
    this.inFlight.clear()
    this.failedKeys.clear()
    this.completedCueKeys.clear()
    this.failingSince = null
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
    this.failingSince = null
    this.publishState()

    // The mute and level preferences live outside the config; read them once
    // per enable, before the element is taken over below.
    try {
      const [config, audio, settings] = await Promise.all([
        getLocalConfig(),
        getDubbingAudioSettings(),
        getMimoTtsSettings(),
      ])
      if (runId !== this.runId) return
      this.muteOriginal = config?.videoSubtitles.dubbing.muteOriginal ?? false
      this.originalVolume = toElementVolume(audio.originalVolume)
      this.dubbingVolume = toElementVolume(audio.dubbingVolume)
      if (config) this.configCache = { config, at: Date.now() }
      // Seed the engine before the first tick: `prefetchAhead` sizes its window
      // and budget from these, and waiting for the first synthesis to reveal
      // them made the cold start run on Edge's smaller numbers even under MiMo —
      // exactly the moment the buffer most needs to fill fast.
      this.mimoConcurrency = settings.concurrency
      this.synthesisFingerprintCache = synthesisFingerprint(config?.tts ?? null, settings)
    } catch {
      // Keep the previous values; muting and levels are best-effort.
    }

    this.rememberUserMutedState()
    // Armed, not takeover: the element keeps its own sound until the first cue
    // actually speaks (see startCue), so the pipeline's cold start is covered
    // by the original audio instead of by silence.
    this.mutePending = true

    if (!this.unsubTranslatedTrack) {
      this.unsubTranslatedTrack = subtitlesStore.sub(translatedTrackAtom, () => {
        this.handleTrackChange()
      })
    }
    // An ad plays through the same <video> element on its own timeline, so
    // every cue window below is meaningless while it runs. Stop speaking and
    // hold off until the main video's clock is back.
    if (!this.unsubAdPlaying) {
      this.unsubAdPlaying = subtitlesStore.sub(adPlayingAtom, () => {
        // jotai's subscription callback carries no value; read the atom.
        this.handleAdPlayingChange(subtitlesStore.get(adPlayingAtom))
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
    this.mutePending = false
    this.detachVideoListeners()
    this.unsubTranslatedTrack?.()
    this.unsubTranslatedTrack = null
    this.unsubAdPlaying?.()
    this.unsubAdPlaying = null
    this.restoreUserMutedState()
    this.publishState()
  }

  /** Takes over the video element's sound. Called once the first cue speaks. */
  private commitPendingMute(): void {
    if (!this.mutePending) return
    this.mutePending = false
    this.applyMuteState()
  }

  /**
   * An ad's timeline is not the video's: the cue covering the playhead while an
   * ad runs is the ad's own minute, not the sentence the viewer is meant to
   * hear. Speech stops for the duration, and resumes (from wherever the main
   * clock now sits) when the ad ends.
   */
  private handleAdPlayingChange(playing: boolean): void {
    if (!this.enabled) return
    if (playing) {
      this.stopAudio(FADE_OUT_MS)
      this.currentCueKey = null
    } else {
      // The main clock jumped back; a fresh baseline keeps the first cue after
      // the ad from being read as a mid-sentence join.
      this.lastObservedTimeMs = null
      this.tick()
    }
  }

  /**
   * Translation batches land continuously, so the track atom is re-set often.
   * Drop audio whose cue disappeared (a recut, or a source switch) but keep the
   * sentence that is playing — reloading it would restart speech mid-word.
   */
  private handleTrackChange(): void {
    const track = subtitlesStore.get(translatedTrackAtom)
    const liveKeys = new Set(track.map(cueKey))

    // Cache keys carry the synthesis fingerprint as a prefix, so the identity is
    // compared through the entry rather than the key — see `SynthesizedCue`.
    for (const [key, entry] of [...this.audioCache]) {
      if (!liveKeys.has(entry.cueIdentity)) this.dropCue(key)
    }
    for (const key of [...this.completedCueKeys]) {
      if (!liveKeys.has(key)) this.completedCueKeys.delete(key)
    }

    if (this.currentCueKey !== null && !liveKeys.has(this.currentCueKey)) {
      this.stopAudio(FADE_OUT_MS)
      this.currentCueKey = null
    }

    this.evictCache()

    // Fresh translations can cover the playhead right now, so evaluate what
    // should be speaking instead of waiting for the next timeupdate (up to
    // 250 ms). Nothing below writes the translated track, so this cannot
    // re-enter the subscription that called it.
    if (this.enabled) {
      this.tick()
    }
  }

  private rememberUserMutedState(): void {
    if (this.userMutedState === null) {
      this.userMutedState = this.videoElement.muted
    }
    if (this.userVolumeState === null) {
      this.userVolumeState = this.readVideoVolume()
    }
  }

  /** The element's own level, guarded: it is absent in some test doubles. */
  private readVideoVolume(): number {
    const volume = this.videoElement.volume
    return typeof volume === "number" && Number.isFinite(volume) ? volume : 1
  }

  private restoreUserMutedState(): void {
    if (this.userMutedState !== null) {
      this.videoElement.muted = this.userMutedState
      this.userMutedState = null
    }
    // Put back the level the user had, so turning dubbing off leaves the player
    // exactly as it was found rather than stuck at the dubbing-time level.
    if (this.userVolumeState !== null) {
      this.videoElement.volume = this.userVolumeState
      this.userVolumeState = null
    }
  }

  private applyMuteState(): void {
    if (!this.enabled || this.mutePending) return
    if (this.muteOriginal) {
      this.videoElement.muted = true
      // The level is left alone while muted: there is nothing to hear, and
      // writing it here would make unmuting land on a level the user never set.
      return
    }

    if (this.userMutedState !== null) {
      this.videoElement.muted = this.userMutedState
    }
    this.videoElement.volume = this.originalVolume
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
    // Audio for the position just left is dead weight now (completed cues get
    // re-synthesized on the way back anyway); free it immediately rather than
    // letting it ride along until the next cache insert.
    this.evictCache()
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
      void audio
        .play()
        .then(() => this.commitPendingMute())
        .catch(() => {})
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
    // An ad runs on its own timeline; there is nothing to say against it.
    if (subtitlesStore.get(adPlayingAtom)) return
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

    const cached = this.audioCache.get(this.audioKey(key))
    if (!cached || cached.byteLength === 0) {
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

    // Plays straight from the blob URL: no string is built per play, and the
    // media pipeline reads the bytes rather than decoding base64 first.
    const audio = new Audio(entry.objectUrl)
    audio.volume = this.dubbingVolume
    this.currentAudio = audio

    this.attachCueAudioListeners(audio, entry, cue, this.cueJoinFraction)

    // Start immediately to keep latency low; the settle pass corrects the rate
    // (and the join position) as soon as the duration is known. The mute of the
    // video's own audio rides on this promise: until speech is really flowing,
    // the original audio stays on, which is what makes the takeover seamless.
    if (!this.videoElement.paused) {
      void audio
        .play()
        .then(() => this.commitPendingMute())
        .catch(() => {})
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
    /**
     * Set once this element is torn down. A browser can still report an `error`
     * for the load it was doing when it was released, and reading that as "the
     * clip failed to decode" would drop good audio — and, because the handler
     * also tears the element down, re-enter itself.
     */
    let disposed = false

    const settle = () => {
      if (disposed || this.currentAudio !== audio) return
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
        void audio
          .play()
          .then(() => this.commitPendingMute())
          .catch(() => {})
      }
    }

    /** Tears the element down once, detaching the listeners that drove it. */
    const dispose = () => {
      if (disposed) return
      disposed = true
      if (this.disposeCurrentAudio === dispose) this.disposeCurrentAudio = null
      audio.removeEventListener("loadedmetadata", settle)
      audio.removeEventListener("durationchange", settle)
      audio.removeEventListener("error", handleError)
      audio.removeEventListener("ended", handleEnded)
      this.releaseAudio(audio)
    }

    this.disposeCurrentAudio = dispose

    const handleError = () => {
      if (disposed) return
      dispose()
      // Drop the undecodable bytes. Leaving them cached meant the next tick
      // found a "cached" cue, built another element from the same payload and
      // failed again — one element and one fresh copy of the whole data URL per
      // timeupdate, which is what made a single bad clip grow without bound.
      this.dropCue(this.audioKey(key))
      this.failedKeys.set(key, { failedAt: Date.now() })
      if (this.currentAudio === audio) {
        this.currentAudio = null
        this.currentCueKey = null
      }
      this.publishState()
    }

    const handleEnded = () => {
      if (disposed) return
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
      // Nothing reads the element again, so hand its decoded buffer and its copy
      // of the data URL back now rather than leaving them for the collector.
      dispose()
    }

    audio.addEventListener("loadedmetadata", settle)
    audio.addEventListener("durationchange", settle)
    audio.addEventListener("error", handleError)
    audio.addEventListener("ended", handleEnded)

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

    // Looked up through `audioKey`: the cache is keyed by fingerprint + identity,
    // so a bare cue key silently missed and lost the recorded duration.
    const duration = this.measureDuration(audio, this.audioCache.get(this.audioKey(cueKey(cue))))
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

  /**
   * How many cues ahead to keep ready. The window is at least the concurrency
   * (a request that cannot start this tick is worthless next tick) and, for
   * MiMo, wide enough to cover the video's own speed: at 4x the playhead eats
   * four cues per cue-window, so a fixed window of 4 would drain between ticks.
   */
  private prefetchWindow(): number {
    if (!this.synthesisFingerprintCache?.startsWith("mimo")) {
      return PREFETCH_CUES
    }
    const rate = this.videoElement.playbackRate > 0 ? this.videoElement.playbackRate : 1
    return Math.max(PREFETCH_CUES, Math.ceil(this.mimoConcurrency * Math.min(rate, MAX_PLAYBACK_RATE)))
  }

  /** Synthesis budget for the active engine. */
  private synthesisConcurrency(): number {
    return this.synthesisFingerprintCache?.startsWith("mimo")
      ? this.mimoConcurrency
      : MAX_CONCURRENT_SYNTHESIS
  }

  /** Engine the fingerprint was built for, for the panel's readout. */
  private currentEngine(): MimoTtsEngine | null {
    if (!this.synthesisFingerprintCache) return null
    return this.synthesisFingerprintCache.startsWith("mimo") ? "mimo" : "edge"
  }

  private prefetchAhead(track: SubtitlesFragment[], activeCue: SubtitlesFragment | null): void {
    const timeMs = this.videoElement.currentTime * 1000
    const startIndex = activeCue ? track.indexOf(activeCue) : -1
    const window = this.prefetchWindow()

    const upcoming: SubtitlesFragment[] = []
    if (activeCue) {
      for (let i = startIndex + 1; i < track.length && upcoming.length < window; i++) {
        const fragment = track[i]!
        if (fragment.translation) upcoming.push(fragment)
      }
    } else {
      // Between cues (or right after a seek): prefetch the next cues from now.
      for (const fragment of track) {
        if (upcoming.length >= window) break
        if (fragment.start >= timeMs && fragment.translation) upcoming.push(fragment)
      }
    }

    // Bound the concurrent syntheses: an unbounded burst here is exactly what
    // trips Edge TTS rate limiting (and its circuit breaker) on enable/seek.
    // MiMo's budget is the user's, since its latency is what decides how much
    // parallelism is needed to keep up with the video's speed.
    const slots = this.synthesisConcurrency() - this.inFlight.size
    for (const fragment of slots > 0 ? upcoming.slice(0, slots) : []) {
      void this.synthesizeCue(fragment)
    }
    this.publishState()
  }

  private async synthesizeCue(fragment: SubtitlesFragment): Promise<void> {
    const key = cueKey(fragment)
    if (this.hasUsableCacheFor(key) || this.inFlight.has(key)) {
      return
    }
    const failed = this.failedKeys.get(key)
    if (failed && Date.now() - failed.failedAt < FAILED_RETRY_MS) {
      return
    }
    this.failedKeys.delete(key)

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
      this.failingSince = null
      // Decoded once here, so every later play reads bytes instead of re-parsing
      // base64. A payload that decodes to nothing throws into the catch below.
      const clip = decodeClipToObjectUrl(audio.audioBase64, audio.contentType)
      this.audioCache.set(this.audioKey(key), {
        ...clip,
        duration: null,
        cueIdentity: key,
        start: fragment.start,
        end: fragment.end,
      })
      this.evictCache()
      // Synthesis may have completed a cue the playhead is already inside
      // (e.g. dubbing was just enabled); re-evaluate what should be playing.
      if (this.enabled && key === this.currentCueKey) {
        this.tick()
      } else {
        // Nothing else publishes on a completed prefetch: without this the
        // panel's buffer readout would only move on the next timeupdate, and a
        // paused video would never show it filling.
        this.publishState()
      }
    } catch (error) {
      if (runId === this.runId) {
        this.failedKeys.set(key, { failedAt: Date.now() })
        this.failingSince ??= Date.now()
        logger.warn("[SubtitlesDubbing] synthesis failed", error)
        // The panel's hint keys off the streak; it has to hear about both the
        // failure and (via the success path) the recovery.
        this.publishState()
      }
    } finally {
      this.inFlight.delete(key)
      deferred.resolve()
    }
  }

  /** Cache key for a cue: its identity, prefixed by the current synthesis inputs. */
  private audioKey(cueIdentity: string): string {
    return `${this.synthesisFingerprintCache ?? ""}\0${cueIdentity}`
  }

  /**
   * True when `key` has synthesized audio worth playing. A zero-length clip is
   * not: some engines return an empty payload on failure, and treating it as a
   * hit would silence that cue forever.
   */
  private hasUsableCacheFor(key: string): boolean {
    const entry = this.audioCache.get(this.audioKey(key))
    return !!entry && entry.byteLength > 0
  }

  private cacheBytes(): number {
    let sum = 0
    for (const entry of this.audioCache.values()) {
      sum += entry.byteLength
    }
    return sum
  }

  /**
   * Keeps the audio cache bounded: first by playhead position (cues that ended
   * well behind the playhead go), then by budget until both the entry and byte
   * ceilings hold. The cue currently speaking is never evicted, and eviction
   * only runs at cache-change points, so its cost is a map scan plus,
   * occasionally, a small sort.
   *
   * The budget pass drops by distance from the playhead — furthest first, in
   * either direction — so a seek that leaves the whole cache ahead of the
   * playhead still keeps the cues about to be reached.
   */
  private evictCache(): void {
    if (this.audioCache.size === 0) return

    const nowMs = this.videoElement.currentTime * 1000
    if (Number.isFinite(nowMs)) {
      for (const [key, entry] of this.audioCache) {
        if (key !== this.audioKey(this.currentCueKey ?? "") && entry.end < nowMs - CACHE_KEEP_BEHIND_MS) {
          this.dropCue(key)
        }
      }
    }

    if (this.audioCache.size <= MAX_CACHE_ENTRIES && this.cacheBytes() <= MAX_CACHE_BYTES) {
      return
    }

    const currentKey = this.currentCueKey !== null ? this.audioKey(this.currentCueKey) : null
    const evictable = [...this.audioCache.entries()]
      .filter(([key]) => key !== currentKey)
      .sort((a, b) => distanceFromPlayhead(b[1], nowMs) - distanceFromPlayhead(a[1], nowMs))
    for (const [key] of evictable) {
      if (this.audioCache.size <= MAX_CACHE_ENTRIES && this.cacheBytes() <= MAX_CACHE_BYTES) {
        break
      }
      this.dropCue(key)
    }
  }

  /**
   * Cache-key helpers.
   *
   * Every removal goes through these two, because a dropped entry must revoke its
   * object URL — the blob stays alive for as long as the URL exists, so a plain
   * `delete` would leak the whole clip. Adding a third place that removes entries
   * without revoking reintroduces that leak.
   */
  private dropCue(audioKey: string): void {
    const entry = this.audioCache.get(audioKey)
    if (!entry) return
    URL.revokeObjectURL(entry.objectUrl)
    this.audioCache.delete(audioKey)
  }

  private clearAudioCache(): void {
    for (const entry of this.audioCache.values()) {
      URL.revokeObjectURL(entry.objectUrl)
    }
    this.audioCache.clear()
  }

  private async synthesize(text: string): Promise<{ audioBase64: string; contentType: string }> {
    // Read per cue rather than cached like the config: these settings are a
    // single cheap local read, and a voice change should land on the next
    // sentence instead of up to CONFIG_CACHE_MS later.
    const [config, settings] = await Promise.all([this.readConfig(), getMimoTtsSettings()])
    const ttsConfig: TTSConfig = config?.tts ?? ({} as TTSConfig)
    const targetLanguage = config?.language.targetCode

    // Read here rather than per tick: this is the one place that already awaits
    // the settings, and `prefetchAhead` needs the value synchronously.
    this.mimoConcurrency = settings.concurrency

    // A changed engine or voice invalidates every cached clip: the old bytes
    // encode the old sound. Same idea as the read-aloud hook's query key. The
    // failure records go too — a cue that failed on the old engine deserves a
    // fresh attempt on the new one rather than a 15-second block.
    const fingerprint = synthesisFingerprint(ttsConfig, settings)
    if (fingerprint !== this.synthesisFingerprintCache) {
      this.synthesisFingerprintCache = fingerprint
      this.clearAudioCache()
      this.failedKeys.clear()
    }

    return synthesizeSpeech({
      text,
      ttsConfig,
      settings,
      // Only reached on the Edge path; MiMo uses the voice in `settings`.
      // Order matches the read-aloud hook's `selectTTSVoice` so a voice the
      // user mapped per language in settings is what speaks here too.
      resolveEdgeVoice: async () =>
        (targetLanguage ? ttsConfig.languageVoices?.[targetLanguage] : undefined) ??
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

    // Captured now: a fade outlives this call, and by the time it finishes a new
    // element has already claimed the field.
    const dispose = this.disposeCurrentAudio ?? (() => this.releaseAudio(audio))

    if (fadeOutMs <= 0 || audio.paused) {
      dispose()
      return
    }

    const steps = 4
    let step = 0
    const timer = setInterval(() => {
      step++
      // Fade from the configured level, not from full scale, or a quiet dub
      // would jump to full volume for the length of the fade.
      audio.volume = this.dubbingVolume * Math.max(0, 1 - step / steps)
      if (step >= steps) {
        clearInterval(timer)
        dispose()
      }
    }, Math.max(fadeOutMs / steps, 16))
  }

  /**
   * Hands an element's buffers back.
   *
   * `removeAttribute("src")` + `load()` rather than `src = ""`: the empty string
   * is a URL — it resolves against the document — so assigning it starts a load
   * of the page itself, which fails and raises `error` on the element. Clearing
   * the attribute instead leaves the element with no candidate at all, so no
   * error is reported for a clip that was simply finished with.
   */
  private releaseAudio(audio: HTMLAudioElement): void {
    audio.pause()
    audio.removeAttribute("src")
    audio.load()
  }

  /**
   * Synthesized cues still ahead of the playhead that have not been spoken.
   *
   * This is the depth of audio ready to play, and the readout the user watches:
   * a healthy run holds it near the prefetch window, while a value stuck at 0
   * on a running video means the playhead is outrunning synthesis (a high
   * playback rate against a slow engine). Cues behind the playhead and cues
   * already spoken are excluded — neither is "waiting to be played".
   */
  private bufferedCount(): number {
    const timeMs = this.videoElement.currentTime * 1000
    if (!Number.isFinite(timeMs)) return 0
    let count = 0
    for (const entry of this.audioCache.values()) {
      if (entry.start <= timeMs) continue
      if (this.completedCueKeys.has(entry.cueIdentity)) continue
      count++
    }
    return count
  }

  private publishState(): void {
    const readyCount = this.audioCache.size
    const failingSince = this.enabled ? this.failingSince : null
    const bufferedCount = this.enabled ? this.bufferedCount() : 0
    const engine = this.enabled ? this.currentEngine() : null
    // A fresh object on every tick made the settings panel re-render a few
    // times a second for a value that changes only when a cue is synthesized or
    // evicted. Only writes that carry new information reach the atom.
    if (
      this.lastPublishedState &&
      this.lastPublishedState.enabled === this.enabled &&
      this.lastPublishedState.readyCount === readyCount &&
      this.lastPublishedState.failingSince === failingSince &&
      this.lastPublishedState.bufferedCount === bufferedCount &&
      this.lastPublishedState.engine === engine
    ) {
      return
    }
    this.lastPublishedState = {
      enabled: this.enabled,
      readyCount,
      failingSince,
      bufferedCount,
      engine,
    }
    subtitlesStore.set(dubbingStateAtom, this.lastPublishedState)
  }
}
