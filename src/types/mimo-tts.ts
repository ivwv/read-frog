import type { MimoTtsFormat } from "@/utils/mimo-tts/types"

export const MIMO_TTS_ERROR_CODES = [
  "INVALID_REQUEST",
  "INVALID_API_KEY",
  "RATE_LIMITED",
  "SERVER_ERROR",
  "NETWORK_ERROR",
  "EMPTY_AUDIO",
] as const

export type MimoTtsErrorCode = (typeof MIMO_TTS_ERROR_CODES)[number]

export interface MimoTtsErrorPayload {
  code: MimoTtsErrorCode
  message: string
  retryable?: boolean
  status?: number
}

/**
 * Everything synthesis needs, including the credentials.
 *
 * The background handler is deliberately a pure function of this payload rather
 * than a second reader of the settings: it keeps the handler testable without a
 * storage stub, and mirrors how `edgeTtsSynthesize` already receives its voice
 * and prosody from the caller.
 */
export interface MimoTtsSynthesizeRequest {
  text: string
  apiKey: string
  baseUrl: string
  model: string
  voice: string
  stylePrompt?: string
  format: MimoTtsFormat
}

export interface MimoTtsSynthesizeWireSuccess {
  ok: true
  audioBase64: string
  contentType: string
}

export interface MimoTtsSynthesizeFailure {
  ok: false
  error: MimoTtsErrorPayload
}

export type MimoTtsSynthesizeWireResponse =
  | MimoTtsSynthesizeWireSuccess
  | MimoTtsSynthesizeFailure
