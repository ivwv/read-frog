import { IconVolume, IconVolumeOff } from "@tabler/icons-react"
import { useAtom } from "jotai"
import { Switch } from "@/components/ui/base-ui/switch"
import { configFieldsAtomMap } from "@/utils/atoms/config"
import { i18n } from "@/utils/i18n"
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
