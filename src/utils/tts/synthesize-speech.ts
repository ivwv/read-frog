import type { TTSConfig } from "@/types/config/tts"
import type { MimoTtsSettings } from "@/utils/mimo-tts/types"
import { sendMessage } from "@/utils/message"

export interface SynthesizedSpeech {
  audioBase64: string
  contentType: string
}

export interface SynthesizeSpeechOptions {
  text: string
  /** Edge TTS prosody dials; unused by MiMo, which has no numeric parameters. */
  ttsConfig: TTSConfig
  /**
   * Resolved by the caller so it can also key its audio cache on the same
   * values. Passed as a thunk because MiMo ignores language voices entirely —
   * resolving one eagerly would spend a language-detection round trip (possibly
   * an LLM call) on a voice that is then thrown away.
   */
  settings: MimoTtsSettings
  resolveEdgeVoice: () => Promise<string>
}

export function toSignedValue(value: number, unit: "%" | "Hz"): string {
  return `${value >= 0 ? "+" : ""}${value}${unit}`
}

/**
 * Synthesizes one string of speech with whichever engine is active, so callers
 * do not each grow their own copy of the branch.
 *
 * Failures are thrown as `[CODE] message`, matching what the Edge TTS path
 * already produced — the text-to-speech hook maps those codes onto user-facing
 * explanations.
 */
export async function synthesizeSpeech({
  text,
  ttsConfig,
  settings,
  resolveEdgeVoice,
}: SynthesizeSpeechOptions): Promise<SynthesizedSpeech> {
  if (settings.engine === "mimo") {
    const response = await sendMessage("mimoTtsSynthesize", {
      text,
      apiKey: settings.apiKey,
      baseUrl: settings.baseUrl,
      model: settings.model,
      voice: settings.voice,
      stylePrompt: settings.stylePrompt || undefined,
      format: settings.format,
    })

    if (!response.ok) {
      throw new Error(`[${response.error.code}] ${response.error.message}`)
    }
    if (!response.audioBase64) {
      throw new Error("MiMo TTS returned empty audio data")
    }

    return { audioBase64: response.audioBase64, contentType: response.contentType }
  }

  const voice = await resolveEdgeVoice()
  const response = await sendMessage("edgeTtsSynthesize", {
    text,
    voice,
    // Natural pace on purpose: the reader's speed is applied to the audio at
    // playback (see `TTSPlaybackStartRequest.playbackRate`), because Edge TTS
    // silently clamps the prosody rate to about 0.5x-2x — sending a percentage
    // here would cap the setting at 2x and quietly disagree with the UI.
    rate: "+0%",
    pitch: toSignedValue(ttsConfig.pitch ?? 0, "Hz"),
    volume: toSignedValue(ttsConfig.volume ?? 0, "%"),
  })

  if (!response.ok) {
    throw new Error(`[${response.error.code}] ${response.error.message}`)
  }
  if (!response.audioBase64) {
    throw new Error("Edge TTS returned empty audio data")
  }

  return { audioBase64: response.audioBase64, contentType: response.contentType }
}
