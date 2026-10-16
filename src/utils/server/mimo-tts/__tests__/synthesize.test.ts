import type {
  MimoTtsErrorPayload,
  MimoTtsSynthesizeRequest,
  MimoTtsSynthesizeWireResponse,
} from "@/types/mimo-tts"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { synthesizeMimoTts } from "../synthesize"

const AUDIO_B64 = "UklGRiQAAABXQVZFZm10IBAAAAABAAEA"

function baseRequest(
  overrides: Partial<MimoTtsSynthesizeRequest> = {},
): MimoTtsSynthesizeRequest {
  return {
    text: "你好世界",
    apiKey: "test-key",
    baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
    model: "mimo-v2.5-tts",
    voice: "冰糖",
    format: "mp3",
    ...overrides,
  }
}

function successBody(audio: Record<string, unknown> = { data: AUDIO_B64 }) {
  return {
    choices: [{ index: 0, message: { role: "assistant", content: "", audio } }],
  }
}

/**
 * The API always answers `application/json`; the container is whatever the
 * request asked for, so the client reconstructs the content type itself.
 */
function mockResponse(body: unknown, status = 200) {
  const fetchMock = vi.fn<(input: string, init: RequestInit) => Promise<unknown>>(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }))
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

function mockJsonParseFailure(status = 200) {
  const fetchMock = vi.fn<(input: string, init: RequestInit) => Promise<unknown>>(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new SyntaxError("not json")
    },
  }))
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

type FetchMock = ReturnType<typeof mockResponse>

interface SentBody {
  model: string
  messages: { role: string; content: string }[]
  audio: Record<string, unknown>
}

function sentBody(fetchMock: FetchMock): SentBody {
  const init = fetchMock.mock.calls[0]![1]
  return JSON.parse(init.body as string) as SentBody
}

function sentHeaders(fetchMock: FetchMock): Record<string, string> {
  return fetchMock.mock.calls[0]![1].headers as Record<string, string>
}

/** Throws rather than asserting, so no `expect` sits inside a branch. */
function failureOf(response: MimoTtsSynthesizeWireResponse): MimoTtsErrorPayload {
  if (response.ok) {
    throw new Error(`expected a failure, got success: ${JSON.stringify(response)}`)
  }
  return response.error
}

function successOf(
  response: MimoTtsSynthesizeWireResponse,
): Extract<MimoTtsSynthesizeWireResponse, { ok: true }> {
  if (!response.ok) {
    throw new Error(`expected success, got failure: ${JSON.stringify(response.error)}`)
  }
  return response
}

describe("synthesizeMimoTts", () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("returns the base64 audio and the content type implied by the requested format", async () => {
    mockResponse(successBody())

    const response = await synthesizeMimoTts(baseRequest({ format: "mp3" }))

    expect(response).toEqual({ ok: true, audioBase64: AUDIO_B64, contentType: "audio/mpeg" })
  })

  it("reports WAV for a wav request, not the application/json the API actually sends", async () => {
    mockResponse(successBody())

    const response = successOf(await synthesizeMimoTts(baseRequest({ format: "wav" })))

    expect(response.contentType).toBe("audio/wav")
  })

  /**
   * The API's own contract: the spoken text must be the `assistant` message and
   * the delivery instruction the `user` one. Swapping them reads the instruction
   * aloud and still returns 200, so nothing but a test catches it.
   */
  it("puts the spoken text in the assistant message and the style prompt in the user message", async () => {
    const fetchMock = mockResponse(successBody())

    await synthesizeMimoTts(baseRequest({ text: "要读的句子", stylePrompt: "语速稍快" }))

    expect(sentBody(fetchMock).messages).toEqual([
      { role: "user", content: "语速稍快" },
      { role: "assistant", content: "要读的句子" },
    ])
  })

  it("omits the user message when there is no style prompt", async () => {
    const fetchMock = mockResponse(successBody())

    await synthesizeMimoTts(baseRequest({ stylePrompt: "   " }))

    expect(sentBody(fetchMock).messages).toEqual([{ role: "assistant", content: "你好世界" }])
  })

  it("sends the bearer token and the audio block", async () => {
    const fetchMock = mockResponse(successBody())

    await synthesizeMimoTts(baseRequest())

    expect(sentHeaders(fetchMock).Authorization).toBe("Bearer test-key")
    expect(sentBody(fetchMock).audio).toEqual({ format: "mp3", voice: "冰糖" })
  })

  it("omits the voice when it is empty", async () => {
    const fetchMock = mockResponse(successBody())

    await synthesizeMimoTts(baseRequest({ voice: "" }))

    expect(sentBody(fetchMock).audio).toEqual({ format: "mp3" })
  })

  /**
   * The reported bug. The voice-design model rejects the request outright when a
   * preset voice rides along ("audio.voice is not supported for voice design
   * model"), and the stored voice still holds the value chosen for
   * `mimo-v2.5-tts` — so the omission has to key off the *model*, not off the
   * voice happening to be empty.
   */
  it("drops a configured voice for the voice-design model", async () => {
    const fetchMock = mockResponse(successBody())

    await synthesizeMimoTts(
      baseRequest({
        model: "mimo-v2.5-tts-voicedesign",
        voice: "冰糖",
        stylePrompt: "温柔的女声，语速缓慢",
      }),
    )

    expect(sentBody(fetchMock).audio).toEqual({ format: "mp3" })
  })

  it("still sends the voice for the preset model", async () => {
    const fetchMock = mockResponse(successBody())

    await synthesizeMimoTts(baseRequest({ model: "mimo-v2.5-tts", voice: "茉莉" }))

    expect(sentBody(fetchMock).audio).toEqual({ format: "mp3", voice: "茉莉" })
  })

  it("treats the style instruction as required by the voice-design model", async () => {
    const fetchMock = mockResponse(successBody())

    // The API answers this with a bare "Param Incorrect", and
    // `optimize_text_preview` does not lift the requirement, so it is caught
    // here to give the user something actionable.
    const error = failureOf(
      await synthesizeMimoTts(baseRequest({ model: "mimo-v2.5-tts-voicedesign", voice: "" })),
    )

    expect(error.code).toBe("INVALID_REQUEST")
    expect(error.message).toContain("style instruction")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("does not require a style instruction for the preset model", async () => {
    const fetchMock = mockResponse(successBody())

    await synthesizeMimoTts(baseRequest({ model: "mimo-v2.5-tts", stylePrompt: "" }))

    expect(sentBody(fetchMock).messages).toEqual([{ role: "assistant", content: "你好世界" }])
  })

  it("appends the path without doubling a trailing slash on the base URL", async () => {
    const fetchMock = mockResponse(successBody())

    await synthesizeMimoTts(baseRequest({ baseUrl: "https://example.test/v1/" }))

    expect(fetchMock.mock.calls[0]![0]).toBe("https://example.test/v1/chat/completions")
  })

  it("surfaces the API's own message for a rejected request", async () => {
    mockResponse(
      { error: { code: "400", message: "Unknown voice: 不存在. Available voices: [冰糖]" } },
      400,
    )

    const error = failureOf(await synthesizeMimoTts(baseRequest()))

    expect(error.code).toBe("INVALID_REQUEST")
    expect(error.message).toContain("Unknown voice")
  })

  it("classifies auth, rate limit and server failures", async () => {
    mockResponse({ error: { message: "Invalid API Key" } }, 401)
    expect(failureOf(await synthesizeMimoTts(baseRequest())).code).toBe("INVALID_API_KEY")

    mockResponse({ error: { message: "slow down" } }, 429)
    const limited = failureOf(await synthesizeMimoTts(baseRequest()))
    expect(limited.code).toBe("RATE_LIMITED")
    expect(limited.retryable).toBe(true)

    mockResponse({ error: { message: "boom" } }, 503)
    expect(failureOf(await synthesizeMimoTts(baseRequest())).code).toBe("SERVER_ERROR")
  })

  it("reports empty audio rather than succeeding with nothing to play", async () => {
    mockResponse(successBody({}))

    expect(failureOf(await synthesizeMimoTts(baseRequest())).code).toBe("EMPTY_AUDIO")
  })

  it("reports empty audio when the body is not JSON at all", async () => {
    mockJsonParseFailure()

    expect(failureOf(await synthesizeMimoTts(baseRequest())).code).toBe("EMPTY_AUDIO")
  })

  it("reports a network error when the request itself fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")))

    const error = failureOf(await synthesizeMimoTts(baseRequest()))

    expect(error.code).toBe("NETWORK_ERROR")
    expect(error.retryable).toBe(true)
  })

  it("retries a rate-limited request once before giving up", async () => {
    const fetchMock = vi
      .fn<(input: string, init: RequestInit) => Promise<unknown>>()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        json: async () => ({ error: { message: "slow down" } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => successBody(),
      })
    vi.stubGlobal("fetch", fetchMock)

    const response = successOf(await synthesizeMimoTts(baseRequest()))

    expect(response.audioBase64).toBe(AUDIO_B64)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("does not retry an auth failure", async () => {
    const fetchMock = vi
      .fn<(input: string, init: RequestInit) => Promise<unknown>>()
      .mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ error: { message: "Invalid API Key" } }),
      })
    vi.stubGlobal("fetch", fetchMock)

    const error = failureOf(await synthesizeMimoTts(baseRequest()))

    expect(error.code).toBe("INVALID_API_KEY")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("gives up after one retry when the server keeps failing", async () => {
    const fetchMock = vi
      .fn<(input: string, init: RequestInit) => Promise<unknown>>()
      .mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({ error: { message: "boom" } }),
      })
    vi.stubGlobal("fetch", fetchMock)

    const error = failureOf(await synthesizeMimoTts(baseRequest()))

    expect(error.code).toBe("SERVER_ERROR")
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("refuses to call the API without a key, a base URL, or text", async () => {
    const fetchMock = mockResponse(successBody())

    expect(failureOf(await synthesizeMimoTts(baseRequest({ apiKey: "  " }))).code).toBe(
      "INVALID_API_KEY",
    )
    expect(failureOf(await synthesizeMimoTts(baseRequest({ baseUrl: "" }))).code).toBe(
      "INVALID_REQUEST",
    )
    expect(failureOf(await synthesizeMimoTts(baseRequest({ text: "   " }))).code).toBe(
      "INVALID_REQUEST",
    )

    expect(fetchMock).not.toHaveBeenCalled()
  })
})
