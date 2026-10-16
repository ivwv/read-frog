/**
 * Domain types for the MiMo TTS engine.
 *
 * These deliberately do NOT live in `@/types/config`: the MiMo settings are
 * stored under their own `storage.local` key so they never enter `configSchema`.
 * Adding a field to the versioned config would require a migration script plus a
 * fixture for every historical version (the migration suite replays all of them
 * against the current schema), which is a large, conflict-prone diff against
 * upstream for what is a purely additive, self-contained setting.
 */

/** Which engine synthesizes speech. A single switch drives every TTS surface. */
export type MimoTtsEngine = "edge" | "mimo"

/**
 * Audio container requested from MiMo. The API returns JSON with base64 inside,
 * so this is the only thing that decides the real container.
 *
 * - `mp3` is ~6x smaller (about 7.4 KB/s vs 48 KB/s), which matters because the
 *   dubbing scheduler holds synthesized audio for many cues in memory.
 * - `wav` is PCM and carries an exact, immediately readable duration, which
 *   spares the dubbing scheduler its MP3 duration probe.
 */
export type MimoTtsFormat = "mp3" | "wav"

export type MimoTtsVoice = string

export interface MimoTtsSettings {
  engine: MimoTtsEngine
  apiKey: string
  baseUrl: string
  model: string
  voice: MimoTtsVoice
  /**
   * Natural-language delivery instruction, sent as the `user` message. MiMo has
   * no numeric rate/pitch/volume parameters, so this is how speech is shaped.
   */
  stylePrompt: string
  format: MimoTtsFormat
  /**
   * How many cues video dubbing may synthesize at once.
   *
   * MiMo answers in seconds, so throughput is `concurrency / latency`. A video
   * watched at 2x-4x consumes cues 2-4x faster, and a fixed budget that is fine
   * at 1x falls permanently behind above it — the dubbing then skips sentences
   * rather than merely lagging. Ignored by Edge TTS, whose own (lower) budget is
   * tuned to stay under its rate limiter, and by read-aloud, which is gated on
   * playback rather than on synthesis.
   */
  concurrency: number
}
