"""Input validation whitelist for client-supplied symbols and dates.

Extracted from main.py. Pure functions plus their constants; no I/O, no env.
Raises HTTPException(400) so cache keys and upstream calls only ever see
known-good input shapes.
"""
from __future__ import annotations

import re
from datetime import date, datetime, timedelta

from fastapi import HTTPException

# Accepted symbol shapes (case-insensitive), mirroring the README 符号规则 table:
#   sh600519 / sz000858 / bj830799, hk00700, bare 600519 (6 digits),
#   bare 00700 (HK 5 digits), 600519.SH / 000858.SZ / 830799.BJ / 00700.HK.
_SYMBOL_RE = re.compile(
    r"(?:"
    r"(?:sh|sz|bj)\d{6}"  # prefixed A-share
    r"|hk\d{5}"  # prefixed HK
    r"|\d{6}"  # bare A-share
    r"|\d{5}"  # bare HK
    r"|\d{6}\.(?:sh|sz|bj)"  # ts-code A-share
    r"|\d{5}\.hk"  # ts-code HK
    r")",
    re.IGNORECASE,
)
# Longest valid symbol is "600519.SH" (9 chars); cap well above that so cache
# keys can never be injected with overlong strings.
_SYMBOL_MAX_LEN = 12

_DATE_MIN = date(1990, 1, 1)
_DATE_RANGE_MAX_DAYS = 3650


def _validate_symbol(symbol: str) -> str:
    """Whitelist-check a client symbol; return the stripped value.

    Raises HTTPException(400) for empty, overlong, or non-conforming input so
    cache keys and upstream calls only ever see known symbol shapes.
    """
    s = (symbol or "").strip()
    if not s:
        raise HTTPException(400, "invalid symbol: empty")
    if len(s) > _SYMBOL_MAX_LEN:
        raise HTTPException(400, f"invalid symbol: longer than {_SYMBOL_MAX_LEN} chars")
    if not _SYMBOL_RE.fullmatch(s):
        raise HTTPException(400, f"invalid symbol format: {s[:32]!r}")
    return s


def _validate_date(s: str, name: str) -> str:
    """Validate a client date as YYYYMMDD or YYYY-MM-DD; return compact YYYYMMDD.

    Must be a real calendar date within [1990-01-01, tomorrow].
    Raises HTTPException(400) otherwise.
    """
    raw = (s or "").strip()
    if re.fullmatch(r"\d{8}", raw):
        compact = raw
    elif re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw):
        compact = raw.replace("-", "")
    else:
        raise HTTPException(400, f"invalid {name}: expected YYYYMMDD or YYYY-MM-DD")
    try:
        d = datetime.strptime(compact, "%Y%m%d").date()
    except ValueError:
        raise HTTPException(400, f"invalid {name}: not a real calendar date")
    if d < _DATE_MIN:
        raise HTTPException(400, f"invalid {name}: before {_DATE_MIN.isoformat()}")
    if d > date.today() + timedelta(days=1):
        raise HTTPException(400, f"invalid {name}: too far in the future")
    return compact


def _validate_date_range(start: str, end: str) -> None:
    """Ensure start <= end and the inclusive window is at most 10 years.

    Both arguments must already be normalized YYYYMMDD strings from
    ``_validate_date``. Raises HTTPException(400) otherwise.
    """
    start_d = datetime.strptime(start, "%Y%m%d").date()
    end_d = datetime.strptime(end, "%Y%m%d").date()
    if start_d > end_d:
        raise HTTPException(400, "invalid date range: start must be on or before end")
    if (end_d - start_d).days > _DATE_RANGE_MAX_DAYS:
        raise HTTPException(400, "date range exceeds 10-year maximum")
