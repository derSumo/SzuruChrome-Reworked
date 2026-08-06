import { describe, expect, it } from "vitest";
import {
  GENERIC_MIME,
  guessFilenameFromUrl,
  guessMimeTypeFromUrl,
  isBetterContent,
  isSupportedMediaType,
  measureImageSize,
} from "~/shared/media";
import { arrayBufferToBase64, base64ToArrayBuffer, isPlausibleMediaSize } from "~/shared/binary";

describe("guessMimeTypeFromUrl", () => {
  it("trusts a specific type the server reported", () => {
    expect(guessMimeTypeFromUrl("https://cdn.example.com/a.png", "image/webp")).toBe("image/webp");
  });

  it("falls back to the extension when the server was generic", () => {
    expect(guessMimeTypeFromUrl("https://cdn.example.com/a.png", GENERIC_MIME)).toBe("image/png");
    expect(guessMimeTypeFromUrl("https://cdn.example.com/clip.webm")).toBe("video/webm");
  });

  it("ignores a query string when reading the extension", () => {
    expect(guessMimeTypeFromUrl("https://cdn.example.com/a.jpg?token=1")).toBe("image/jpeg");
  });

  it("keeps the generic type for an unknown extension", () => {
    expect(guessMimeTypeFromUrl("https://cdn.example.com/a.xyz")).toBe(GENERIC_MIME);
  });
});

describe("guessFilenameFromUrl", () => {
  it("prefers the URL's own filename", () => {
    expect(guessFilenameFromUrl("https://cdn.example.com/dir/pic.jpeg", "image/png")).toBe("pic.jpeg");
  });

  it("synthesises a name carrying the right extension when the URL has none", () => {
    expect(guessFilenameFromUrl("https://cdn.example.com/download", "image/png")).toBe("file.png");
  });

  it("falls back to a neutral name for an unknown type", () => {
    expect(guessFilenameFromUrl("https://cdn.example.com/download")).toBe("file.bin");
  });
});

describe("isSupportedMediaType", () => {
  it("accepts images and videos", () => {
    expect(isSupportedMediaType("image/avif")).toBe(true);
    expect(isSupportedMediaType("video/mp4")).toBe(true);
    expect(isSupportedMediaType("application/x-shockwave-flash")).toBe(true);
  });

  it("rejects the HTML error pages CDNs return instead of media", () => {
    expect(isSupportedMediaType("text/html")).toBe(false);
    expect(isSupportedMediaType(GENERIC_MIME)).toBe(false);
  });
});

describe("base64 bridging", () => {
  it("round-trips binary data unchanged", () => {
    const original = new Uint8Array(1000);
    for (let i = 0; i < original.length; i++) original[i] = (i * 7) % 256;

    const restored = new Uint8Array(base64ToArrayBuffer(arrayBufferToBase64(original.buffer)));
    expect(restored).toEqual(original);
  });

  it("handles payloads larger than one encode chunk", () => {
    // 0x8000 is the chunk size; cross it to catch an off-by-one in the loop.
    const original = new Uint8Array(0x8000 * 2 + 17).fill(0xab);
    const restored = new Uint8Array(base64ToArrayBuffer(arrayBufferToBase64(original.buffer)));
    expect(restored.length).toBe(original.length);
    expect(restored).toEqual(original);
  });

  it("treats a tiny payload as implausible media", () => {
    expect(isPlausibleMediaSize(10)).toBe(false);
    expect(isPlausibleMediaSize(64)).toBe(true);
  });
});

describe("isBetterContent", () => {
  const existing = { width: 850, height: 1200, fileSize: 400_000 };

  it("prefers the higher resolution, even at a smaller file size", () => {
    // The case that used to fail: a proper original in a well-compressed
    // format losing to the stored sample just because it weighed less.
    expect(isBetterContent(existing, { width: 2000, height: 2824, fileSize: 300_000 })).toBe(true);
  });

  it("keeps the existing file when the incoming one is smaller", () => {
    expect(isBetterContent(existing, { width: 425, height: 600, fileSize: 900_000 })).toBe(false);
  });

  it("falls back to file size when a resolution is missing on either side", () => {
    // Most scrapers never report a resolution — an unknown size must not
    // automatically lose, or nothing would ever be upgraded.
    expect(isBetterContent(existing, { fileSize: 900_000 })).toBe(true);
    expect(isBetterContent(existing, { fileSize: 100_000 })).toBe(false);
    expect(isBetterContent({ fileSize: 400_000 }, { width: 2000, height: 2824, fileSize: 900_000 })).toBe(true);
  });

  it("breaks a resolution tie with the file size", () => {
    expect(isBetterContent(existing, { width: 850, height: 1200, fileSize: 900_000 })).toBe(true);
    expect(isBetterContent(existing, { width: 850, height: 1200, fileSize: 400_000 })).toBe(false);
  });

  it("knows nothing means no replacement", () => {
    expect(isBetterContent(existing, {})).toBe(false);
  });
});

describe("measureImageSize", () => {
  it("does not try to decode something that isn't an image", async () => {
    expect(await measureImageSize(new Blob([new Uint8Array(64)], { type: "video/webm" }))).toBeUndefined();
  });

  it("returns undefined instead of throwing on undecodable bytes", async () => {
    expect(await measureImageSize(new Blob([new Uint8Array(64)], { type: "image/png" }))).toBeUndefined();
  });
});
