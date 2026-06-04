const SENSITIVE_QUERY_KEYS = [
  "authorization",
  "access_token",
  "token",
  "password",
  "passwd",
  "pwd",
  "secret",
  "session",
  "cookie"
];

export function sanitizeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl, location.href);
    for (const key of Array.from(url.searchParams.keys())) {
      if (SENSITIVE_QUERY_KEYS.some((sensitiveKey) => key.toLowerCase().includes(sensitiveKey))) {
        url.searchParams.set(key, "[REDACTED]");
      }
    }
    return url.toString();
  } catch {
    return rawUrl;
  }
}
