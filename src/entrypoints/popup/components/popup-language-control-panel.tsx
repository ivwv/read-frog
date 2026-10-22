import { Icon } from "@iconify/react"
import debounce from "debounce"
import { useAtom, useAtomValue, useSetAtom } from "jotai"
import { useEffect, useMemo } from "react"
import { LanguageCombobox } from "@/components/language-combobox"
import { Button } from "@/components/ui/base-ui/button"
import { Field, FieldTitle } from "@/components/ui/base-ui/field"
import { configFieldsAtomMap } from "@/utils/atoms/config"
import { detectLanguage } from "@/utils/content/language"
import { i18n } from "@/utils/i18n"
import {
  detectedLangCodeAtom,
  detectedSourceLangCodeAtom,
  exchangeLangCodesAtom,
  inputTextAtom,
  sourceLangCodeAtom,
  targetLangCodeAtom,
} from "@/entrypoints/translation-hub/atoms"

/**
 * The hub's language pickers, narrowed for the popup.
 *
 * Same atoms and same detection as `LanguageControlPanel`, so switching a
 * language here is the same preference the hub page reads. What differs is only
 * the fit: the labels drop their locale ("英语" rather than "英语 (English)"),
 * and the exchange button sits between them rather than under the row, which is
 * what lets two triggers and the arrow share 360px without truncating.
 */
export function PopupLanguageControlPanel() {
  const [sourceLangCode, setSourceLangCode] = useAtom(sourceLangCodeAtom)
  const [targetLangCode, setTargetLangCode] = useAtom(targetLangCodeAtom)
  const exchangeLangCodes = useSetAtom(exchangeLangCodesAtom)
  const inputText = useAtomValue(inputTextAtom)
  const setDetectedSourceLangCode = useSetAtom(detectedSourceLangCodeAtom)
  const detectedLangCode = useAtomValue(detectedLangCodeAtom)
  const languageDetection = useAtomValue(configFieldsAtomMap.languageDetection)

  const enableLLM = languageDetection.mode === "llm"
  const debouncedDetect = useMemo(
    () =>
      debounce(async (text: string) => {
        const detected = await detectLanguage(text, { minLength: 1, enableLLM })
        setDetectedSourceLangCode(detected)
      }, 1000),
    [setDetectedSourceLangCode, enableLLM],
  )

  useEffect(() => {
    void debouncedDetect(inputText)
    return () => debouncedDetect.clear()
  }, [inputText, debouncedDetect])

  return (
    <div className="flex w-full items-center gap-1.5">
      <Field className="min-w-0 flex-1">
        <FieldTitle>{i18n.t("side.sourceLang")}</FieldTitle>
        <LanguageCombobox
          compact
          value={sourceLangCode}
          onValueChange={setSourceLangCode}
          detectedLangCode={detectedLangCode}
          triggerSize="sm"
          className="w-full"
        />
      </Field>

      <div className="shrink-0 self-end pb-0.5">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={exchangeLangCodes}
          title={i18n.t("translationHub.exchangeLanguages")}
          aria-label={i18n.t("translationHub.exchangeLanguages")}
        >
          <Icon icon="tabler:arrows-exchange" className="h-3.5 w-3.5" />
        </Button>
      </div>

      <Field className="min-w-0 flex-1">
        <FieldTitle>{i18n.t("side.targetLang")}</FieldTitle>
        <LanguageCombobox
          compact
          value={targetLangCode}
          onValueChange={(value) => {
            if (value !== "auto") void setTargetLangCode(value)
          }}
          triggerSize="sm"
          className="w-full"
        />
      </Field>
    </div>
  )
}
