---
title: "Send audio to OBS"
description: "Receive Auralyn audio in OBS and check a recording."
order: 3
uiLabels: ["Voice Check"]
---

## Choose a connection {#connect}

Use a virtual cable, or send the device's PC return through hardware loopback. Hardware loopback requires driver and device support.

1. If no virtual cable is installed, prepare VB-CABLE as described in the existing OBS guide. A PC restart may be needed after installation.
2. Set Auralyn's output to CABLE Input.
3. Add an Audio Input Capture source in OBS and select CABLE Output as its device.
4. Check mute in OBS, then speak and watch the meter.

For hardware loopback, return Auralyn's output to the supported device and select that device's streaming feed in OBS. Device names vary.

## Listen locally {#monitor}

Audio sent to a virtual cable does not play directly through your speakers. OBS and Windows monitoring add delay. Listen before using either for singing. Check whether direct monitoring and OBS are playing the same voice twice.

## Check the final recording {#verify}

1. Make sure test audio cannot reach a stream or call.
2. Check for duplicate capture through desktop audio or another microphone.
3. Check recording tracks and mute settings.
4. Make a short recording and listen to the voice and backing-track balance.

“Voice Check” checks voice alone. It does not check the final OBS mix or recording tracks.

## Related pages {#related}

- [First setup](./setup.md#output)
- [Troubleshooting](./troubleshooting.md#not-received)
- [Adjusting sound](./sound.md#voice-check)
