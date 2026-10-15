import type { MimoTtsSettings } from "@/utils/mimo-tts/types"
import { IconLoader2, IconPlayerPlayFilled } from "@tabler/icons-react"
import { useAtom } from "jotai"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/base-ui/button"
import { Input } from "@/components/ui/base-ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/base-ui/select"
import { Textarea } from "@/components/ui/base-ui/textarea"
import { useTextToSpeech } from "@/hooks/use-text-to-speech"
import { ANALYTICS_SURFACE } from "@/types/analytics"
import { configFieldsAtomMap } from "@/utils/atoms/config"
import { i18n } from "@/utils/i18n"
import {
  MIMO_TTS_FORMATS,
  MIMO_TTS_MODELS,
  MIMO_TTS_PRESET_VOICES,
  MIMO_TTS_VOICE_DESIGN_MODEL,
} from "@/utils/mimo-tts/constants"
import { getMimoTtsSettings, saveMimoTtsSettings } from "@/utils/mimo-tts/settings"
import { ConfigItem } from "../../../components/config-item"
import { ConfigSection } from "../../../components/config-section"

const FORMAT_LABEL_KEY = {
  mp3: "options.tts.mimo.formatMp3",
  wav: "options.tts.mimo.formatWav",
} as const

/**
 * Picks the engine every TTS surface uses, and configures MiMo when it is the
 * one selected.
 *
 * These settings live in their own `storage.local` key rather than in the
 * versioned config, so nothing here is reachable from `configSchema` — see
 * `@/utils/mimo-tts/settings` for why that is deliberate.
 *
 * Component state, not storage, is what the controls render. A text field that
 * re-read its value from storage on every keystroke would fight the caret, and
 * this page is the only writer.
 */
export function MimoTtsSection() {
  const [ttsConfig] = useAtom(configFieldsAtomMap.tts)
  const [settings, setSettings] = useState<MimoTtsSettings | null>(null)
  const { play, isFetching, isPlaying } = useTextToSpeech(ANALYTICS_SURFACE.TTS_SETTINGS)

  useEffect(() => {
    let active = true
    void getMimoTtsSettings().then((loaded) => {
      if (active) setSettings(loaded)
    })
    return () => {
      active = false
    }
  }, [])

  if (!settings) return null

  const update = (patch: Partial<MimoTtsSettings>) => {
    const next = { ...settings, ...patch }
    setSettings(next)
    void saveMimoTtsSettings(next)
  }

  const isMimo = settings.engine === "mimo"
  // The design model invents a voice from the instruction, so a preset voice
  // stops applying and the instruction stops being optional.
  const voiceIsDesigned = settings.model === MIMO_TTS_VOICE_DESIGN_MODEL
  const stylePromptIsSet = settings.stylePrompt.trim().length > 0
  // Blocked rather than attempted-and-rejected: the API answers such a request
  // with a bare "Param Incorrect".
  const needsInstruction = voiceIsDesigned && !stylePromptIsSet

  return (
    <ConfigSection id="mimo-tts" title={i18n.t("options.tts.mimo.title")}>
      <ConfigItem
        id="tts-engine"
        title={i18n.t("options.tts.mimo.engine")}
        description={i18n.t("options.tts.mimo.engineDescription")}
      >
        <Select
          value={settings.engine}
          // A select reports null when it is cleared; keep the stored engine.
          onValueChange={(value) => {
            if (value) update({ engine: value as MimoTtsSettings["engine"] })
          }}
        >
          <SelectTrigger size="sm" aria-label={i18n.t("options.tts.mimo.engine")}>
            <SelectValue render={<span />}>
              {isMimo
                ? i18n.t("options.tts.mimo.engineMimo")
                : i18n.t("options.tts.mimo.engineEdge")}
            </SelectValue>
          </SelectTrigger>
          <SelectContent align="start">
            <SelectGroup>
              <SelectItem value="edge">{i18n.t("options.tts.mimo.engineEdge")}</SelectItem>
              <SelectItem value="mimo">{i18n.t("options.tts.mimo.engineMimo")}</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </ConfigItem>

      {isMimo && (
        <>
          <ConfigItem
            id="mimo-api-key"
            title={i18n.t("options.tts.mimo.apiKey")}
            description={i18n.t("options.tts.mimo.apiKeyDescription")}
          >
            <Input
              type="password"
              autoComplete="off"
              className="w-full sm:w-80"
              aria-label={i18n.t("options.tts.mimo.apiKey")}
              value={settings.apiKey}
              onChange={(event) => update({ apiKey: event.target.value })}
            />
          </ConfigItem>

          <ConfigItem id="mimo-base-url" title={i18n.t("options.tts.mimo.baseUrl")}>
            <Input
              className="w-full sm:w-80"
              aria-label={i18n.t("options.tts.mimo.baseUrl")}
              value={settings.baseUrl}
              onChange={(event) => update({ baseUrl: event.target.value })}
            />
          </ConfigItem>

          <ConfigItem id="mimo-model" title={i18n.t("options.tts.mimo.model")}>
            <Select
              value={settings.model}
              onValueChange={(value) => {
                if (value) update({ model: value })
              }}
            >
              <SelectTrigger size="sm" aria-label={i18n.t("options.tts.mimo.model")}>
                <SelectValue render={<span />}>{settings.model}</SelectValue>
              </SelectTrigger>
              <SelectContent align="start">
                <SelectGroup>
                  {MIMO_TTS_MODELS.map((model) => (
                    <SelectItem key={model} value={model}>
                      {model}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </ConfigItem>

          <ConfigItem
            id="mimo-voice"
            title={i18n.t("options.tts.mimo.voice")}
            description={voiceIsDesigned ? i18n.t("options.tts.mimo.voiceDesigned") : undefined}
          >
            <Select
              value={settings.voice}
              onValueChange={(value) => {
                if (value) update({ voice: value })
              }}
              disabled={voiceIsDesigned}
            >
              <SelectTrigger size="sm" aria-label={i18n.t("options.tts.mimo.voice")}>
                {/* The stored voice is not sent for the design model, so showing
                    it here would claim a voice that is not being used. */}
                <SelectValue render={<span />}>
                  {voiceIsDesigned
                    ? i18n.t("options.tts.mimo.voiceDesignedValue")
                    : settings.voice}
                </SelectValue>
              </SelectTrigger>
              <SelectContent align="start">
                <SelectGroup>
                  {MIMO_TTS_PRESET_VOICES.map((voice) => (
                    <SelectItem key={voice} value={voice}>
                      {voice}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </ConfigItem>

          <ConfigItem
            id="mimo-style-prompt"
            orientation="vertical"
            title={i18n.t("options.tts.mimo.stylePrompt")}
            description={
              voiceIsDesigned && !stylePromptIsSet
                ? i18n.t("options.tts.mimo.stylePromptRequired")
                : i18n.t("options.tts.mimo.stylePromptDescription")
            }
          >
            <Textarea
              rows={2}
              className="w-full"
              aria-label={i18n.t("options.tts.mimo.stylePrompt")}
              placeholder={i18n.t("options.tts.mimo.stylePromptPlaceholder")}
              value={settings.stylePrompt}
              onChange={(event) => update({ stylePrompt: event.target.value })}
            />
          </ConfigItem>

          <ConfigItem
            id="mimo-format"
            title={i18n.t("options.tts.mimo.audioFormat")}
            description={i18n.t("options.tts.mimo.audioFormatDescription")}
          >
            <Select
              value={settings.format}
              onValueChange={(value) => {
                if (value) update({ format: value as MimoTtsSettings["format"] })
              }}
            >
              <SelectTrigger size="sm" aria-label={i18n.t("options.tts.mimo.audioFormat")}>
                <SelectValue render={<span />}>{i18n.t(FORMAT_LABEL_KEY[settings.format])}</SelectValue>
              </SelectTrigger>
              <SelectContent align="start">
                <SelectGroup>
                  {MIMO_TTS_FORMATS.map((format) => (
                    <SelectItem key={format} value={format}>
                      {i18n.t(FORMAT_LABEL_KEY[format])}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </ConfigItem>

          <ConfigItem
            id="mimo-test"
            title={i18n.t("options.tts.mimo.test")}
            description={
              needsInstruction ? i18n.t("options.tts.mimo.stylePromptRequired") : undefined
            }
          >
            <Button
              variant="outline"
              size="sm"
              disabled={isFetching || isPlaying || needsInstruction}
              onClick={() => {
                void play(i18n.t("options.tts.mimo.testSentence"), ttsConfig)
              }}
            >
              {isFetching || isPlaying ? (
                <IconLoader2 className="size-4 animate-spin" />
              ) : (
                <IconPlayerPlayFilled className="size-4" />
              )}
              {i18n.t("options.tts.mimo.test")}
            </Button>
          </ConfigItem>
        </>
      )}
    </ConfigSection>
  )
}
