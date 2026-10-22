import type { TTSConfig } from "@/types/config/tts"
import type { MimoTtsSettings } from "@/utils/mimo-tts/types"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_MIMO_TTS_SETTINGS } from "@/utils/mimo-tts/constants"
import { synthesizeSpeech } from "../synthesize-speech"

const sendMessage = vi.hoisted(() => vi.fn<(...args: any[]) => any>())
vi.mock("@/utils/message", () => ({ sendMessage }))

const TTS_CONFIG: TTSConfig = {
  defaultVoice: "en-US-AndrewMultilingualNeural",
  // `z.record` over the language enum demands every key; the dispatcher only
  // reads the three dials and the fallback voice.
  languageVoices: {} as TTSConfig["languageVoices"],
  rate: 10,
  pitch: -5,
  volume: 0,
}

const MIMO_SETTINGS: MimoTtsSettings = {
  ...DEFAULT_MIMO_TTS_SETTINGS,
  engine: "mimo",
  apiKey: "test-key",
  baseUrl: "https://example.test/v1",
  voice: "冰糖",
}

function resolveEdgeVoice() {
  return vi.fn<() => Promise<string>>(async () => "en-US-JennyNeural")
}

describe("synthesizeSpeech", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("routes to MiMo and never resolves an Edge voice", async () => {
    sendMessage.mockResolvedValue({ ok: true, audioBase64: "AAA", contentType: "audio/mpeg" })
    const edgeVoice = resolveEdgeVoice()

    const result = await synthesizeSpeech({
      text: "你好",
      ttsConfig: TTS_CONFIG,
      settings: MIMO_SETTINGS,
      resolveEdgeVoice: edgeVoice,
    })

    expect(sendMessage).toHaveBeenCalledWith(
      "mimoTtsSynthesize",
      expect.objectContaining({
        text: "你好",
        apiKey: "test-key",
        baseUrl: "https://example.test/v1",
        model: MIMO_SETTINGS.model,
        voice: "冰糖",
        format: MIMO_SETTINGS.format,
      }),
    )
    // Resolving one would cost a language-detection round trip for a voice the
    // engine ignores, so the thunk must stay untouched.
    expect(edgeVoice).not.toHaveBeenCalled()
    expect(result).toEqual({ audioBase64: "AAA", contentType: "audio/mpeg" })
  })

  it("routes to Edge TTS at natural pace, leaving only pitch and volume on the SSML", async () => {
    sendMessage.mockResolvedValue({ ok: true, audioBase64: "BBB", contentType: "audio/mpeg" })
    const edgeVoice = resolveEdgeVoice()

    const result = await synthesizeSpeech({
      text: "hello",
      ttsConfig: TTS_CONFIG,
      settings: DEFAULT_MIMO_TTS_SETTINGS,
      resolveEdgeVoice: edgeVoice,
    })

    expect(edgeVoice).toHaveBeenCalled()
    // Speed is applied to the audio element at playback instead: Edge TTS clamps
    // the prosody rate it is handed to roughly 0.5x-2x, so a percentage here
    // could never reach the 5x the settings page offers.
    expect(sendMessage).toHaveBeenCalledWith("edgeTtsSynthesize", {
      text: "hello",
      voice: "en-US-JennyNeural",
      rate: "+0%",
      pitch: "-5Hz",
      volume: "+0%",
    })
    expect(result).toEqual({ audioBase64: "BBB", contentType: "audio/mpeg" })
  })

  it("surfaces a MiMo failure as [CODE] message so the toast can explain it", async () => {
    sendMessage.mockResolvedValue({
      ok: false,
      error: { code: "INVALID_API_KEY", message: "Invalid API Key" },
    })

    await expect(
      synthesizeSpeech({
        text: "你好",
        ttsConfig: TTS_CONFIG,
        settings: MIMO_SETTINGS,
        resolveEdgeVoice: resolveEdgeVoice(),
      }),
    ).rejects.toThrowError("[INVALID_API_KEY] Invalid API Key")
  })

  it("treats a successful MiMo response with no audio as a failure", async () => {
    sendMessage.mockResolvedValue({ ok: true, audioBase64: "", contentType: "audio/mpeg" })

    await expect(
      synthesizeSpeech({
        text: "你好",
        ttsConfig: TTS_CONFIG,
        settings: MIMO_SETTINGS,
        resolveEdgeVoice: resolveEdgeVoice(),
      }),
    ).rejects.toThrowError("MiMo TTS returned empty audio data")
  })

  it("keeps the Edge failure contract unchanged", async () => {
    sendMessage.mockResolvedValue({
      ok: false,
      error: { code: "SYNTH_RATE_LIMITED", message: "slow down" },
    })

    await expect(
      synthesizeSpeech({
        text: "hello",
        ttsConfig: TTS_CONFIG,
        settings: DEFAULT_MIMO_TTS_SETTINGS,
        resolveEdgeVoice: resolveEdgeVoice(),
      }),
    ).rejects.toThrowError("[SYNTH_RATE_LIMITED] slow down")
  })
})
