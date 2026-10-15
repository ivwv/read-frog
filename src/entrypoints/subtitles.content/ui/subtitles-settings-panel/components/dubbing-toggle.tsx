import type { DubbingAudioSettings } from "@/utils/subtitles/dubbing-audio"
import { IconMicrophone, IconVolume, IconVolumeOff } from "@tabler/icons-react"
import { useAtom } from "jotai"
import { useEffect, useState } from "react"
import { SliderComfortable } from "@/components/ui/base-ui/slider"
import { Switch } from "@/components/ui/base-ui/switch"
import { configFieldsAtomMap } from "@/utils/atoms/config"
import { i18n } from "@/utils/i18n"
import {
  getDubbingAudioSettings,
  MAX_DUBBING_VOLUME,
  MIN_DUBBING_VOLUME,
  saveDubbingAudioSettings,
} from "@/utils/subtitles/dubbing-audio"
import { dubbingStateAtom } from "../../../atoms"
import { useSubtitlesUI } from "../../subtitles-ui-context"
import { SubtitlesSettingsItem } from "./subtitles-settings-item"

/** Reads translated cues aloud while the video plays. */
export function DubbingToggle() {
  const title = i18n.t("subtitles.dubbing.speakTranslated")
  const switchId = "read-frog-dubbing-toggle"
  const [videoSubtitlesConfig, setVideoSubtitlesConfig] = useAtom(
    configFieldsAtomMap.videoSubtitles,
  )
  const { setDubbingEnabled } = useSubtitlesUI()
  const dubbingRuntimeEnabled = useAtom(dubbingStateAtom)[0].enabled

  // The config is the user's persisted preference and also drives the runtime
  // on the next session; the runtime flag is what is actually speaking now.
  const isEnabled = dubbingRuntimeEnabled

  const toggle = async (checked: boolean) => {
    // Persist the preference, then drive the scheduler immediately.
    await setVideoSubtitlesConfig({ dubbing: { ...videoSubtitlesConfig.dubbing, enabled: checked } })
    await setDubbingEnabled(checked)
  }

  return (
    <SubtitlesSettingsItem
      icon={<IconVolume className="size-3.5" />}
      label={title}
      labelFor={switchId}
    >
      <Switch
        id={switchId}
        checked={isEnabled}
        onCheckedChange={(checked) => void toggle(checked)}
        aria-label={title}
      />
    </SubtitlesSettingsItem>
  )
}

/** Mutes the video's own audio so only the dubbing voice is heard. */
export function DubbingMuteOriginal() {
  const title = i18n.t("subtitles.dubbing.muteOriginal")
  const switchId = "read-frog-dubbing-mute-original"
  const [videoSubtitlesConfig, setVideoSubtitlesConfig] = useAtom(
    configFieldsAtomMap.videoSubtitles,
  )
  const { setDubbingMuteOriginal } = useSubtitlesUI()
  const dubbingEnabled = useAtom(dubbingStateAtom)[0].enabled

  const toggle = async (checked: boolean) => {
    await setVideoSubtitlesConfig({
      dubbing: { ...videoSubtitlesConfig.dubbing, muteOriginal: checked },
    })
    await setDubbingMuteOriginal(checked)
  }

  // Only meaningful while dubbing actually speaks.
  if (!dubbingEnabled) return null

  return (
    <SubtitlesSettingsItem
      icon={<IconVolumeOff className="size-3.5" />}
      label={title}
      labelFor={switchId}
    >
      <Switch
        id={switchId}
        checked={videoSubtitlesConfig.dubbing.muteOriginal}
        onCheckedChange={(checked) => void toggle(checked)}
        aria-label={title}
      />
    </SubtitlesSettingsItem>
  )
}

/** One level, as a labelled slider that reads its value out as a percentage. */
function DubbingVolumeItem({
  icon,
  title,
  value,
  disabled,
  onChange,
  onCommit,
}: {
  icon: React.ReactNode
  title: string
  value: number
  disabled?: boolean
  onChange: (value: number) => void
  onCommit: (value: number) => void
}) {
  return (
    <div className="rounded-lg px-2 py-1.5 transition-colors hover:bg-muted/50">
      <div className="flex items-center gap-2">
        <div className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
          {icon}
        </div>
        <div className="min-w-0 flex-1 text-xs leading-5 font-light">{title}</div>
      </div>
      {/* Indented to the label's text, so the slider reads as belonging to it. */}
      <div className="mt-1 pl-6">
        <SliderComfortable
          variant="scrubber"
          aria-label={title}
          value={value}
          min={MIN_DUBBING_VOLUME}
          max={MAX_DUBBING_VOLUME}
          step={5}
          formatValue={(level) => `${level}%`}
          disabled={disabled}
          onChange={onChange}
          onCommit={onCommit}
        />
      </div>
    </div>
  )
}

/**
 * The two levels dubbing mixes: the video's own audio, and the spoken
 * translation.
 *
 * Both rows share one piece of state because they persist together — a record
 * holds both fields, so two independent loaders would each write the whole
 * record back and clobber the other's value.
 */
export function DubbingVolumeControls() {
  const { setDubbingOriginalVolume, setDubbingVolume } = useSubtitlesUI()
  const dubbingEnabled = useAtom(dubbingStateAtom)[0].enabled
  const muteOriginal = useAtom(configFieldsAtomMap.videoSubtitles)[0].dubbing.muteOriginal
  const [settings, setSettings] = useState<DubbingAudioSettings | null>(null)

  useEffect(() => {
    let active = true
    void getDubbingAudioSettings().then((loaded) => {
      if (active) setSettings(loaded)
    })
    return () => {
      active = false
    }
  }, [])

  if (!dubbingEnabled || !settings) return null

  // The audio follows the drag, so a level is heard as it is set.
  const change = (
    key: keyof DubbingAudioSettings,
    applyToAudio: (percent: number) => Promise<void>,
    value: number,
  ) => {
    setSettings((current) => (current ? { ...current, [key]: value } : current))
    void applyToAudio(value)
  }

  // Persisting waits for release — a storage write per frame is not free — and
  // patches the stored record rather than the rendered one: both rows share a
  // single record, so this cannot clobber the other row's committed value.
  const commit = (key: keyof DubbingAudioSettings, value: number) => {
    void (async () => {
      const next = { ...(await getDubbingAudioSettings()), [key]: value }
      setSettings(next)
      await saveDubbingAudioSettings(next)
    })()
  }

  return (
    <>
      <DubbingVolumeItem
        icon={<IconVolume className="size-3.5" />}
        title={i18n.t("subtitles.dubbing.originalVolume")}
        value={settings.originalVolume}
        // Muting the original makes the level moot, so the control says so
        // rather than silently doing nothing.
        disabled={muteOriginal}
        onChange={(value) => change("originalVolume", setDubbingOriginalVolume, value)}
        onCommit={(value) => commit("originalVolume", value)}
      />
      <DubbingVolumeItem
        icon={<IconMicrophone className="size-3.5" />}
        title={i18n.t("subtitles.dubbing.dubbingVolume")}
        value={settings.dubbingVolume}
        onChange={(value) => change("dubbingVolume", setDubbingVolume, value)}
        onCommit={(value) => commit("dubbingVolume", value)}
      />
    </>
  )
}
