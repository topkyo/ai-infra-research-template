#!/usr/bin/env bash
# Priority-1 connectivity checks for market data (run on the Mac host).
set -euo pipefail

echo "== proxy env =="
env | grep -i proxy || echo "(none)"

echo ""
echo "== local proxy port 7890 =="
nc -z 127.0.0.1 7890 2>/dev/null && echo "open (VPN likely on)" || echo "closed — start Clash/V2Ray or unset shell proxy"

echo ""
echo "== Eastmoney realtime (push2) — pyserver uses DIRECT (ignores shell proxy) =="
EM_URL='https://push2.eastmoney.com/api/qt/stock/get?fltt=2&invt=2&fields=f43,f58&secid=1.688256'
code_direct=$(/usr/bin/env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u all_proxy \
  curl -sS -o /tmp/em-direct.json -w "%{http_code}" --max-time 8 "${EM_URL}" 2>/dev/null) || code_direct="err"
echo "direct (no shell proxy): HTTP ${code_direct} $(head -c 120 /tmp/em-direct.json 2>/dev/null)"
if nc -z 127.0.0.1 7890 2>/dev/null; then
  code_via_proxy=$(curl -sS -o /tmp/em-proxy.json -w "%{http_code}" --max-time 8 -x http://127.0.0.1:7890 \
    "${EM_URL}" 2>/dev/null) || code_via_proxy="err"
  echo "via 127.0.0.1:7890 (optional MARKET_HTTP_PROXY path): HTTP ${code_via_proxy} $(head -c 120 /tmp/em-proxy.json 2>/dev/null)"
else
  echo "via 127.0.0.1:7890: skipped (port closed)"
fi
if [[ "${code_direct}" == "200" ]] && grep -q '"data"' /tmp/em-direct.json 2>/dev/null; then
  echo "push2: OK (matches pyserver default — keep MARKET_HTTP_PROXY unset)"
else
  echo "push2: FAIL — fix network/Clash (DIRECT for .eastmoney.com) before expecting realtime quotes"
fi

echo ""
echo "== Sina realtime (hq.sinajs.cn) — pyserver fallback when push2 fails =="
SINA_URL="https://hq.sinajs.cn/list=sh688256"
sina_direct=$(/usr/bin/env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY -u all_proxy \
  curl -sS -o /tmp/sina-direct.txt -w "%{http_code}" --max-time 8 \
  -H "Referer: https://finance.sina.com.cn/" "${SINA_URL}" 2>/dev/null) || sina_direct="err"
echo "direct: HTTP ${sina_direct} $(head -c 120 /tmp/sina-direct.txt 2>/dev/null)"
if [[ "${sina_direct}" == "200" ]] && grep -q 'hq_str_' /tmp/sina-direct.txt 2>/dev/null; then
  echo "sina: OK (pyserver can use sina-hq-realtime when push2 is down)"
else
  echo "sina: FAIL — pyserver will fall back to stock_value_em daily close + not-realtime warning"
fi

echo ""
echo "== pyserver health =="
curl -sf --max-time 5 http://127.0.0.1:8001/health | python3 -m json.tool 2>/dev/null || echo "pyserver down"

echo ""
echo "== AkShare hist (via uv) =="
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
UV="${UV:-$(command -v uv 2>/dev/null || echo "${HOME}/.local/bin/uv")}"
cd "${REPO_ROOT}/pyserver"
"${UV}" run python -c "
from main import _ak_a_spot_from_hist, _ak_a_hist_df, _to_ts_code
for sym in ['688256', '600519']:
    ts, m = _to_ts_code(sym)
    df = _ak_a_hist_df(ts.split('.')[0], '20250501', '20250526', 'qfq')
    sp = _ak_a_spot_from_hist(ts, m, sym)
    print(sym, 'hist', len(df) if df is not None else None, 'spot', sp.get('price') if sp else None)
"

echo ""
echo "== spot API =="
for sym in 688256 600519; do
  echo -n "$sym: "
  curl -sf --max-time 20 "http://127.0.0.1:8001/spot?symbol=$sym" | head -c 100 || echo FAIL
  echo
done
