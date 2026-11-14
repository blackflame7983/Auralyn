---
title: "Home overview"
description: "Understand live status, volume and entry points for checks."
order: 5
uiLabels: ["Locked", "Running", "Audio stopped", "Choose destination", "Sing", "Talk", "Custom sound", "Mode", "Level being sent", "Not muted", "Output muted / volume zero", "Output level", "Lock controls", "Microphone", "Playback source", "Output", "A bit low", "In range", "Too loud", "Check the connection", "Connection details", "Output volume", "Compare without VST", "Emergency mute", "Open VST", "Add", "Voice Check", "Check playback", "Compare with VST off", "VST", "Measure level", "Measure surrounding sound", "Basics", "Playback", "Saved VST setup", "Save and restore settings", "Open the VST page"]
---

## Current status {#stage}

Check “Running” or “Audio stopped”, the elapsed time, and the audio path on the band at the top of the center column. “Sing” and “Talk” switch there too. The card shows “Mode” beside the name. An unsaved adjustment is shown as “Custom sound”. Incoming sound, “Level being sent”, and whether the output is muted are on this card. When it is not muted, the card says “Not muted”. When the output is muted or the volume is zero, it says “Output muted / volume zero”. While listening to music, the card shows the path from the playback source to the output, and “Output level”. “Choose destination” stays in Current status. There is at most one primary button. “Voice Check” opens from the right end of that band. While listening to music, the label is “Check playback”. “Compare with VST off” inside it uses the same state as “Compare without VST” in the right column.

When music listening is already set up, “Playback” follows Current status. It shows the connection method and sample rate, a switch for the “Saved VST setup”, and “Compare with VST off”. If nothing is saved, it points to “Save and restore settings” and offers “Open the VST page”. While a setup is switching, the choice and the comparison stay unavailable.

“Lock controls” is in the column on the right. While locked, it shows “Locked”. Stop and “Emergency mute” stay available.

## Meters {#meters}

In the right column, “Microphone” (“Playback source” while listening to music) shows incoming sound, and “Output” shows the level after processing. Current status shows the same output on a wider bar as “Level being sent” (“Output level” while listening to music). The bar follows the current level. The output number in the right column holds a recent peak. The output may also say “A bit low”, “In range”, or “Too loud”. Moving meters do not confirm that a stream or call is receiving you.

While waiting, silent, or stopped, the bars keep their size and position. Incoming sound stays on this bar and the sound-flow band at the current level. The value is not delayed to look smoother.

## Sound flow {#flow}

One band stacks the level before processing and the level after. The waveform is drawn only while sound is coming in. While silent, waiting, or stopped, the band shows that state in words where the waveform would be. “Measure level” starts from the heading of this band.

## Sound adjustments {#sound}

Turn noise reduction and voice shaping on or off with the switch on each card. Strength and voice type stay on the card, without opening it. You can choose the strength, type, and amount while off. Choosing does not turn it on, and the sound does not change. On a tall window, the second row shows “Measure surrounding sound”, the voice type, and controls that open each VST. On a short window, open the same controls from “Basics” on the Sound page and from the VST page. Open the “VST” page from the rail. When none are loaded, use “Add”. When the count is unknown, or at least one is loaded, use “Open VST”. Change one thing at a time and [listen](./sound.md#voice-check).

## Check the connection {#audio-check}

Use “Check the connection” to check the connection and destination. On a wide window, preparation opens in a column on the right of Home, with “Connection details” expanded. On a narrow window, open it from “Connection details” below. Tell the output device apart from the destination, and confirm the receiving app as well.

## Live controls on the right {#output-volume}

The column on the right runs, from the top, through “Emergency mute”, microphone volume, “Output” and “Output volume”, “Compare without VST”, and “Lock controls”. Use “Output volume” to set the level. “Compare without VST” temporarily bypasses external VST effects only. Noise reduction and voice shaping continue.

To silence the sound immediately, use “Emergency mute” in the same column.

## Related pages {#related}

- [Adjusting sound](./sound.md#noise-reduction)
- [Hotkeys](./shortcuts.md#actions)
- [Troubleshooting](./troubleshooting.md#no-sound)
