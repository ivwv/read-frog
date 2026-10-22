import { useAtom } from "jotai"
import { useEffect, useState } from "react"
import { Input } from "@/components/ui/base-ui/input"
import { SliderComfortable } from "@/components/ui/base-ui/slider"
import { toastManager } from "@/components/ui/base-ui/toast"
import {
  MAX_TTS_PITCH,
  MAX_TTS_VOLUME,
  MIN_TTS_PITCH,
  MIN_TTS_VOLUME,
  ttsPitchSchema,
  ttsVolumeSchema,
} from "@/types/config/tts"
import { configFieldsAtomMap } from "@/utils/atoms/config"
import { i18n } from "@/utils/i18n"
import {
  getTtsPlaybackRate,
  MAX_TTS_PLAYBACK_RATE,
  MIN_TTS_PLAYBACK_RATE,
  saveTtsPlaybackRate,
} from "@/utils/tts/playback-rate"
import { ConfigItem } from "../../../components/config-item"
import { ConfigSection } from "../../../components/config-section"

/** How the chosen voice delivers a line — the speed of playback, then two dials on the voice itself. */
export function SpeechSection() {
  const [ttsConfig, setTtsConfig] = useAtom(configFieldsAtomMap.tts)

  return (
    <ConfigSection id="speech" title={i18n.t("options.tts.speech.title")}>
      <ConfigItem
        id="tts-rate"
        title={i18n.t("options.tts.speech.rate.title")}
        description={i18n.t("options.tts.speech.rate.description")}
      >
        <SpeechRateSlider />
      </ConfigItem>
      <ConfigItem
        id="tts-pitch"
        title={i18n.t("options.tts.speech.pitch.title")}
        description={i18n.t("options.tts.speech.pitch.description")}
      >
        <SpeechDialInput
          value={ttsConfig.pitch}
          min={MIN_TTS_PITCH}
          max={MAX_TTS_PITCH}
          schema={ttsPitchSchema}
          onValue={(pitch) => {
            void setTtsConfig({ pitch })
          }}
        />
      </ConfigItem>
      <ConfigItem
        id="tts-volume"
        title={i18n.t("options.tts.speech.volume.title")}
        description={i18n.t("options.tts.speech.volume.description")}
      >
        <SpeechDialInput
          value={ttsConfig.volume}
          min={MIN_TTS_VOLUME}
          max={MAX_TTS_VOLUME}
          schema={ttsVolumeSchema}
          onValue={(volume) => {
            void setTtsConfig({ volume })
          }}
        />
      </ConfigItem>
    </ConfigSection>
  )
}

/**
 * Speed is a multiplier of the voice's own pace, applied to the audio element at playback.
 *
 * Dragging is continuous but the write is not, so the thumb follows a local draft and only the
 * released value is stored. The width is fixed: a slider that stretched with the control column
 * would read a different multiplier per point at every window size.
 */
function SpeechRateSlider() {
  const [rate, setRate] = useState<number | null>(null)

  useEffect(() => {
    let active = true
    void getTtsPlaybackRate().then((stored) => {
      if (active) setRate(stored)
    })
    return () => {
      active = false
    }
  }, [])

  if (rate === null) return null

  return (
    <div className="w-56">
      <SliderComfortable
        variant="scrubber"
        aria-label={i18n.t("options.tts.speech.rate.title")}
        min={MIN_TTS_PLAYBACK_RATE}
        max={MAX_TTS_PLAYBACK_RATE}
        step={0.1}
        value={rate}
        onChange={setRate}
        onCommit={(next) => {
          setRate(next)
          void saveTtsPlaybackRate(next)
        }}
        formatValue={(value) => `${Number(value.toFixed(1))}x`}
      />
    </div>
  )
}

/**
 * Every dial takes a minus sign, so the draft is only judged once the field is left — reporting
 * mid-entry would fire on the "-" the reader is still typing a number after.
 */
function SpeechDialInput({
  value,
  min,
  max,
  schema,
  onValue,
}: {
  value: number
  min: number
  max: number
  schema: typeof ttsPitchSchema
  onValue: (value: number) => void
}) {
  const [draftValue, setDraftValue] = useState(String(value))
  const [prevValue, setPrevValue] = useState(value)

  // Reset the draft when the config value changes externally
  if (prevValue !== value) {
    setPrevValue(value)
    setDraftValue(String(value))
  }

  return (
    <Input
      className="w-24 shrink-0"
      type="number"
      min={min}
      max={max}
      step={1}
      value={draftValue}
      onChange={(e) => {
        const rawValue = e.target.value
        setDraftValue(rawValue)
        // An empty field coerces to 0, which is a value the reader never asked for
        const parseResult = schema.safeParse(rawValue)
        if (rawValue !== "" && parseResult.success) {
          onValue(parseResult.data)
        }
      }}
      onBlur={() => {
        const parseResult = schema.safeParse(draftValue)
        if (draftValue === "" || !parseResult.success) {
          toastManager.add({
            type: "error",
            title: i18n.t("options.tts.speech.error", [min, max]),
          })
          setDraftValue(String(value))
        }
      }}
    />
  )
}
