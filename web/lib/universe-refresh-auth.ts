import { createHash, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

/** Env var holding the shared secret for POST /api/universe/refresh. */
export const UNIVERSE_REFRESH_TOKEN_ENV = "UNIVERSE_REFRESH_TOKEN";

export function configuredRefreshToken(): string {
  return (process.env[UNIVERSE_REFRESH_TOKEN_ENV] ?? "").trim();
}

export function extractRefreshToken(req: NextRequest): string {
  const header = req.headers.get("x-universe-refresh-token")?.trim();
  if (header) return header;
  const auth = req.headers.get("authorization")?.trim() ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m?.[1]?.trim() ?? "";
}

function safeEqual(a: string, b: string): boolean {
  // Hash both inputs to fixed-length digests before constant-time comparison.
  // This eliminates the timing side-channel from length-mismatch early
  // returns: both hashes are always 32 bytes, so timingSafeEqual never
  // short-circuits on different lengths.
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Well-known placeholders that must never be accepted as production secrets. */
const WEAK_REFRESH_TOKENS = new Set([
  "change-me-universe-refresh-token",
  "changeme",
  "change-me",
  "password",
  "secret",
  "token",
  "replace-me",
  "your-token-here",
  "placeholder",
  "dummy",
  "xxx",
  "test",
  "todo",
  "unset",
]);

export function refreshTokenConfigError(token: string): string | null {
  if (!token) {
    return "未配置 UNIVERSE_REFRESH_TOKEN：请在环境变量中设置刷新令牌后再调用";
  }
  if (token.length < 16 || WEAK_REFRESH_TOKENS.has(token.toLowerCase())) {
    return "UNIVERSE_REFRESH_TOKEN 过弱或仍为示例值：请设置至少 16 位随机令牌";
  }
  return null;
}

/**
 * Gate for /api/universe/refresh. Returns an error message when the caller
 * must be refused; null when the request may proceed. Returns a unified
 * "刷新令牌无效" for both config errors and wrong tokens to avoid leaking
 * whether the server has a configured secret; the specific config error is
 * logged server-side via console.error.
 */
export function refreshAuthError(req: NextRequest): string | null {
  const expected = configuredRefreshToken();
  const configError = refreshTokenConfigError(expected);
  if (configError) {
    console.error(`[universe-refresh] ${configError}`);
    return "刷新令牌无效";
  }
  const provided = extractRefreshToken(req);
  if (!provided || !safeEqual(provided, expected)) {
    return "刷新令牌无效";
  }
  return null;
}
