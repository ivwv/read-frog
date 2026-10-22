import { atom } from "jotai"
import { DEFAULT_POPUP_TAB, type PopupTab, savePopupActiveTab } from "@/utils/popup/active-tab"

const basePopupActiveTabAtom = atom<PopupTab>(DEFAULT_POPUP_TAB)

/**
 * The popup's current view, hydrated from storage before the first render (see
 * `popup/main.tsx`) so opening the popup never flashes the other tab first.
 *
 * Writing goes through storage too, so the view the user left is the view they
 * come back to.
 */
export const popupActiveTabAtom = atom(
  (get) => get(basePopupActiveTabAtom),
  (_get, set, tab: PopupTab) => {
    set(basePopupActiveTabAtom, tab)
    void savePopupActiveTab(tab)
  },
)
