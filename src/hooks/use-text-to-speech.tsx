import type {
  FeatureProviderAnalytics,
  FeatureUsageContext,
  SurfaceByFeature,
} from "@/types/analytics"
import type { TTSConfig } from "@/types/config/tts"
import type { MimoTtsSettings } from "@/utils/mimo-tts/types"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { useAtomValue } from "jotai"
import { useRef, useState } from "react"
import { toastManager } from "@/components/ui/base-ui/toast"
import { ANALYTICS_FEATURE, ANALYTICS_SURFACE } from "@/types/analytics"
import { createFeatureUsageContext, trackFeatureUsed } from "@/utils/analytics"
import { classifyFailureReason } from "@/utils/analytics-failure-reason"
import { EDGE_TTS_FEATURE_PROVIDER, MIMO_TTS_FEATURE_PROVIDER } from "@/utils/analytics-provider"
import { configFieldsAtomMap } from "@/utils/atoms/config"
import { detectLanguage } from "@/utils/content/language"
import { getRandomUUID } from "@/utils/crypto-polyfill"
import { i18n } from "@/utils/i18n"
import { logger } from "@/utils/logger"
import { sendMessage } from "@/utils/message"
import { getMimoTtsSettings } from "@/utils/mimo-tts/settings"
import { splitTextByUtf8Bytes } from "@/utils/server/edge-tts/chunk"
import { evictOldestTtsAudioClips, TTS_AUDIO_QUERY_ROOT } from "@/utils/tts/clip-cache"
import { synthesizeSpeech } from "@/utils/tts/synthesize-speech"

interface PlayAudioParams {
  text: string
  ttsConfig: TTSConfig
  analyticsContext: FeatureUsageContext<"text_to_speech"> & FeatureProviderAnalytics
  /**
   * Read once in `play` and threaded through, so the cache key, the synthesis
   * call, and the reported provider all describe the same engine.
   */
  settings: MimoTtsSettings
  forcedVoice?: string
  // A run nobody pressed for (a layout reading a field as the answer arrives)
  // fails without a toast; pressing the trigger tries again and reports it.
  quiet?: boolean
}

/** A synthesized clip on its way to the offscreen player. */
type SynthesizedAudioChunk = Awaited<ReturnType<typeof synthesizeSpeech>>

const TTS_ERROR_TOAST_ID = "tts-synthesize-error"

export function selectTTSVoice(
  ttsConfig: TTSConfig,
  detectedLanguage?: string | null,
  forcedVoice?: string,
): string {
  if (forcedVoice) {
    return forcedVoice
  }

  if (detectedLanguage && detectedLanguage in ttsConfig.languageVoices) {
    return (
      ttsConfig.languageVoices[detectedLanguage as keyof typeof ttsConfig.languageVoices] ??
      ttsConfig.defaultVoice
    )
  }

  return ttsConfig.defaultVoice
}

async function resolveVoiceForText(
  text: string,
  ttsConfig: TTSConfig,
  enableLLM: boolean,
  forcedVoice?: string,
): Promise<string> {
  if (forcedVoice) {
    logger.info("[TextToSpeech] Using forced voice for text", {
      text,
      forcedVoice,
    })
    return forcedVoice
  }

  const detectedLanguage = await detectLanguage(text, {
    minLength: 0,
    enableLLM,
    // Voice detection can fall back without blocking speech. Tell the user
    // what happened and how to choose a working detection mode.
    llmFallbackToastContext: "speak",
  })
  logger.info("[TextToSpeech] Resolving voice for text", {
    text,
    detectedLanguage,
    enableLLM,
  })

  return selectTTSVoice(ttsConfig, detectedLanguage)
}

function getTTSFriendlyErrorDescription(error: Error): string | undefined {
  const message = error.message

  if (message.includes("Edge TTS returned empty audio data")) {
    return "The current voice may not support this language. Try switching to a matching voice."
  }

  // MiMo-specific: the key and the endpoint are user-entered, so these are the
  // two failures worth naming outright rather than showing a raw API message.
  if (message.includes("[INVALID_API_KEY]")) {
    return "MiMo TTS rejected the API key. Check the key in the Text to speech settings."
  }

  if (message.includes("[INVALID_REQUEST]")) {
    return message
  }

  if (message.includes("MiMo TTS returned empty audio data") || message.includes("[EMPTY_AUDIO]")) {
    return "MiMo TTS returned no audio. Try another voice or model."
  }

  if (message.includes("[SYNTH_RATE_LIMITED]") || message.includes("[RATE_LIMITED]")) {
    return "Too many TTS requests. Please try again in a moment."
  }

  // Shared by both engines, so the wording names neither.
  if (
    message.includes("[NETWORK_ERROR]") ||
    message.includes("[SERVER_ERROR]") ||
    message.includes("[TOKEN_FETCH_FAILED]") ||
    message.includes("[TOKEN_INVALID]")
  ) {
    return "The speech service is temporarily unavailable. Please check your network and retry."
  }

  return message || undefined
}

export function useTextToSpeech(
  surface: SurfaceByFeature["text_to_speech"] = ANALYTICS_SURFACE.SELECTION_TOOLBAR,
) {
  const queryClient = useQueryClient()
  const languageDetection = useAtomValue(configFieldsAtomMap.languageDetection)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentChunk, setCurrentChunk] = useState(0)
  const [totalChunks, setTotalChunks] = useState(0)
  const shouldStopRef = useRef(false)
  const activeRequestIdRef = useRef<string | null>(null)

  const stop = () => {
    shouldStopRef.current = true

    const activeRequestId = activeRequestIdRef.current
    activeRequestIdRef.current = null
    if (activeRequestId) {
      void sendMessage("ttsPlaybackStop", { requestId: activeRequestId }).catch(() => {})
    }

    setIsPlaying(false)
    setCurrentChunk(0)
    setTotalChunks(0)
  }

  const playMutation = useMutation<void, Error, PlayAudioParams>({
    meta: {
      suppressToast: true,
    },
    mutationFn: async ({ text, ttsConfig, analyticsContext, settings, forcedVoice }) => {
      stop()
      shouldStopRef.current = false

      const requestId = getRandomUUID()
      activeRequestIdRef.current = requestId
      // A newer play() resets shouldStopRef, so a run still awaiting a fetch
      // must also check that it is still the active request; otherwise it
      // would resume, start its audio over the newer one and flip its state.
      const isSuperseded = () => shouldStopRef.current || activeRequestIdRef.current !== requestId
      try {
        await runPlayback(requestId, isSuperseded, {
          text,
          ttsConfig,
          analyticsContext,
          settings,
          forcedVoice,
        })
      } catch (error) {
        // A run the user already stopped or replaced reports nothing.
        if (isSuperseded()) return
        throw error
      }
    },
    onError: (error, variables) => {
      void trackFeatureUsed({
        ...variables.analyticsContext,
        outcome: "failure",
        failure_reason: classifyFailureReason(error),
      })
      if (!variables.quiet) {
        toastManager.add({
          type: "error",
          title: i18n.t("speak.failedToGenerateSpeech"),
          id: TTS_ERROR_TOAST_ID,
          description: getTTSFriendlyErrorDescription(error),
        })
      }
      activeRequestIdRef.current = null
      setIsPlaying(false)
      setCurrentChunk(0)
      setTotalChunks(0)
    },
  })

  async function runPlayback(
    requestId: string,
    isSuperseded: () => boolean,
    { text, ttsConfig, analyticsContext, settings, forcedVoice }: PlayAudioParams,
  ) {
    let didStartPlayback = false

    // MiMo speaks with the single voice it is configured with and has no
    // language map, so resolving a language voice here would spend a round trip
    // — potentially an LLM one — on a voice the engine then ignores.
    const selectedVoice =
      settings.engine === "mimo"
        ? settings.voice
        : await resolveVoiceForText(
            text,
            ttsConfig,
            languageDetection.mode === "llm",
            forcedVoice,
          )
    if (isSuperseded()) {
      return
    }
    const chunks = splitTextByUtf8Bytes(text)
    setTotalChunks(chunks.length)
    await sendMessage("ttsPlaybackPrepare")
    if (isSuperseded()) {
      return
    }

    const fetchChunkAudio = async (chunk: string) => {
      logger.info("[TextToSpeech] Fetching chunk audio", {
        text: chunk,
        engine: settings.engine,
        voice: selectedVoice,
        rate: ttsConfig.rate,
        pitch: ttsConfig.pitch,
        volume: ttsConfig.volume,
      })
      const audio = await queryClient.fetchQuery({
        queryKey: [
          TTS_AUDIO_QUERY_ROOT,
          {
            text: chunk,
            // Every input that changes the produced bytes belongs in the key.
            // Without the engine and its parameters, switching engines (or
            // voices) would keep serving the cached clip from the old one.
            engine: settings.engine,
            voice: selectedVoice,
            model: settings.engine === "mimo" ? settings.model : undefined,
            stylePrompt: settings.engine === "mimo" ? settings.stylePrompt : undefined,
            format: settings.engine === "mimo" ? settings.format : undefined,
            rate: ttsConfig.rate,
            pitch: ttsConfig.pitch,
            volume: ttsConfig.volume,
          },
        ],
        queryFn: () =>
          synthesizeSpeech({
            text: chunk,
            ttsConfig,
            settings,
            resolveEdgeVoice: async () => selectedVoice,
          }),
        staleTime: Number.POSITIVE_INFINITY,
        gcTime: 1000 * 60 * 10,
        meta: {
          suppressToast: true,
        },
      })
      // The cache is unbounded otherwise: every chunk of a long selection stays
      // resident for its `gcTime`. Enforced here, where the cache grows.
      evictOldestTtsAudioClips(queryClient)
      return audio
    }

    const playChunk = async (audioChunk: SynthesizedAudioChunk): Promise<boolean> => {
      // isPlaying belongs to the active run; a superseded one leaves it alone.
      if (!isSuperseded()) setIsPlaying(true)
      try {
        const playbackResult = await sendMessage("ttsPlaybackStart", {
          requestId,
          audioBase64: audioChunk.audioBase64,
          contentType: audioChunk.contentType,
        })
        if (playbackResult.ok) {
          didStartPlayback = true
        }
        return playbackResult.ok
      } finally {
        if (activeRequestIdRef.current === requestId) setIsPlaying(false)
      }
    }

    for (let index = 0; index < chunks.length; index++) {
      if (isSuperseded()) {
        break
      }

      setCurrentChunk(index + 1)
      const currentAudioPromise = fetchChunkAudio(chunks[index]!)
      const nextAudioPromise =
        index + 1 < chunks.length ? fetchChunkAudio(chunks[index + 1]!) : null
      const audioChunk = await currentAudioPromise

      if (isSuperseded()) {
        break
      }

      const didPlay = await playChunk(audioChunk)
      if (!didPlay || isSuperseded()) {
        break
      }

      if (nextAudioPromise) {
        await nextAudioPromise
      }
    }

    if (activeRequestIdRef.current === requestId) {
      activeRequestIdRef.current = null
      setCurrentChunk(0)
      setTotalChunks(0)
    }

    if (didStartPlayback) {
      void trackFeatureUsed({
        ...analyticsContext,
        outcome: "success",
      })
    }
  }

  // `options.surface` reports a play started from somewhere other than the
  // hook's own surface (a keyboard shortcut for the toolbar's reader).
  const play = async (
    text: string,
    ttsConfig: TTSConfig,
    options?: {
      forcedVoice?: string
      surface?: SurfaceByFeature["text_to_speech"]
      quiet?: boolean
    },
  ) => {
    // Read once, here, so the engine that gets reported and the engine that
    // synthesizes cannot disagree if the setting changes mid-run.
    const settings = await getMimoTtsSettings()

    return playMutation.mutateAsync({
      text,
      ttsConfig,
      settings,
      forcedVoice: options?.forcedVoice,
      quiet: options?.quiet,
      analyticsContext: {
        ...createFeatureUsageContext(ANALYTICS_FEATURE.TEXT_TO_SPEECH, options?.surface ?? surface),
        ...(settings.engine === "mimo" ? MIMO_TTS_FEATURE_PROVIDER : EDGE_TTS_FEATURE_PROVIDER),
      },
    })
  }

  const isFetching = playMutation.isPending && !isPlaying

  return {
    play,
    stop,
    isFetching,
    isPlaying,
    currentChunk,
    totalChunks,
    error: playMutation.error,
  }
}
