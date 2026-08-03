import { timingSafeEqual } from "node:crypto";
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
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    // Constant-time-ish reject on length mismatch without throwing.
    if (ab.length > 0) timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/**
 * Gate for /api/universe/refresh. Returns an error message when the caller
 * must be refused; null when the request may proceed.
 */
export function refreshAuthError(req: NextRequest): string | null {
  const expected = configuredRefreshToken();
  if (!expected) {
    return "未配置 UNIVERSE_REFRESH_TOKEN：请在环境变量中设置刷新令牌后再调用";
  }
  const provided = extractRefreshToken(req);
  if (!provided || !safeEqual(provided, expected)) {
    return "刷新令牌无效";
  }
  return null;
}
