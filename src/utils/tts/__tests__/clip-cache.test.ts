import { QueryClient } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  evictOldestTtsAudioClips,
  TTS_AUDIO_CACHE_MAX_CHARS,
  TTS_AUDIO_QUERY_ROOT,
} from "../clip-cache"

/** A clip of `chars` base64 characters, the shape `synthesizeSpeech` returns. */
function clip(chars: number) {
  return { audioBase64: "A".repeat(chars), contentType: "audio/mpeg" }
}

/**
 * Seeds the cache directly rather than through the hook: this module only reads
 * query state, so the query key shape is the whole contract under test. The size
 * rides in the key because the real hook keys on every input that changes the
 * produced bytes.
 */
async function seed(queryClient: QueryClient, index: number, chars: number) {
  await queryClient.fetchQuery({
    queryKey: [TTS_AUDIO_QUERY_ROOT, { text: `chunk-${index}`, chars }],
    queryFn: async () => clip(chars),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 1000 * 60 * 10,
  })
  // `dataUpdatedAt` orders the eviction, and calls in a test can land in the same
  // millisecond; spacing them keeps "oldest" unambiguous.
  vi.advanceTimersByTime(10)
}

function cachedTexts(queryClient: QueryClient): string[] {
  return queryClient
    .getQueryCache()
    .findAll({ queryKey: [TTS_AUDIO_QUERY_ROOT] })
    .map((query) => (query.queryKey[1] as { text: string }).text)
    .sort()
}

describe("tts clip cache budget", () => {
  let queryClient: QueryClient

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  })

  afterEach(() => {
    queryClient.clear()
    vi.useRealTimers()
  })

  it("leaves a cache inside the budget alone", async () => {
    await seed(queryClient, 0, 100)
    await seed(queryClient, 1, 100)

    evictOldestTtsAudioClips(queryClient, 1000)

    expect(cachedTexts(queryClient)).toEqual(["chunk-0", "chunk-1"])
  })

  it("drops the oldest clips until the cache is back inside the budget", async () => {
    await seed(queryClient, 0, 400)
    await seed(queryClient, 1, 400)
    await seed(queryClient, 2, 400)

    // 1200 chars against a 500 budget: two have to go, oldest first.
    evictOldestTtsAudioClips(queryClient, 500)

    expect(cachedTexts(queryClient)).toEqual(["chunk-2"])
  })

  it("keeps the newest clip even when it alone exceeds the budget", async () => {
    await seed(queryClient, 0, 400)
    await seed(queryClient, 1, 5000)

    evictOldestTtsAudioClips(queryClient, 1000)

    // Dropping the newest would make the chunk the caller is waiting on
    // uncacheable for no memory saving at all.
    expect(cachedTexts(queryClient)).toEqual(["chunk-1"])
  })

  it("does not evict a request that has no audio yet", async () => {
    await seed(queryClient, 0, 400)
    await seed(queryClient, 1, 400)

    // Still in flight: no data, so it holds no memory and must survive, or its
    // result would never be cached while the caller still plays it.
    const pending = queryClient.fetchQuery({
      queryKey: [TTS_AUDIO_QUERY_ROOT, { text: "chunk-2" }],
      queryFn: () => new Promise(() => {}),
    })
    // Teardown cancels the in-flight query; its rejection is not under test, and
    // an unhandled one fails the run.
    void pending.catch(() => {})

    evictOldestTtsAudioClips(queryClient, 500)

    expect(cachedTexts(queryClient)).toContain("chunk-2")
    // The oldest with data is the one that paid.
    expect(cachedTexts(queryClient)).not.toContain("chunk-0")
  })

  it("has a default ceiling", () => {
    // Guards against the budget being dropped to zero by a careless edit, which
    // would silently turn the cache off.
    expect(TTS_AUDIO_CACHE_MAX_CHARS).toBeGreaterThan(1024 * 1024)
  })
})
