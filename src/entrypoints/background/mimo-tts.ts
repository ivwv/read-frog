import { logger } from "@/utils/logger"
import { onMessage } from "@/utils/message"
import { synthesizeMimoTts } from "@/utils/server/mimo-tts/synthesize"

/**
 * Unlike Edge TTS this needs no offscreen document: the manifest already grants
 * host permissions for every origin, and MiMo hands back base64 directly, so
 * there is no ArrayBuffer to re-encode on the way out.
 */
export function setupMimoTtsMessageHandlers() {
  onMessage("mimoTtsSynthesize", async (message) => {
    const response = await synthesizeMimoTts(message.data)
    if (!response.ok) {
      logger.warn("[Background][MimoTts] synthesize failed:", response.error)
    }
    return response
  })
}
