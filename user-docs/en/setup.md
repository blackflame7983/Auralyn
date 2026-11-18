---
title: "First setup"
description: "Choose how you will use it and your devices, then check the path to the receiving app."
order: 2
uiLabels: ["Connection details", "Open Setup", "Skip setup", "Listen to music (apply VST to PC audio)", "Hear my own voice", "How you will use it", "I want to listen here", "What will you use it for?", "Running", "Start audio", "Start listening", "Playback source", "Bypass VST"]
---

## What to do first {#first-steps}

### For streaming and calls {#first-steps-voice}

1. In the Setup that opens first, choose Use and your microphone. If you closed it, open it again from “Open Setup” in “Connection details”.
2. If the status on the top band says “Running”, audio is already on. If it is stopped, press “Start audio” on Home.
3. In OBS, the audio input capture meter moving with your voice means it arrived. In a calling app, check its input meter. With “Hear my own voice”, check by hearing your voice.

If it does not arrive, see [Others cannot hear you](./troubleshooting.md#not-received).

### For listening to music {#first-steps-music}

1. In the Setup that opens first, choose “Listen to music (apply VST to PC audio)” for Use, then your playback source and listening device. If you closed it, open it again from “Open Setup” in “Connection details”.
2. If the status on the top band says “Running”, audio is already on. If it is stopped, press “Start listening” on Home.
3. Play a song in your music app. If you hear it on your own headphones or speakers and the “Playback source” bar on the right of the screen moves, sound is coming in. When you have added a VST, press “Bypass VST” to compare; if the sound changes, the VST is applied.

If there is no sound, see [No sound](./troubleshooting.md#no-sound).

## Choose what to use it for {#purpose}

1. Open “Connection details” and select “Open Setup”.
2. The first screen asks “What will you use it for?”. Choose OBS, calls, “Hear my own voice”, other apps, or “Listen to music (apply VST to PC audio)”. Selecting a card moves to the next step.

“Skip setup” on the first screen returns to Home without changing any settings. If audio is not set up yet, it stays stopped.

“Hear my own voice” processes the microphone and plays it on headphones or speakers. The choice under “How you will use it” is “I want to listen here”. To apply a VST to playback from an app, choose “Listen to music (apply VST to PC audio)”. Hear my own voice and listening to music do not show streaming or listener wording on the review or the finished screen.

## Choose a microphone {#microphone}

1. Select the microphone that will capture your voice.
2. For ASIO devices, also check the input and output channel pairs.

## Choose an output {#output}

1. For “Hear my own voice”, select headphones or speakers.
2. For a virtual cable route, select CABLE Input as Auralyn's output and CABLE Output as the receiving app's input.
3. Review the devices and continue setup.

## Confirm reception {#confirmation}

1. Speak into the microphone to check audio.
2. Check the input meter and listen in OBS or your calling app too.

Finishing the instructions does not necessarily confirm reception. Resume through “Connection details” if you closed setup. Use diagnostic test tones only when they cannot reach a stream, recording or call.

## Related pages {#related}

- [Send audio to OBS](./obs.md#connect)
- [Use audio in calls](./discord.md#connect)
- [Troubleshooting](./troubleshooting.md#no-sound)
