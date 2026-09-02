/** Corpus manifest: legal-safe fixtures shipped with the repository. */

export interface CorpusEntry {
  id: string;
  title: string;
  category: string;
  description: string;
  pdf: string;
  /** Reference (desktop-parser-shaped) JSON export, if available. */
  reference?: string;
  /** Manually authored spoken text (experimental upper bound, G3a). */
  gold?: string;
  synthetic: boolean;
}

export interface CorpusManifest {
  version: number;
  notice: string;
  entries: CorpusEntry[];
}

export async function loadManifest(): Promise<CorpusManifest> {
  const res = await fetch("/corpus/manifest.json");
  if (!res.ok) throw new Error("corpus manifest unavailable");
  return (await res.json()) as CorpusManifest;
}

export interface GoldEntryFile {
  entries: { blockId: string; spokenText: string }[];
}

export async function loadGold(url: string): Promise<GoldEntryFile["entries"]> {
  const res = await fetch(url);
  if (!res.ok) throw new Error("gold file unavailable");
  const file = (await res.json()) as GoldEntryFile;
  return file.entries;
}

export async function loadReference(
  url: string,
): Promise<import("@/domain/documents/types").StructuredDocument> {
  const res = await fetch(url);
  if (!res.ok) throw new Error("reference document unavailable");
  return (await res.json()) as import("@/domain/documents/types").StructuredDocument;
}
