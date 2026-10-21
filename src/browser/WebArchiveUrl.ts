/** Internet Archive Wayback Machine snapshot identity for one archived URL. */
export interface WebArchiveSnapshot {
  /** Archive transport origin, for example `https://web.archive.org`. */
  readonly archive_origin: string;
  /** Capture timestamp as written in the snapshot path (4 to 14 digits). */
  readonly timestamp: string;
  /** Absolute HTTP(S) URL that the snapshot archived. */
  readonly original_url: string;
}

const ARCHIVE_HOSTS = new Set(["web.archive.org"]);
const SNAPSHOT_PATH = /^\/web\/(\d{4,14})(?:[a-z]{2}_)?\/(https?:\/\/.+)$/u;

/**
 * Parse a Wayback Machine snapshot URL into its archive origin, timestamp,
 * and archived original URL. Returns null for every other URL.
 */
export const parseWebArchiveUrl = (value: string): WebArchiveSnapshot | null => {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause: unknown) {
    // Non-URL input is not an archive snapshot.
    void cause;
    return null;
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !ARCHIVE_HOSTS.has(url.hostname) ||
    url.username !== "" ||
    url.password !== ""
  )
    return null;
  const match = SNAPSHOT_PATH.exec(`${url.pathname}${url.search}`);
  if (match === null) return null;
  const [, timestamp, original] = match;
  if (timestamp === undefined || original === undefined) return null;
  let originalUrl: URL;
  try {
    originalUrl = new URL(original);
  } catch (cause: unknown) {
    // A snapshot path whose archived target is not a URL is not addressable.
    void cause;
    return null;
  }
  if (originalUrl.protocol !== "http:" && originalUrl.protocol !== "https:")
    return null;
  return {
    archive_origin: url.origin,
    timestamp,
    original_url: originalUrl.href,
  };
};

/**
 * Address the unmodified archived bytes of one original URL inside a snapshot.
 * The `id_` modifier asks the archive to serve the capture without URL
 * rewriting or injected toolbars.
 */
export const webArchiveRawUrl = (
  snapshot: WebArchiveSnapshot,
  originalUrl: string,
): string =>
  `${snapshot.archive_origin}/web/${snapshot.timestamp}id_/${originalUrl}`;

/**
 * Recover the archived original URL from any snapshot URL in the same archive,
 * including redirect targets whose timestamp differs from the request.
 */
export const unwrapWebArchiveUrl = (
  value: string,
  snapshot: WebArchiveSnapshot,
): string | null => {
  const parsed = parseWebArchiveUrl(value);
  return parsed !== null && parsed.archive_origin === snapshot.archive_origin
    ? parsed.original_url
    : null;
};
