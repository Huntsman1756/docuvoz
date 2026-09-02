"use client";

import type { PlayerState } from "@/lib/speech-player";

interface Props {
  state: PlayerState;
  chunkIndex: number;
  chunkCount: number;
  rate: number;
  disabled: boolean;
  onPlayPause: () => void;
  onStop: () => void;
  onPrev: () => void;
  onNext: () => void;
  onSeek: (index: number) => void;
  onRate: (rate: number) => void;
}

const RATES = [0.75, 1, 1.25, 1.5, 2];

export function PlayerBar({
  state,
  chunkIndex,
  chunkCount,
  rate,
  disabled,
  onPlayPause,
  onStop,
  onPrev,
  onNext,
  onSeek,
  onRate,
}: Props) {
  const label = state === "playing" ? "⏸" : state === "loading" ? "⋯" : "▶";
  return (
    <div className="player" aria-label="player">
      <button
        type="button"
        onClick={onPrev}
        disabled={disabled}
        aria-label="previous segment"
      >
        ⏮
      </button>
      <button
        type="button"
        className="play"
        onClick={onPlayPause}
        disabled={disabled || state === "loading"}
        aria-label={state === "playing" ? "pause" : "play"}
      >
        {label}
      </button>
      <button
        type="button"
        onClick={onNext}
        disabled={disabled}
        aria-label="next segment"
      >
        ⏭
      </button>
      <button type="button" onClick={onStop} disabled={disabled} aria-label="stop">
        ⏹
      </button>
      <input
        type="range"
        min={0}
        max={Math.max(0, chunkCount - 1)}
        value={chunkIndex}
        disabled={disabled}
        onChange={(e) => onSeek(Number(e.target.value))}
        aria-label="chunk position"
      />
      <span className="chunk-info">
        chunk {Math.min(chunkIndex + 1, chunkCount)} / {chunkCount}
      </span>
      <label className="rate">
        speed
        <select
          value={rate}
          onChange={(e) => onRate(Number(e.target.value))}
          aria-label="playback speed"
        >
          {RATES.map((r) => (
            <option key={r} value={r}>
              {r}×
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
