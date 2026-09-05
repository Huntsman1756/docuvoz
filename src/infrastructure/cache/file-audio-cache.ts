import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { SpeechResult } from "@/domain/speech/types";

/**
 * Filesystem audio cache. Keys are content hashes, so entries are immutable.
 * Sharded by key prefix to keep filesystems happy with many entries.
 */
export class FileAudioCache {
  constructor(
    private readonly dir: string,
    private readonly maxBytes: number = 512 * 1024 * 1024,
  ) {}

  private shardDir(key: string): string {
    return join(this.dir, key.slice(0, 2));
  }

  private pathFor(key: string): string {
    return join(this.shardDir(key), `${key}.audio`);
  }

  get(key: string): SpeechResult | null {
    const path = this.pathFor(key);
    const metaPath = `${path}.meta.json`;
    if (!existsSync(path) || !existsSync(metaPath)) return null;
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf8")) as {
        mimeType: string;
        boundaries?: import("@/domain/speech/types").WordBoundary[];
      };
      return {
        audio: new Uint8Array(readFileSync(path)),
        mimeType: meta.mimeType,
        boundaries: meta.boundaries,
      };
    } catch {
      return null;
    }
  }

  set(key: string, result: SpeechResult): void {
    try {
      mkdirSync(this.shardDir(key), { recursive: true });
      writeFileSync(this.pathFor(key), result.audio);
      writeFileSync(
        `${this.pathFor(key)}.meta.json`,
        JSON.stringify({
          mimeType: result.mimeType,
          boundaries: result.boundaries,
        }),
      );
      this.enforceLimit();
    } catch {
      // Cache write failure must NOT turn a successful synthesis into a
      // user-visible error. The caller (speech-handler) also catches this,
      // but we guard here too for defense in depth. Disk full, permission
      // errors, etc. are non-fatal for the synthesis path.
    }
  }

  clear(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }

  private enforceLimit(): void {
    let total = 0;
    const files: { path: string; size: number; mtimeMs: number }[] = [];
    let entries: string[];
    try {
      entries = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const shard of entries) {
      const shardPath = join(this.dir, shard);
      let names: string[];
      try {
        names = readdirSync(shardPath);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith(".audio")) continue;
        const full = join(shardPath, name);
        const stat = statSync(full);
        total += stat.size;
        files.push({ path: full, size: stat.size, mtimeMs: stat.mtimeMs });
      }
    }
    if (total <= this.maxBytes) return;
    files.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const file of files) {
      if (total <= this.maxBytes) break;
      total -= file.size;
      unlinkSync(file.path);
      rmSync(`${file.path}.meta.json`, { force: true });
    }
  }
}
