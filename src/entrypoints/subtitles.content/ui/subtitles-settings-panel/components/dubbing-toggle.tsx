import type { DubbingAudioSettings } from "@/utils/subtitles/dubbing-audio"
import {
  IconAlertTriangle,
  IconInfoCircle,
  IconMicrophone,
  IconPlayerPlayFilled,
  IconVolume,
  IconVolumeOff,
} from "@tabler/icons-react"
import { useAtom } from "jotai"
import { use, useEffect, useState } from "react"
import { SliderComfortable } from "@/components/ui/base-ui/slider"
import { Switch } from "@/components/ui/base-ui/switch"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/base-ui/tooltip"
import { configFieldsAtomMap } from "@/utils/atoms/config"
import { i18n } from "@/utils/i18n"
import { ShadowWrapperContext } from "@/utils/react-shadow-host/create-shadow-host"
import { cn } from "@/utils/styles/utils"
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
  const shadowWrapper = use(ShadowWrapperContext)
  const dubbingState = useAtom(dubbingStateAtom)[0]

  // The config is the user's persisted preference and also drives the runtime
  // on the next session; the runtime flag is what is actually speaking now.
  const isEnabled = dubbingState.enabled
  // A failure streak means the switch is on but nothing can be spoken — the
  // cue is lost, not the whole feature, so a hint on the row itself is the
  // quietest place that still says what to check.
  const isFailing = isEnabled && dubbingState.failingSince !== null

  const toggle = async (checked: boolean) => {
    // Persist the preference, then drive the scheduler immediately.
    await setVideoSubtitlesConfig({ dubbing: { ...videoSubtitlesConfig.dubbing, enabled: checked } })
    await setDubbingEnabled(checked)
  }

  return (
    <SubtitlesSettingsItem
      icon={<IconVolume className="size-3.5" />}
      label={
        isFailing ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="truncate">{title}</span>
            <Tooltip>
              <TooltipTrigger render={<span className="inline-flex shrink-0 items-center" />}>
                <IconAlertTriangle className="size-3.5 text-amber-500" />
              </TooltipTrigger>
              <TooltipContent
                container={shadowWrapper}
                className="max-w-64 border border-border bg-popover text-popover-foreground"
              >
                {i18n.t("subtitles.dubbing.failingHint")}
              </TooltipContent>
            </Tooltip>
          </span>
        ) : (
          title
        )
      }
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

/**
 * How much spoken audio is waiting to play.
 *
 * Shown while dubbing is on, because the number is the only visible signal that
 * synthesis is losing ground: a video played faster than the engine answers
 * drains this to 0 and starts dropping sentences, and the fix is either a lower
 * speed or a higher dubbing concurrency. It is a readout, not a control — the
 * two knobs it points at are the video's own speed and the MiMo settings page.
 */
export function DubbingBufferStatus() {
  const shadowWrapper = use(ShadowWrapperContext)
  const dubbingState = useAtom(dubbingStateAtom)[0]

  if (!dubbingState.enabled) return null

  const isMimo = dubbingState.engine === "mimo"
  const isStarved = dubbingState.bufferedCount === 0

  return (
    <SubtitlesSettingsItem
      icon={<IconPlayerPlayFilled className="size-3.5" />}
      label={
        <span className="inline-flex items-center gap-1.5">
          <span className="truncate">{i18n.t("subtitles.dubbing.buffered", [`${dubbingState.bufferedCount}`])}</span>
          <Tooltip>
            <TooltipTrigger render={<span className="inline-flex shrink-0 items-center" />}>
              <IconInfoCircle className="size-3.5 text-muted-foreground" />
            </TooltipTrigger>
            <TooltipContent
              container={shadowWrapper}
              className="max-w-64 border border-border bg-popover text-popover-foreground"
            >
              {/* The advice only applies where there is a concurrency dial to
                  turn, so Edge gets the plain description. */}
              {isMimo
                ? i18n.t("subtitles.dubbing.bufferedHint")
                : i18n.t("subtitles.dubbing.bufferedHintEdge")}
            </TooltipContent>
          </Tooltip>
        </span>
      }
    >
      <span
        // Amber when nothing is ready to speak: on a running video that is the
        // signal to act, and colour is what carries it at a glance.
        className={cn(
          "text-xs tabular-nums",
          isStarved ? "font-medium text-amber-500" : "text-muted-foreground",
        )}
        aria-live="polite"
      >
        {dubbingState.bufferedCount}
      </span>
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
