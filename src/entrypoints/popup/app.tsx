import { Icon } from "@iconify/react"
import { useAtom } from "jotai"
import { UserAccountMenuPopup } from "@/components/user-account-menu"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/base-ui/tabs"
import { i18n } from "@/utils/i18n"
import { openOptionsPage } from "@/utils/navigation"
import { version } from "../../../package.json"
import { popupActiveTabAtom } from "./atoms/active-tab"
import { AISmartContext } from "./components/ai-smart-context"
import { AlwaysTranslate } from "./components/always-translate"
import BlogNotification from "./components/blog-notification"
import { DiscordButton } from "./components/discord-button"
import LanguageOptionsSelector from "./components/language-options-selector"
import { MoreMenu } from "./components/more-menu"
import Hotkey from "./components/node-translation-hotkey-selector"
import ProvidersField from "./components/providers-field"
import { SiteControlToggle } from "./components/site-control-toggle"
import { StoreReviewPrompt } from "./components/store-review-prompt"
import TranslateButton from "./components/translate-button"
import TranslatePromptSelector from "./components/translate-prompt-selector"
import { TranslationHubButton } from "./components/translation-hub-button"
import { TranslationTab } from "./components/translation-tab"
import TranslationModeSelector from "./components/translation-mode-selector"

/**
 * The popup's two views: translating the page in front of you, and translating
 * text you paste.
 *
 * They share the popup's header and footer, so switching is a tab change rather
 * than a different window — which is the point: the text view used to need a
 * separate browser tab, and the popup is what people already reach for.
 */
function App() {
  const [activeTab, setActiveTab] = useAtom(popupActiveTabAtom)

  return (
    <>
      <Tabs
        value={activeTab}
        onValueChange={(value) => {
          if (value === "page" || value === "text") setActiveTab(value)
        }}
        className="gap-0"
      >
        <div className="bg-background px-6 pt-5">
          <div className="flex items-center justify-between gap-2">
            <UserAccountMenuPopup />
            <div className="flex shrink-0 items-center">
              <TranslationHubButton />
              <DiscordButton />
              <BlogNotification />
            </div>
          </div>
          <TabsList variant="line" className="mt-3 w-full">
            <TabsTrigger value="page">
              <Icon icon="tabler:world" />
              {i18n.t("popup.tabs.page")}
            </TabsTrigger>
            <TabsTrigger value="text">
              <Icon icon="tabler:language-hiragana" />
              {i18n.t("popup.tabs.text")}
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="page" className="flex flex-col gap-4 bg-background px-6 pt-4 pb-4">
          <LanguageOptionsSelector />
          <ProvidersField />
          <TranslatePromptSelector />
          <div className="flex w-full items-center gap-2">
            <TranslationModeSelector />
            <TranslateButton className="min-w-0 flex-1" />
          </div>
          <SiteControlToggle />
          <AlwaysTranslate />
          <Hotkey />
          <AISmartContext />
        </TabsContent>

        {/* Tighter side padding than the page view: the results list scrolls, and the
            scrollbar's width is enough to push a card's action row past the edge. */}
        <TabsContent value="text" className="bg-background px-4 pt-4 pb-4">
          <TranslationTab />
        </TabsContent>
      </Tabs>

      {/* Out of flow on purpose: the card appears on its own schedule, and letting it
          grow the popup would shift every control out from under the user's cursor. */}
      <StoreReviewPrompt />

      <div className="flex items-center justify-between bg-neutral-200 px-2 py-1 dark:bg-neutral-800">
        <button
          type="button"
          className="flex cursor-pointer items-center gap-1 rounded-md px-2 py-1 hover:bg-neutral-300 dark:hover:bg-neutral-700"
          onClick={() => {
            void openOptionsPage()
          }}
        >
          <Icon icon="tabler:settings" className="size-4" strokeWidth={1.6} />
          <span className="text-[13px] font-medium">{i18n.t("popup.options")}</span>
        </button>
        <span className="text-sm text-neutral-500 dark:text-neutral-400">{version}</span>
        <MoreMenu />
      </div>
    </>
  )
}

export default App
