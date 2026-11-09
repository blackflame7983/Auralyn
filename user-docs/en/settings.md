---
title: "Settings reference"
description: "Find the right settings tab and understand when to change it."
order: 8
uiLabels: ["Settings", "Audio", "Connection and dropout settings", "Sound", "OBS", "Appearance", "Hotkeys", "System"]
---

## Audio {#audio}

In “Settings” → “Audio”, choose microphone, output, connection method, sample rate and dropout settings. Split listening and broadcast outputs, stream mixing, saved connections, singing and monitoring settings are also here.

1. Check the devices and route you will change.
2. Open “Connection and dropout settings” to adjust the connection or dropouts.
3. Review the changes and interruption notice before applying them.

The button at the bottom saves connection settings. It restarts audio while running, or starts audio while stopped.
Input/output presets save the connection settings you are editing. Loading a preset does not apply it to audio; review it and apply it using the button at the bottom.
Split-output routing is saved and applied independently in its own section. Discarding edits there only restores that section's unapplied values.

## Sound {#sound}

“Sound” contains noise reduction, voice shaping and singing/talking mode settings. Make small changes following [Adjusting sound](./sound.md#noise-reduction).

Noise reduction and basic voice adjustments apply as you change them. Singing adjustments remain a draft until you preview and apply them.
Edited peak-protection values do not take effect until you apply them in their section. Closing Settings does not undo adjustments already applied.

## OBS {#obs}

Use “OBS” to configure the endpoint and credentials. A connection does not confirm audio reception. [Check in OBS](./obs.md#verify).

Save scene linking settings in their own section. Once enabled and saved, linking responds to the next actual scene change. Connecting or reconnecting alone does not switch settings.

## Appearance {#appearance}

Choose a theme in “Appearance”. You can also choose whether to show numerical details. Open details when needed.

Display changes take effect immediately without changing audio connections or mute.

## Hotkeys {#shortcuts}

Assign keys in “Hotkeys”. Review the [actions and precautions](./shortcuts.md#actions), then save.

Edited assignments become active after saving. Discarding key edits only restores unsaved key settings.

## System {#system}

“System” contains autostart, updates, audio processing settings, diagnostics and settings migration. Read warnings before changing settings. They do not guarantee better speed or stability.

After registration, advanced processing settings apply on the audio processing restart. They are held in the current app session and are not retained after the app exits.

## Related pages {#related}

- [Adjusting sound](./sound.md#noise-reduction)
- [Hotkeys](./shortcuts.md#assign)
- [Troubleshooting](./troubleshooting.md#dropouts)
