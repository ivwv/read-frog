import { storage } from "#imports"

/**
 * Which of the popup's two views was open last.
 *
 * Deliberately NOT a field of the versioned config: a config field would mean a
 * schema bump, a migration script and a fixture for every historical version,
 * for a value that is nothing but a view preference. It lives in its own
 * `storage.local` key, the same way the TTS playback speed does.
 */
export const POPUP_TABS = ["page", "text"] as const

export type PopupTab = (typeof POPUP_TABS)[number]

/** The popup's original single view, so an existing user's popup opens as it always has. */
export const DEFAULT_POPUP_TAB: PopupTab = "page"

export const POPUP_ACTIVE_TAB_STORAGE_KEY = "popupActiveTab"

const POPUP_ACTIVE_TAB_STORAGE_ITEM = `local:${POPUP_ACTIVE_TAB_STORAGE_KEY}` as const

export function isPopupTab(value: unknown): value is PopupTab {
  return typeof value === "string" && (POPUP_TABS as readonly string[]).includes(value)
}

export async function getPopupActiveTab(): Promise<PopupTab> {
  const stored = await storage.getItem<unknown>(POPUP_ACTIVE_TAB_STORAGE_ITEM)
  // A stored value is untrusted: it may predate this key, or be hand-edited.
  return isPopupTab(stored) ? stored : DEFAULT_POPUP_TAB
}

export async function savePopupActiveTab(tab: PopupTab): Promise<void> {
  await storage.setItem<PopupTab>(POPUP_ACTIVE_TAB_STORAGE_ITEM, tab)
}
