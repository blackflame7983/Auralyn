---
title: "Home overview"
description: "Understand live status, volume and entry points for checks."
order: 5
uiLabels: ["Locked", "Running", "Audio stopped", "Choose destination", "Sing", "Talk", "Custom sound", "Current voice", "Not a saved Sing/Talk mode", "Mode", "Level being sent", "Output muted / volume zero", "Output level", "Lock controls", "Microphone", "Playback source", "Output", "A bit low", "In range", "Too loud", "Receiving", "The area between the lines is in range.", "Check the connection", "Connection details", "Output volume", "Bypass VST", "Emergency mute", "Open VST", "Add", "Voice Check", "Check playback", "VST", "Measure level", "Measure playback level", "Measure surrounding sound", "Basics", "Shape the sound", "Audio flow", "Compares before and after", "Music listening", "Start listening", "Saved setups", "Saved VST setup", "Automatic backups", "Noise reduction", "Shape voice", "Save modes", "Singing tuning", "Loudness protection", "Detailed settings", "Add VST", "Folders to search", "Detailed adjustments are on the Sound page.", "More", "Light compression remains even at 0%. Turn it off to stop it.", "Sound controls", "Status unavailable", "Start audio to measure.", "Save and restore settings", "Stopped", "Start audio", "Stop Auralyn’s audio", "Quit Auralyn"]
---

This page separates the home overview for streaming and calls from the overview for listening to music.

## Streaming and calls {#for-voice}

### Current status (see whether your voice is coming through) {#stage}

When Sing or Talk is saved, Current status shows “Mode” and the name, and when neither is saved the heading is “Current voice”. It also shows whether sound is coming in and “Level being sent”, and the mute note appears only when the output is muted or the volume is zero.

The status display, elapsed time, and audio path are at the top of the screen. When the path does not fit, the beginning is left off and the destination stays. The full path appears when you hover.

Press the status on the top band to open a menu. While running, it offers “Stop Auralyn’s audio” and “Quit Auralyn”. While stopped, it offers “Start audio” and “Quit Auralyn”. Closing the window hides Auralyn in the tray, and the audio keeps running.

The “Sing” and “Talk” switch is at the top of the screen too.

“Lock controls” is on the right side of the screen.

Voice flow appears once sound starts coming in after you start audio. When audio is stopped or waiting, Current status shows the state.

Check “Running” or “Audio stopped”, the elapsed time, and the audio path on the band at the top of the center column. When Sing or Talk is saved, the card shows “Mode” beside the name. When neither is saved, the heading is “Current voice” and “Mode” is not shown. When neither saved Sing nor Talk matches, neither is selected on the top band, and the heading is “Custom sound”. Beside it, the card says “Not a saved Sing/Talk mode”. Incoming sound and “Level being sent” are on this card. When the output is muted or the volume is zero, it says “Output muted / volume zero”. When it is not muted, that note is absent. “Choose destination” stays in Current status. There is at most one primary button. “Voice Check” opens from the right end of that band. “Bypass VST” inside it uses the same name and the same state as the switch in the right column.

“Lock controls” is in the column on the right. While locked, it shows “Locked”. Stop and “Emergency mute” stay available.

### Microphone and output meters (check the level) {#meters}

On the right side of the screen, “Microphone” is the bar for incoming sound. “Output” is the peak number.

The level sent onward is the “Level being sent” bar on Current status. While stopped, waiting, or no longer updating, the in-range tint stays off.

The bar follows the current level, and the output number on the right side of the screen holds a recent peak.

Moving meters do not confirm that someone else can hear you.

Incoming sound is shown on the input bar at the right, at the current level and without delay. Voice flow compares the sound before and after processing.

The output may also say “A bit low”, “In range”, or “Too loud”. The right column shows one of those three only while sound is flowing and the output is not muted. Current status hides “In range”, and shows “A bit low” or “Too loud” in the warning color. While sound is coming in, the word is “Receiving”.

The scale runs in even steps from −60 dBFS to 0 dBFS. The input in the right column, the bar in Current status, and the voice flow use the same scale. “Level being sent” has thin marks at the boundary of “A bit low” and of “Too loud”. The area between them is tinted as the in-range span only while a level is coming in. While stopped, waiting, or no longer updating, that tint stays off and the lines remain. The bar says “The area between the lines is in range.”

While waiting, silent, or stopped, the incoming bar and the bar in Current status keep their size and position. Waiting and silence are written inside those bars. While stopped, the bars stay empty, and the output number in the right column becomes a dash. Stopped is still announced. The value is not delayed to look smoother.

### Sound flow {#flow}

One band stacks the level before processing and the level after. The heading shows “Compares before and after”. This band is not where you read how loud the output is. While sound is coming in, the band draws the waveform and its legend. While silent, it draws a flat waveform and the legend, and shows no words. While stopped, and before the first value arrives after you start, the band is not shown at all. Once a value has arrived, the band stays until you stop, even when the meter is waiting or no longer updating, and shows the last waveform held still. “Measure level” starts from the heading of this band.

### Sound adjustments (shape noise and voice) {#sound}

“Noise reduction” targets steady noise such as fans, and does not fully remove speech or music.

Use “Shape voice” or VST effects to adjust your voice, then listen with Voice Check.

You can choose the strength, type, and amount while it stays off. The sound does not change until you turn it on. At 0%, the slider says “Light compression remains even at 0%. Turn it off to stop it.” The button at the top right of “Sound controls” shows an icon and “More”.

When you make the window taller, the cards also show “Measure surrounding sound”, the voice type, and controls that open each VST. On a short window, open the Sound page from “Detailed adjustments are on the Sound page.”

When no VST is loaded, open the page with “Add”. Otherwise use “Open VST”.

The Sound page is split into “Basics”, “Save modes”, “Singing tuning”, and “Loudness protection”.

On and off for “Loudness protection” is the switch beside the heading. Ceiling and release are in “Detailed settings”.

“Add VST” searches VST3 plugins only.

The standard folders cannot be removed. Add other places from “Folders to search”.

Turn noise reduction and voice shaping on or off with the switch on each card. Strength and voice type stay on the card, without opening it. Open the “VST” page from the rail. When none are loaded, use “Add”. When the count is unknown, or at least one is loaded, use “Open VST”. While audio is stopped, noise reduction and voice shaping that could be read stay on the cards and can be changed. The values take effect when audio starts. They are kept only while the app is open and reset when you close it. To keep voice shaping, register it in Sing or Talk under “Save modes”, or save a setup. To keep noise reduction, save a setup with “Save and restore settings” on the VST page. Sing and Talk modes do not include noise reduction. When a value cannot be read, or the audio engine has ended, the card says “Status unavailable” and does not show a guessed on or off. “Measure surrounding sound” says “Start audio to measure.” External VST stays a name row and “Add”. Change one thing at a time and [listen](./sound.md#voice-check).

### Check the connection (see whether it gets through) {#audio-check}

“Check the connection” leads to connection and destination checks.

On a wide window, the connection column opens on the right of Home. On a narrow window, open it from “Connection details” below.

Hearing your own voice and confirming sound in your streaming or calling app are separate checks.

The name of the input or source selected in the receiving app stays off Home, and diagnosis asks for it when the receiving-app checklist appears. You can leave it blank and still continue. You can change or clear a saved name in that diagnosis. The saved name also stays in “Connection details”.

On a wide window, preparation opens in a column on the right of Home, with “Connection details” expanded. On a narrow window, open it from “Connection details” below. Tell the output device apart from the destination, and confirm the receiving app as well.

### Live controls on the right of the screen (stop or compare the sound) {#output-volume}

The right side of the screen runs from “Emergency mute”, microphone volume, “Output volume”, and “Bypass VST” to “Lock controls”.

“Bypass VST” bypasses external VST effects; noise reduction and voice shaping continue.

Use “Output volume” to set the level. To silence the sound immediately, use “Emergency mute” in the same column.

## Listening to music {#for-music}

### Current status (see whether sound is playing) {#music-stage}

The heading is “Music listening”, with “Output level”. The path appears once, at the top of the screen.

The status display, elapsed time, and audio path are at the top of the screen. When the path does not fit, the beginning is left off and the destination stays. The full path appears when you hover.

Press the status on the top band to open a menu. While running, it offers “Stop Auralyn’s audio” and “Quit Auralyn”. While stopped, it offers “Start listening” and “Quit Auralyn”. Closing the window hides Auralyn in the tray, and the audio keeps running. While stopped, the status on the top band and the playback source on Current status say “Stopped”.

“Lock controls” appears on the right side of the screen only while locked.

“Audio flow” appears after “Start listening”, once sound starts coming in. When audio is stopped or waiting, Current status shows the state.

When setup is already finished, “Shape the sound” follows Current status, then “Saved setups” only when a setup is saved, then “Audio flow”.

“Saved setups” only switches saved setups. The connection method and sample rate are in “Connection details”.

The path on the top band prefers the running setup, and otherwise uses the saved playback source and output. The note beside the start button names the playback source and the output. “Check playback” opens from the right end of that band. “Bypass VST” inside it uses the same name and the same state as the switch in the right column.

Setups you saved come first. A backup made while recovering a VST layout is grouped afterward under “Automatic backups”. Switch them from “Saved VST setup”. If you have neither a saved setup nor a backup, this card stays hidden. While a setup is switching, the choice stays unavailable.

While locked, it shows “Locked”. Stop and “Emergency mute” stay available.

### Playback source and output meters (check the level) {#music-meters}

On the right side of the screen, “Playback source” is the bar for incoming sound. “Output” is the peak number.

The level you hear is the “Output level” bar on Current status. While stopped, waiting, or no longer updating, the in-range tint stays off.

The bar follows the current level, and the output number on the right side of the screen holds a recent peak.

Incoming sound is shown on the input bar at the right, at the current level and without delay. “Audio flow” compares the sound before and after processing.

The output may also say “A bit low”, “In range”, or “Too loud”. The right column shows one of those three only while sound is flowing and the output is not muted. Current status hides “In range”, and shows “A bit low” or “Too loud” in the warning color. “Output level” has thin marks at the boundary of “A bit low” and of “Too loud”. The area between them is tinted as the in-range span only while a level is coming in. While stopped, waiting, or no longer updating, that tint stays off and the lines remain. The bar says “The area between the lines is in range.” While sound is coming in, the word is “Receiving”.

### Sound flow {#music-flow}

One band stacks the level before processing and the level after. The heading shows “Compares before and after”. This band is not where you read how loud the output is. While sound is coming in, the band draws the waveform and its legend. While silent, it draws a flat waveform and the legend, and shows no words. While stopped, and before the first value arrives after you start, the band is not shown at all. Once a value has arrived, the band stays until you stop, even when the meter is waiting or no longer updating, and shows the last waveform held still. “Measure playback level” starts from the heading of this band.

### Shape the sound (process with a VST) {#music-sound}

When no VST is loaded, open the page with “Add”. Otherwise use “Open VST”. The note about changing noise reduction and voice shaping is not shown here. “Add” stays available while audio is stopped.

On and off for “Loudness protection” is the switch beside the heading. Ceiling and release are in “Detailed settings”.

“Add VST” searches VST3 plugins only.

The standard folders cannot be removed. Add other places from “Folders to search”.

### Check the connection (see whether it is connected) {#music-audio-check}

Use “Connection details” to check the connection.

On a wide window, the connection column opens on the right of Home. On a narrow window, open it from “Connection details” below.

### Controls on the right of the screen (stop or compare the sound) {#music-output}

The right side of the screen runs from “Emergency mute”, “Playback source” volume, and “Output volume” to “Bypass VST”. “Lock controls” also appears while locked.

While audio is stopped, “Bypass VST” cannot be pressed. The reason is tied to the switch.

“Bypass VST” bypasses the VST only.

## Related pages {#related}

- [Adjusting sound](./sound.md#noise-reduction)
- [Hotkeys](./shortcuts.md#actions)
- [Troubleshooting](./troubleshooting.md#no-sound)
