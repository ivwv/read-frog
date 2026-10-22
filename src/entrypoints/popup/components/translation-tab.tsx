import { TranslationPanel } from "@/entrypoints/translation-hub/components/translation-panel"
import { TranslationPanelActions } from "@/entrypoints/translation-hub/components/translation-panel-actions"
import { TranslationServiceDropdown } from "@/entrypoints/translation-hub/components/translation-service-dropdown"
import { TextInput } from "@/entrypoints/translation-hub/components/text-input"
import { PopupLanguageControlPanel } from "./popup-language-control-panel"

/**
 * The translation hub, stacked for the popup.
 *
 * The hub page lays its parts out in a two-column grid that needs a full browser
 * tab. Here the same parts go in one column at popup width: pick the languages,
 * pick which providers to ask, type, read. Everything is reused as-is, so the
 * provider selection, the per-provider cards and their copy/speak actions behave
 * exactly as they do on the hub page — this is a second view of the same
 * feature, not a second implementation of it.
 *
 * Only the results scroll, so the input and the language pickers stay put while
 * a long translation is read.
 */
export function TranslationTab() {
  return (
    <div className="flex flex-col gap-3">
      <PopupLanguageControlPanel />
      <div className="flex min-w-0 items-center gap-2">
        <TranslationServiceDropdown className="min-w-0 flex-1" />
        <TranslationPanelActions />
      </div>
      <TextInput
        className="h-28 text-base!"
        // The tab exists to be typed into, so the caret is already there.
        autoFocus
      />
      {/* `overflow-x-hidden`: the cards are sized for the hub's column and would
          otherwise push a horizontal scrollbar into this narrow pane. */}
      <div className="max-h-[280px] overflow-x-hidden overflow-y-auto">
        <TranslationPanel />
      </div>
    </div>
  )
}
