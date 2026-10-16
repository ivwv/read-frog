import type { QueryClient } from "@tanstack/react-query"

/**
 * Query-key root for clips the read-aloud path caches.
 *
 * Shared so the eviction below can find them without the caller repeating the
 * key shape.
 */
export const TTS_AUDIO_QUERY_ROOT = "tts-audio"

/**
 * Ceiling for the read-aloud clip cache, in base64 characters.
 *
 * The cache exists so re-reading the same text does not pay for it twice, and its
 * entries are held with `staleTime: Infinity`. Nothing else bounded them: a long
 * selection caches one clip per chunk, and a two-minute chunk of MiMo WAV is
 * ~5.8 MB of PCM — about 7.7 MB once base64-encoded — so a dozen chunks is
 * already tens of megabytes of page heap, and the theoretical maximum is far
 * worse. The dubbing cache has had an equivalent ceiling from the start; this is
 * the same idea for the surface that had none.
 */
export const TTS_AUDIO_CACHE_MAX_CHARS = 16 * 1024 * 1024

/** Resident size of a cached clip, or 0 when it holds no audio (still in flight). */
function clipChars(data: unknown): number {
  const audioBase64 = (data as { audioBase64?: unknown } | null | undefined)?.audioBase64
  return typeof audioBase64 === "string" ? audioBase64.length : 0
}

/**
 * Drops the oldest cached clips until the cache is back inside `maxChars`.
 *
 * Oldest first because the newest entry is the chunk the caller just fetched and
 * is about to play. Queries without audio yet are left alone: they are requests
 * still in flight, and removing one would only stop its result being cached while
 * the caller still plays it.
 *
 * Call after each clip is fetched, so the ceiling holds as the cache grows.
 */
export function evictOldestTtsAudioClips(
  queryClient: QueryClient,
  maxChars: number = TTS_AUDIO_CACHE_MAX_CHARS,
): void {
  const cached = queryClient
    .getQueryCache()
    .findAll({ queryKey: [TTS_AUDIO_QUERY_ROOT] })
    .map((query) => ({ query, chars: clipChars(query.state.data) }))
    .filter((entry) => entry.chars > 0)

  let total = cached.reduce((sum, entry) => sum + entry.chars, 0)
  if (total <= maxChars) return

  const oldestFirst = cached.sort((a, b) => a.query.state.dataUpdatedAt - b.query.state.dataUpdatedAt)
  // The newest is kept even if it alone exceeds the ceiling: dropping it would
  // make the chunk the caller is waiting on uncacheable for no memory saving.
  for (const entry of oldestFirst.slice(0, -1)) {
    if (total <= maxChars) break
    total -= entry.chars
    queryClient.removeQueries({ queryKey: entry.query.queryKey, exact: true })
  }
}
