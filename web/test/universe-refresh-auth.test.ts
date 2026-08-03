import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import {
  extractRefreshToken,
  refreshAuthError,
} from "../lib/universe-refresh-auth";

test("extractRefreshToken prefers x-universe-refresh-token over Bearer", () => {
  const req = new NextRequest("http://test/api/universe/refresh", {
    method: "POST",
    headers: {
      "x-universe-refresh-token": "from-header",
      authorization: "Bearer from-bearer",
    },
  });
  assert.equal(extractRefreshToken(req), "from-header");
});

test("extractRefreshToken accepts Authorization Bearer", () => {
  const req = new NextRequest("http://test/api/universe/refresh", {
    method: "POST",
    headers: { authorization: "Bearer secret-token" },
  });
  assert.equal(extractRefreshToken(req), "secret-token");
});

test("refreshAuthError requires configured token and matching header", () => {
  const prev = process.env.UNIVERSE_REFRESH_TOKEN;
  try {
    delete process.env.UNIVERSE_REFRESH_TOKEN;
    assert.match(
      refreshAuthError(new NextRequest("http://test/", { method: "POST" })) ?? "",
      /未配置 UNIVERSE_REFRESH_TOKEN/,
    );

    process.env.UNIVERSE_REFRESH_TOKEN = "correct";
    assert.match(
      refreshAuthError(new NextRequest("http://test/", {
        method: "POST",
        headers: { "x-universe-refresh-token": "wrong" },
      })) ?? "",
      /刷新令牌无效/,
    );
    assert.equal(
      refreshAuthError(new NextRequest("http://test/", {
        method: "POST",
        headers: { authorization: "Bearer correct" },
      })),
      null,
    );
  } finally {
    if (prev === undefined) delete process.env.UNIVERSE_REFRESH_TOKEN;
    else process.env.UNIVERSE_REFRESH_TOKEN = prev;
  }
});
