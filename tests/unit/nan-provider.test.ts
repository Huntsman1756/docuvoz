import { describe, expect, it } from "vitest";
import { NanSpeechProvider } from "@/adapters/speech-providers/nan-provider";
import { SpeechError } from "@/domain/speech/types";

const settings = {
  provider: "nan",
  model: "kokoro",
  voice: "ef_dora",
  speed: 1,
  format: "mp3",
};

function providerFor(fetchImpl: typeof fetch) {
  return new NanSpeechProvider({
    baseUrl: "https://nan.example/v1",
    apiKey: "secret-key-do-not-log",
    timeoutMs: 5000,
    fetchFn: fetchImpl,
  });
}

describe("NanSpeechProvider", () => {
  it("calls the OpenAI-compatible speech endpoint", async () => {
    const fetchMock = (async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://nan.example/v1/audio/speech");
      const headers = init?.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer secret-key-do-not-log");
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        model: "kokoro",
        input: "hola",
        voice: "ef_dora",
        speed: 1,
        response_format: "mp3",
      });
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = providerFor(fetchMock);
    const result = await provider.synthesize({ text: "hola", settings });
    expect(result.mimeType).toBe("audio/mpeg");
    expect(result.audio).toHaveLength(3);
  });

  it("maps 429 to a retryable rate_limited error without leaking provider body", async () => {
    const fetchMock = (async () =>
      new Response("sensitive upstream error text", {
        status: 429,
      })) as unknown as typeof fetch;
    const provider = providerFor(fetchMock);
    const error = await provider
      .synthesize({ text: "hola", settings })
      .catch((e: unknown) => e as SpeechError);
    expect(error).toBeInstanceOf(SpeechError);
    const speechError = error as SpeechError;
    expect(speechError.code).toBe("rate_limited");
    expect(speechError.retryable).toBe(true);
    expect(speechError.message).not.toContain("sensitive");
    expect(speechError.message).not.toContain("secret");
  });

  it("maps network failures to provider_unavailable (retryable)", async () => {
    const fetchMock = (async () => {
      throw new Error("socket hang up");
    }) as unknown as typeof fetch;
    const provider = providerFor(fetchMock);
    const error = (await provider
      .synthesize({ text: "hola", settings })
      .catch((e: unknown) => e)) as SpeechError;
    expect(error.code).toBe("provider_unavailable");
    expect(error.retryable).toBe(true);
  });

  it("treats empty audio as a provider error", async () => {
    const fetchMock = (async () =>
      new Response(new Uint8Array(0), { status: 200 })) as unknown as typeof fetch;
    const provider = providerFor(fetchMock);
    const error = (await provider
      .synthesize({ text: "hola", settings })
      .catch((e: unknown) => e)) as SpeechError;
    expect(error.code).toBe("provider_error");
  });
});
