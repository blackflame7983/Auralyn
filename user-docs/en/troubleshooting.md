---
title: "Troubleshooting"
description: "Find checks and a next action for each symptom."
order: 7
uiLabels: ["Emergency mute", "Output volume", "Diagnose audio problems", "Check the connection", "Connection", "Connection and dropout settings", "Compare without VST", "Add VST", "Refresh", "Rescan all", "Try again"]
---

## No sound {#no-sound}

1. Check first: microphone connection, “Emergency mute” state and whether “Output volume” is zero.
2. One action in Auralyn: open “Diagnose audio problems” and check input and output status.
3. If it persists: check Windows microphone permission, mute and other apps using the device. For a virtual cable output, check your [local listening route](./obs.md#monitor) too.

## Others cannot hear you {#not-received}

1. Check first: the receiving app's input must connect to Auralyn's output device.
2. One action in Auralyn: open “Check the connection” and check the chosen destination and output device.
3. If it persists: follow the [OBS](./obs.md#connect) or [call](./discord.md#connect) steps to check receiving-app mute and meters, then listen.

## Sound cuts out {#dropouts}

1. Check first: use “Diagnose audio problems” to check audio processing status.
2. One action in Auralyn: increase the buffer in “Connection” → “Connection and dropout settings”. This may improve stability but increases latency.
3. If it persists: compare with external VSTs bypassed using “Compare without VST”. For call-only dropouts, also compare [receiving-app processing](./discord.md#processing).

## Audio is delayed {#latency}

1. Check first: whether monitoring passes through OBS or Windows.
2. One action in Auralyn: try a smaller buffer in “Connection” → “Connection and dropout settings”. Revert if dropouts increase.
3. If it persists: compare external VSTs and monitoring routes one at a time. OBS sync offset cannot speed up your own monitor.

## VST will not load {#vst-load}

1. Check first: read the loading error and confirm the VST is installed.
2. One action in Auralyn: open “Add VST”. When the list is present, use “Refresh” to reload it. Use “Rescan all” to search the folders again, and when the list is empty. If the list could not be read, select “Try again”.
3. If it persists: review the original error detail and the VST installation location. While the saved chain is protected, current changes are not saved automatically.

Use test tones only when they cannot reach streams, recordings or calls. A diagnosis without problems applies only to the items it could check.

## Related pages {#related}

- [First setup](./setup.md#purpose)
- [Settings reference](./settings.md#audio)
- [Glossary](./glossary.md#terms)
