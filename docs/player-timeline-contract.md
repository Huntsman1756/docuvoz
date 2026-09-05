# Product player timeline contract

Canonical time is seconds of decoded source audio at 1x, including configured
source-time gaps. `currentTime` is global document position; `duration` is known
per-chunk duration plus an average estimate for unknown chunks. Duration metadata
outlives decoded-buffer eviction. Estimates are not seek coordinates: chunk seeks
first learn all preceding durations.

A playback session owns play intent, rate, an AudioContext clock anchor and a
document anchor. The playhead advances by audio-clock delta times rate, capped
at the scheduled horizon during underruns. UI timers only observe this clock.
Initial/replacement sources have a 30 ms scheduling lead. If node creation
consumes that lead, the anchor follows the actual start so later sources cannot
overlap it. That lead never counts as elapsed document time.

Every scheduled source has its own record and generation, including future
sources. Scheduling never changes the audible chunk; that follows document time.
Pause snapshots the playhead, invalidates the generation and stops/disconnects
all sources. Resume schedules from that position. Seek does the same invalidation
and preserves play intent (an explicitly paused seek stays silent).
An asynchronous seek owns its destination and mutable play intent until ready.
Play during preparation updates that intent; completion cannot restore stale
pause intent. Old playhead observations cannot overwrite the pending destination.

Rate changes snapshot using the old rate before replacing sources at the new
rate. They retain blobs, decoded buffers and duration metadata. New engines
receive the player's stored rate. Stop and destroy invalidate asynchronous work;
destroy closes the owned context. Natural completion emits ended once per run.

References inspected before implementation (behavioral ideas only, no AGPL code
copied): Readest commit `dd9a8daa3f6e173d1f7dd7425e4fc71ee1c449ac`,
`WebAudioPlayer.ts`, `BufferedTTSClient.ts`, `SectionTimeline.ts`, `TTSSessionManager.ts` in
[services/tts](https://github.com/readest/readest/tree/dd9a8daa3f6e173d1f7dd7425e4fc71ee1c449ac/apps/readest-app/src/services/tts).
Readest separates queued sources from clock-derived position and invalidates
sessions; its context-suspension pause strategy differs from this player's
stop/recreate strategy. It rate-scales preprocessed media; this player uses the
native source playbackRate. The [Web Audio specification](https://www.w3.org/TR/webaudio/#AudioBufferSourceNode)
defines start times on the context clock and offsets in buffer source seconds.
