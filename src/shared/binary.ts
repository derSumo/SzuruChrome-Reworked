// ── Binary <-> base64 bridging ────────────────────────────────────────
// Extension message passing JSON-serialises its payload, which destroys
// ArrayBuffer/Blob instances. Media fetched in the page context is therefore
// base64-encoded on the way out of the content script and decoded again on the
// receiving side.

/** Chunked so a large file can't blow the argument limit of `String.fromCharCode`. */
const ENCODE_CHUNK_SIZE = 0x8000;

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += ENCODE_CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(i, i + ENCODE_CHUNK_SIZE));
  }
  return btoa(binary);
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  // Allocate the ArrayBuffer up front and write through a view, so the result
  // is a plain (never shared) buffer that can be handed straight to `Blob`.
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return buffer;
}

/**
 * A CDN that rejects a request often answers 200 with a tiny HTML error page.
 * Anything this small is never real media.
 */
export const MIN_PLAUSIBLE_MEDIA_BYTES = 64;

export function isPlausibleMediaSize(byteLength: number): boolean {
  return byteLength >= MIN_PLAUSIBLE_MEDIA_BYTES;
}
