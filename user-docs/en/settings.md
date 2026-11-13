---
title: "Settings reference"
description: "Find the right page and understand when to change it."
order: 8
uiLabels: ["Settings", "Connection", "Connection and dropout settings", "Sound", "Basics", "Singing and talking", "Singing", "Loudness protection", "OBS", "Appearance", "Gaming", "Hotkeys", "System"]
---

## Connection {#audio}

In “Connection” on the left rail, choose microphone, output, connection method, sample rate and dropout settings. Split listening and broadcast outputs, whether to show stream mixing on Home, saved connections, singing and monitoring settings are also here.

1. Check the devices and route you will change.
2. Open “Connection and dropout settings” to adjust the connection or dropouts.
3. Review the changes and interruption notice before applying them.

The button at the bottom saves connection settings. It restarts audio while running, or starts audio while stopped.
Input/output presets save the connection settings you are editing. Loading a preset does not apply it to audio; review it and apply it using the button at the bottom.
Split-output routing is saved and applied independently in its own section. Discarding edits there only restores that section's unapplied values.

## Sound {#sound}

“Sound” is split into “Basics”, “Singing and talking”, “Singing”, and “Loudness protection”. Make small changes following [Adjusting sound](./sound.md#noise-reduction).

Noise reduction and voice adjustments in “Basics” apply as you change them. “Singing” stays a draft until you preview it and apply it with the button at the bottom of the page.
Values in “Loudness protection” do not take effect until you apply them in that section. Leaving for another page or section while those values are unapplied asks you to confirm. Adjustments already applied stay in place when you leave.

## OBS {#obs}

Use “Settings” → “OBS” to configure the endpoint and credentials. A connection does not confirm audio reception. [Check in OBS](./obs.md#verify).

Save scene linking settings in their own section. Once enabled and saved, linking responds to the next actual scene change. Connecting or reconnecting alone does not switch settings.

## Appearance {#appearance}

Choose a theme in “Settings” → “Appearance”. “Gaming” uses cut corners and italic headings. It glows only while a primary button is pressed, and while emergency mute is on. You can also choose whether to show numerical details. Open details when needed.

Display changes take effect immediately without changing audio connections or mute.

## Hotkeys {#shortcuts}

Assign keys in “Settings” → “Hotkeys”. Review the [actions and precautions](./shortcuts.md#actions), then save.

Edited assignments become active after saving. Discarding key edits only restores unsaved key settings.

## System {#system}

“Settings” → “System” contains autostart, updates, audio processing settings, the control that opens diagnostics, and settings migration. Read warnings before changing settings. They do not guarantee better speed or stability.

After registration, advanced processing settings apply on the audio processing restart. They are held in the current app session and are not retained after the app exits.

## Related pages {#related}

- [Adjusting sound](./sound.md#noise-reduction)
- [Hotkeys](./shortcuts.md#assign)
- [Troubleshooting](./troubleshooting.md#dropouts)
