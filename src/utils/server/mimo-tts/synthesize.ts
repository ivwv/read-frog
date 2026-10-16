import type {
  MimoTtsErrorCode,
  MimoTtsSynthesizeRequest,
  MimoTtsSynthesizeWireResponse,
} from "@/types/mimo-tts"
import type { MimoTtsFormat } from "@/utils/mimo-tts/types"
import { MIMO_TTS_VOICE_DESIGN_MODEL } from "@/utils/mimo-tts/constants"

/** A whole cue is synthesized in one round trip; past this it is not coming back. */
const MIMO_TTS_TIMEOUT_MS = 30_000
/**
 * One retry for failures the API itself calls transient (429, 5xx, timeout,
 * network). Edge TTS gets the same treatment in its own layer with retries and
 * a circuit breaker; without this, a single blip cost a cue its slot in the
 * dubbing timeline (the retry window there is minutes, not seconds).
 */
const MIMO_TTS_MAX_RETRIES = 1
const MIMO_TTS_RETRY_DELAY_MS = 600

/**
 * MiMo answers with JSON, not audio: the bytes ride base64-encoded inside
 * `choices[0].message.audio.data` and the response's own content type is
 * `application/json`. The real container is whatever the *request* asked for, so
 * it has to be reconstructed here rather than read off the headers.
 */
const CONTENT_TYPE_BY_FORMAT: Record<MimoTtsFormat, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
}

interface MimoChatMessage {
  role: "user" | "assistant"
  content: string
}

function resolveChatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, "")}/chat/completions`
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function failure(
  code: MimoTtsErrorCode,
  message: string,
  extra: { retryable?: boolean; status?: number } = {},
): MimoTtsSynthesizeWireResponse {
  return { ok: false, error: { code, message, ...extra } }
}

/** The API reports failures as `{ error: { code, message, param } }`. */
function readErrorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "error" in body) {
    const error = (body as { error?: unknown }).error
    if (typeof error === "string" && error.trim()) {
      return error
    }
    if (error && typeof error === "object" && "message" in error) {
      const message = (error as { message?: unknown }).message
      if (typeof message === "string" && message.trim()) {
        return message
      }
    }
  }
  return fallback
}

function readAudioBase64(body: unknown): string | null {
  if (!body || typeof body !== "object") return null

  const choices = (body as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return null

  const message = (choices[0] as { message?: unknown } | undefined)?.message
  if (!message || typeof message !== "object") return null

  const audio = (message as { audio?: unknown }).audio
  if (!audio || typeof audio !== "object") return null

  const data = (audio as { data?: unknown }).data
  return typeof data === "string" && data.length > 0 ? data : null
}

/**
 * Synthesizes one string of text with MiMo TTS.
 *
 * Two details of the API shape the request, and getting either wrong fails
 * quietly rather than loudly:
 *
 * - The text to be spoken must be the `assistant` message. A `user` message is
 *   the style instruction and is never spoken, so swapping them would read the
 *   instruction aloud.
 * - There are no numeric rate/pitch/volume parameters. Delivery is steered only
 *   by that instruction, which is why the settings carry a prompt instead of the
 *   dials Edge TTS takes.
 */
export async function synthesizeMimoTts(
  request: MimoTtsSynthesizeRequest,
): Promise<MimoTtsSynthesizeWireResponse> {
  const { text, apiKey, baseUrl, model, voice, stylePrompt, format } = request
  const instruction = stylePrompt?.trim() ?? ""
  // The design model invents a voice from the instruction instead of using a
  // preset, and is strict about both halves of that contract (verified against
  // the live API):
  //   - sending a voice -> 400 "audio.voice is not supported for voice design model"
  //   - sending no instruction -> 400 "user message content must not be empty
  //     for voice design model" (`optimize_text_preview` does NOT lift this; it
  //     only lets the *assistant* message be omitted)
  // Both are caught here so the user gets a sentence they can act on rather
  // than a bare "Param Incorrect".
  const isVoiceDesign = model === MIMO_TTS_VOICE_DESIGN_MODEL

  if (!apiKey.trim()) {
    return failure("INVALID_API_KEY", "MiMo TTS API key is not set")
  }
  if (!baseUrl.trim()) {
    return failure("INVALID_REQUEST", "MiMo TTS base URL is not set")
  }
  if (!text.trim()) {
    return failure("INVALID_REQUEST", "MiMo TTS received empty text")
  }
  if (isVoiceDesign && !instruction) {
    return failure(
      "INVALID_REQUEST",
      "The voice-design model invents a voice from the style instruction, so it needs one to be filled in.",
    )
  }

  const messages: MimoChatMessage[] = []
  if (instruction) {
    messages.push({ role: "user", content: instruction })
  }
  messages.push({ role: "assistant", content: text })

  const audio: { format: MimoTtsFormat; voice?: string } = { format }
  // Omitted for the design model even when a voice is configured: the stored
  // voice belongs to `mimo-v2.5-tts`, and leaving it in fails every request.
  if (!isVoiceDesign && voice.trim()) {
    audio.voice = voice.trim()
  }

  // Only failures the API itself calls transient get the second attempt;
  // auth and parameter errors would just fail the same way twice.
  let lastFailure: MimoTtsSynthesizeWireResponse | null = null
  for (let attempt = 0; attempt <= MIMO_TTS_MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await wait(MIMO_TTS_RETRY_DELAY_MS)
    }
    const response = await synthesizeOnce(baseUrl, apiKey, model, messages, audio, format)
    if (response.ok || !response.error.retryable) {
      return response
    }
    lastFailure = response
  }

  return lastFailure!
}

async function synthesizeOnce(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: MimoChatMessage[],
  audio: { format: MimoTtsFormat; voice?: string },
  format: MimoTtsFormat,
): Promise<MimoTtsSynthesizeWireResponse> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), MIMO_TTS_TIMEOUT_MS)

  try {
    const response = await fetch(resolveChatCompletionsUrl(baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey.trim()}`,
      },
      body: JSON.stringify({ model, messages, audio }),
      signal: controller.signal,
    })

    const body: unknown = await response.json().catch(() => null)

    if (!response.ok) {
      const message = readErrorMessage(body, `MiMo TTS request failed: ${response.status}`)

      if (response.status === 401 || response.status === 403) {
        return failure("INVALID_API_KEY", message, { status: response.status })
      }
      if (response.status === 429) {
        return failure("RATE_LIMITED", message, { status: response.status, retryable: true })
      }
      if (response.status >= 500) {
        return failure("SERVER_ERROR", message, { status: response.status, retryable: true })
      }
      return failure("INVALID_REQUEST", message, { status: response.status })
    }

    const audioBase64 = readAudioBase64(body)
    if (!audioBase64) {
      return failure("EMPTY_AUDIO", "MiMo TTS returned no audio data")
    }

    return { ok: true, audioBase64, contentType: CONTENT_TYPE_BY_FORMAT[format] }
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return failure(
        "NETWORK_ERROR",
        `MiMo TTS timed out after ${MIMO_TTS_TIMEOUT_MS}ms`,
        { retryable: true },
      )
    }
    return failure("NETWORK_ERROR", error instanceof Error ? error.message : String(error), {
      retryable: true,
    })
  } finally {
    clearTimeout(timeoutId)
  }
}
