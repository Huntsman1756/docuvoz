/**
 * One-time registration of Mediabunny encoder extensions.
 *
 * Called lazily on first export so the WASM bundles are not loaded
 * during normal page load.
 */

import { canEncodeAudio } from "mediabunny";

let registered = false;

export async function ensureEncoders(): Promise<void> {
  if (registered) return;

  // MP3 encoder (LAME WASM)
  if (!(await canEncodeAudio("mp3"))) {
    const { registerMp3Encoder } = await import("@mediabunny/mp3-encoder");
    registerMp3Encoder();
  }

  // AAC encoder (FFmpeg WASM)
  if (!(await canEncodeAudio("aac"))) {
    const { registerAacEncoder } = await import("@mediabunny/aac-encoder");
    registerAacEncoder();
  }

  registered = true;
}
