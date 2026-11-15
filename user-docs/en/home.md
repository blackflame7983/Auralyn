---
title: "Home overview"
description: "Understand live status, volume and entry points for checks."
order: 5
uiLabels: ["Locked", "Running", "Audio stopped", "Choose destination", "Sing", "Talk", "Custom sound", "Mode", "Level being sent", "Not muted", "Output muted / volume zero", "Output level", "Lock controls", "Microphone", "Playback source", "Output", "A bit low", "In range", "Too loud", "Check the connection", "Connection details", "Output volume", "Compare without VST", "Emergency mute", "Open VST", "Add", "Voice Check", "Check playback", "VST", "Measure level", "Measure surrounding sound", "Basics", "Playback", "Saved VST setup", "Automatic backups", "Save and restore settings", "Open the VST page"]
---

## Current status {#stage}

Check “Running” or “Audio stopped”, the elapsed time, and the audio path on the band at the top of the center column. “Sing” and “Talk” switch there too. The card shows “Mode” beside the name. An unsaved adjustment is shown as “Custom sound”. Incoming sound, “Level being sent”, and whether the output is muted are on this card. When it is not muted, the card says “Not muted”. When the output is muted or the volume is zero, it says “Output muted / volume zero”. While listening to music, the card shows the path from the playback source to the output, and “Output level”. While audio is stopped, that heading still uses the saved playback source and output shown on the band above. A running setup is used when one is active. The note beside Start audio names the playback source and the output. “Choose destination” stays in Current status. There is at most one primary button. “Voice Check” opens from the right end of that band. While listening to music, the label is “Check playback”. “Compare without VST” inside it uses the same name and the same state as the switch in the right column.

When music listening is already set up, “Playback” follows Current status. It shows the connection method and sample rate, a switch for the “Saved VST setup”, and “Compare without VST”. On the music home, the right column hides it until you are comparing. While comparing, it also appears in the right column. Setups you saved come first. A backup made while recovering a VST layout is grouped afterward under “Automatic backups”. If you have neither a saved setup nor a backup, it points to “Save and restore settings” and offers “Open the VST page”. When only a backup is present, that list is shown instead of the empty guidance. While a setup is switching, the choice and the comparison stay unavailable. While audio is stopped, “Compare without VST” cannot be used. The reason is tied to the switch.

“Lock controls” is in the column on the right. While locked, it shows “Locked”. Stop and “Emergency mute” stay available.

## Meters {#meters}

In the right column, “Microphone” (“Playback source” while listening to music) shows incoming sound, and “Output” shows the level after processing. Current status shows the same output on a wider bar as “Level being sent” (“Output level” while listening to music). The bar follows the current level. The output number in the right column holds a recent peak. The output may also say “A bit low”, “In range”, or “Too loud”. Moving meters do not confirm that a stream or call is receiving you.

The scale runs in even steps from −60 dBFS to 0 dBFS. The right column, the bar in Current status, and the sound flow use the same scale. “Level being sent” (“Output level” while listening to music) has thin marks at the boundary of “A bit low” and of “Too loud”.

While waiting, silent, or stopped, the bars keep their size and position. Waiting and silence are written inside the bar. While stopped, the bar stays empty, and the output number in the right column becomes a dash. Stopped is still announced. Incoming sound stays on this bar and the sound-flow band at the current level. The value is not delayed to look smoother.

## Sound flow {#flow}

One band stacks the level before processing and the level after. The waveform is drawn only while sound is coming in. While silent or waiting, the band shows that state in words where the waveform would be. While stopped, it shows neither those words nor the legend, and keeps the same height as while running. “Measure level” starts from the heading of this band.

## Sound adjustments {#sound}

Turn noise reduction and voice shaping on or off with the switch on each card. Strength and voice type stay on the card, without opening it. You can choose the strength, type, and amount while off. Choosing does not turn it on, and the sound does not change. On a tall window, the second row shows “Measure surrounding sound”, the voice type, and controls that open each VST. On a short window, open the same controls from “Basics” on the Sound page and from the VST page. Open the “VST” page from the rail. When none are loaded, use “Add”. When the count is unknown, or at least one is loaded, use “Open VST”. While audio is stopped, one note under the heading replaces the status on each card. Each card keeps its name, and “Add” stays when no VST is loaded. Change one thing at a time and [listen](./sound.md#voice-check).

## Check the connection {#audio-check}

Use “Check the connection” to check the connection and destination. On a wide window, preparation opens in a column on the right of Home, with “Connection details” expanded. On a narrow window, open it from “Connection details” below. Tell the output device apart from the destination, and confirm the receiving app as well.

## Live controls on the right {#output-volume}

The column on the right runs, from the top, through “Emergency mute”, microphone volume, “Output” and “Output volume”, “Compare without VST”, and “Lock controls”. Use “Output volume” to set the level. “Compare without VST” temporarily bypasses external VST effects only. Noise reduction and voice shaping continue. On the music home, it stays out of this column until you are comparing, and “Playback” is the way in. While comparing, it also appears in this column on other pages. Streaming and calls keep it in this column.

To silence the sound immediately, use “Emergency mute” in the same column.

## Related pages {#related}

- [Adjusting sound](./sound.md#noise-reduction)
- [Hotkeys](./shortcuts.md#actions)
- [Troubleshooting](./troubleshooting.md#no-sound)
