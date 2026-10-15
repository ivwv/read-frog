import type {
  MimoTtsErrorCode,
  MimoTtsSynthesizeRequest,
  MimoTtsSynthesizeWireResponse,
} from "@/types/mimo-tts"
import type { MimoTtsFormat } from "@/utils/mimo-tts/types"

/** A whole cue is synthesized in one round trip; past this it is not coming back. */
const MIMO_TTS_TIMEOUT_MS = 30_000

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

  if (!apiKey.trim()) {
    return failure("INVALID_API_KEY", "MiMo TTS API key is not set")
  }
  if (!baseUrl.trim()) {
    return failure("INVALID_REQUEST", "MiMo TTS base URL is not set")
  }
  if (!text.trim()) {
    return failure("INVALID_REQUEST", "MiMo TTS received empty text")
  }

  const messages: MimoChatMessage[] = []
  if (stylePrompt?.trim()) {
    messages.push({ role: "user", content: stylePrompt.trim() })
  }
  messages.push({ role: "assistant", content: text })

  // Omitted rather than sent empty: `voicedesign` takes no preset voice and
  // rejects the request if one is present.
  const audio: { format: MimoTtsFormat; voice?: string } = { format }
  if (voice.trim()) {
    audio.voice = voice.trim()
  }

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
