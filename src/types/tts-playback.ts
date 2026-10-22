export type TTSPlaybackStopReason = "stopped" | "interrupted"

export interface TTSPlaybackStartRequest {
  requestId: string
  audioBase64: string
  contentType: string
  /**
   * Speed to play the clip at, as a multiplier of its natural pace.
   *
   * Applied to the audio element rather than to synthesis: Edge TTS clamps the
   * prosody rate it is given to roughly `0.5x..2x`, so anything outside that had
   * to be done here anyway. Absent or out of range means natural speed.
   */
  playbackRate?: number
}

export type TTSPlaybackStartResponse = { ok: true } | { ok: false; reason: TTSPlaybackStopReason }

export interface TTSPlaybackStopRequest {
  requestId?: string
  reason?: TTSPlaybackStopReason
}
