---
title: "Home overview"
description: "Understand live status, volume and entry points for checks."
order: 5
uiLabels: ["Locked", "Running", "Audio stopped", "Choose destination", "Sing", "Talk", "Custom sound", "Mode", "Level being sent", "Output muted / volume zero", "Output level", "Lock controls", "Microphone", "Playback source", "Output", "A bit low", "In range", "Too loud", "Check the connection", "Connection details", "Output volume", "Bypass VST", "Emergency mute", "Open VST", "Add", "Voice Check", "Check playback", "VST", "Measure level", "Measure surrounding sound", "Basics", "Shape the sound", "Audio flow", "Playback", "Saved VST setup", "Automatic backups", "Save and restore settings", "Open the VST page", "Noise reduction", "Shape voice", "Singing and talking", "Singing", "Loudness protection", "Detailed settings", "Add VST", "Folders to search", "Detailed adjustments are on the Sound page."]
---

This page separates the home overview for streaming and calls from the overview for listening to music.

## Streaming and calls {#for-voice}

### Current status {#stage}

Current status shows the “Mode” name, whether sound is coming in, and “Level being sent”. The mute note appears only when the output is muted or the volume is zero.

The status, elapsed time, and audio path are on the top band.

The “Sing” and “Talk” switch is on the top band too.

“Lock controls” is in the right column.

Voice flow appears once sound starts coming in after you start audio. When audio is stopped or waiting, Current status shows the state.

Check “Running” or “Audio stopped”, the elapsed time, and the audio path on the band at the top of the center column. The card shows “Mode” beside the name. When neither saved Sing nor Talk matches, neither is selected on the top band, and the heading is “Custom sound”. Incoming sound and “Level being sent” are on this card. When the output is muted or the volume is zero, it says “Output muted / volume zero”. When it is not muted, that note is absent. “Choose destination” stays in Current status. There is at most one primary button. “Voice Check” opens from the right end of that band. “Bypass VST” inside it uses the same name and the same state as the switch in the right column.

“Lock controls” is in the column on the right. While locked, it shows “Locked”. Stop and “Emergency mute” stay available.

### Meters {#meters}

In the right column, “Microphone” shows incoming sound and “Output” shows sound after processing.

“Level being sent” on Current status shows the same output on a wider bar.

The bar follows the current level, and the output number in the right column holds a recent peak.

Moving meters do not confirm that someone else can hear you.

Incoming sound is shown on this bar and the voice flow at the current level, without delay.

The output may also say “A bit low”, “In range”, or “Too loud”.

The scale runs in even steps from −60 dBFS to 0 dBFS. The right column, the bar in Current status, and the voice flow use the same scale. “Level being sent” has thin marks at the boundary of “A bit low” and of “Too loud”.

While waiting, silent, or stopped, the bars keep their size and position. Waiting and silence are written inside the bar. While stopped, the bar stays empty, and the output number in the right column becomes a dash. Stopped is still announced. The value is not delayed to look smoother.

### Sound flow {#flow}

One band stacks the level before processing and the level after. The waveform is drawn only while sound is coming in. While silent or waiting, the band shows that state in words where the waveform would be. While stopped, it shows neither those words nor the legend, and keeps the same height as while running. “Measure level” starts from the heading of this band.

### Sound adjustments {#sound}

“Noise reduction” targets steady noise such as fans, and does not fully remove speech or music.

Use “Shape voice” or VST effects to adjust your voice, then listen with Voice Check.

You can choose the strength, type, and amount while off. Choosing does not turn it on, and the sound does not change.

On a tall window, the second row of each card shows “Measure surrounding sound”, the voice type, and controls that open each VST. On a short window, “Detailed adjustments are on the Sound page.” under the sound section opens the Sound page.

When no VST is loaded, open the page with “Add”. Otherwise use “Open VST”.

The Sound page is split into “Basics”, “Singing and talking”, “Singing”, and “Loudness protection”.

On and off for “Loudness protection” is the switch beside the heading. Ceiling and release are in “Detailed settings”.

“Add VST” searches VST3 plugins only.

The standard folders cannot be removed. Add other places from “Folders to search”.

Turn noise reduction and voice shaping on or off with the switch on each card. Strength and voice type stay on the card, without opening it. Open the “VST” page from the rail. When none are loaded, use “Add”. When the count is unknown, or at least one is loaded, use “Open VST”. While audio is stopped, one note under the heading says that noise reduction and voice shaping change after audio starts. Each card is only its name row and does not grow to the height of the card beside it. “Add” stays when no VST is loaded. Change one thing at a time and [listen](./sound.md#voice-check).

### Check the connection {#audio-check}

“Check the connection” leads to connection and destination checks.

On a wide window, the connection column opens on the right of Home. On a narrow window, open it from “Connection details” below.

Hearing your own voice and confirming sound in your streaming or calling app are separate checks.

On a wide window, preparation opens in a column on the right of Home, with “Connection details” expanded. On a narrow window, open it from “Connection details” below. Tell the output device apart from the destination, and confirm the receiving app as well.

### Live controls on the right {#output-volume}

The right column runs from “Emergency mute”, microphone volume, “Output volume”, and “Bypass VST” to “Lock controls”.

“Bypass VST” bypasses external VST effects; noise reduction and voice shaping continue.

Use “Output volume” to set the level. To silence the sound immediately, use “Emergency mute” in the same column.

## Listening to music {#for-music}

### Current status {#music-stage}

It shows the path from the playback source to the output and “Output level”.

The status, elapsed time, and audio path are on the top band.

“Lock controls” appears in the right column only while locked.

“Audio flow” appears once sound starts coming in after you start audio. When audio is stopped or waiting, Current status shows the state.

When setup is already finished, “Shape the sound” follows Current status, then “Playback”, then “Audio flow”.

“Playback” includes the connection method, the sample rate, the switch for “Saved VST setup”, and “Bypass VST”.

While audio is stopped, the heading still uses the saved playback source and output shown on the band above. A running setup is used when one is active. The note beside Start audio names the playback source and the output. “Check playback” opens from the right end of that band. “Bypass VST” inside it uses the same name and the same state as the switch in the right column.

“Shape the sound” follows Current status, then “Playback”, “Audio flow”, and “Connection details”. Setups you saved come first. A backup made while recovering a VST layout is grouped afterward under “Automatic backups”. If you have neither a saved setup nor a backup, it points to “Save and restore settings” and offers “Open the VST page”. When only a backup is present, that list is shown instead of the empty guidance. While a setup is switching, the choice and the comparison stay unavailable. While audio is stopped, “Bypass VST” cannot be used. The reason is tied to the switch. While comparing, it also appears in the right column.

While locked, it shows “Locked”. Stop and “Emergency mute” stay available.

### Playback source and output meters {#music-meters}

In the right column, “Playback source” shows incoming sound and “Output” shows sound after processing.

“Output level” on Current status shows the same output on a wider bar.

The bar follows the current level, and the output number in the right column holds a recent peak.

Incoming sound is shown on this bar and “Audio flow” at the current level, without delay.

The output may also say “A bit low”, “In range”, or “Too loud”. “Output level” has thin marks at the boundary of “A bit low” and of “Too loud”.

### Sound flow {#music-flow}

One band stacks the level before processing and the level after. The waveform is drawn only while sound is coming in. While silent or waiting, the band shows that state in words where the waveform would be. While stopped, it shows neither those words nor the legend, and keeps the same height as while running. “Measure level” starts from the heading of this band.

### Shape the sound {#music-sound}

When no VST is loaded, open the page with “Add”. Otherwise use “Open VST”. The note about changing noise reduction and voice shaping is not shown here. “Add” stays available while audio is stopped.

On and off for “Loudness protection” is the switch beside the heading. Ceiling and release are in “Detailed settings”.

“Add VST” searches VST3 plugins only.

The standard folders cannot be removed. Add other places from “Folders to search”.

### Check the connection {#music-audio-check}

Use “Connection details” to check the connection.

On a wide window, the connection column opens on the right of Home. On a narrow window, open it from “Connection details” below.

### Controls on the right {#music-output}

The right column runs from “Emergency mute” and “Playback source” volume to “Output volume”. “Bypass VST” appears while comparing, and “Lock controls” appears while locked.

“Bypass VST” is in “Playback”, and it appears in the right column only while comparing.

“Bypass VST” bypasses the VST only.

## Related pages {#related}

- [Adjusting sound](./sound.md#noise-reduction)
- [Hotkeys](./shortcuts.md#actions)
- [Troubleshooting](./troubleshooting.md#no-sound)
