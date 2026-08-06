# Deduplicate EOD latest_close warnings (A+C)

> **For agentic workers:** Load `executing-plans` or `devloop`. Checkbox 跟踪进度。

**Goal:** 去掉 A 股基本面主路径上「latest_close 非实时」刷屏警告（保留 `field_sources`）；公开页对重复警告文案折叠展示。  
**Design (chat-approved):** A = 源头降噪；C = UI 折叠。真降级（spot 失败→日线、realtime unavailable）警告保留。  
**Tech stack:** FastAPI/unittest；静态 `docs/app.js`

---

## Files touched

| File | Action | Responsibility |
|------|--------|----------------|
| `pyserver/routes/fundamental.py` | modify | 主路径不再 append stock_value_em latest_close warning |
| `pyserver/test_fundamental_warning.py` | modify | 断言无该 warning，仍有 field_sources |
| `docs/app.js` | modify | `collapseDuplicateWarnings` 用于信号/分析师/回测告警展示 |
| `docs/OPERATIONS.md` | modify | FAQ 一句：主路径用 field_sources，非 117 条警告 |

**Out of scope:** 改 analyst 在 spot 失败后的日线 fallback 警告（那是真降级）；不强上 realtime。

---

## Task 1: pyserver 源头降噪

**Depends on:** none

**Files:** `pyserver/routes/fundamental.py`, `pyserver/test_fundamental_warning.py`

- [ ] **Step 1:** 删除 `fundamental.py` 中当 `stock_value.get("latest_close") is not None` 时 append  
  `"latest_close is latest daily close from AkShare stock_value_em, not realtime"` 的分支。保留 `field_sources["latest_close"] = "akshare_stock_value_em"`。
- [ ] **Step 2:** 更新测试：有 `latest_close` 时 **不在** `warnings`；`field_sources["latest_close"] == "akshare_stock_value_em"`。无 `latest_close` 用例保持无该文案。
- [ ] **Verify:**

```bash
cd pyserver && uv run python -m unittest test_fundamental_warning -v
```

期望：PASS。Commit：`Stop warning on primary stock_value_em latest_close`

---

## Task 2: 公开页折叠重复警告

**Depends on:** none（可与 Task 1 并行；对旧 snapshot 也生效）

**Files:** `docs/app.js`

- [ ] **Step 1:** 增加 helper，将警告按「去掉 `SYMBOL NAME fundamental warning: ` / `SYMBOL: ` 前缀后的正文」分组；若 count>1，展示为 `` `${n} 只：${body}` ``，否则原样或单条 body。
- [ ] **Step 2:** `renderSnapshotAlerts` 里对 `analystWarnings`、`signalWarnings`、`backtestWarnings` 在 `firstItems` 前先 collapse；`#signals-summary` 的警告条数用 collapse 后长度（或注明「去重后」——用 collapse 后 count 即可）。
- [ ] **Verify:**

```bash
node --check docs/app.js
rg -n 'collapseDuplicate|只：' docs/app.js
```

期望：语法 OK，helper 存在。Commit：`Collapse duplicate snapshot warning lines in public UI`

---

## Task 3: FAQ 一句

**Depends on:** Task 1

**Files:** `docs/OPERATIONS.md`

- [ ] **Step 1:** 更新「信号输入警告很多条」FAQ：主路径 `latest_close` 以 `field_sources` 审计；不再逐票警告。公开页对重复文案折叠。真降级仍报警告。
- [ ] **Verify:** `rg -n 'field_sources|折叠' docs/OPERATIONS.md`
- [ ] Commit：`Clarify EOD close audit via field_sources in FAQ`

---

## Final verify

```bash
cd pyserver && uv run python -m unittest test_fundamental_warning -v
node --check docs/app.js
```

合并后下次 VPS 一键会生成无 117 条该文案的 `signals.json`；旧 JSON 靠 UI 折叠消噪。
