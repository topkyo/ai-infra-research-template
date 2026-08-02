"use client";

import { useState } from "react";
import { parseHoldingsText } from "@/lib/holdingsImport";
import type { SetupRequired } from "./useSignalStream";
import { formatMoney } from "./format";

interface DraftPosition {
  symbol: string;
  shares: number;
  cost_basis: number;
}

const HOLDINGS_PASTE_SAMPLE = `证券代码\t持仓数量\t成本价
688256\t100\t120.5`;

interface HoldingsSetupProps {
  setupRequired: SetupRequired;
  loading: boolean;
  paperCash: number;
  onClearError: () => void;
  onSaved: () => Promise<void>;
  onRetryReal: () => void;
  onRunPaper: () => void;
}

export default function HoldingsSetup({
  setupRequired,
  loading,
  paperCash,
  onClearError,
  onSaved,
  onRetryReal,
  onRunPaper,
}: HoldingsSetupProps) {
  const [setupCash, setSetupCash] = useState(100000);
  const [holdingsText, setHoldingsText] = useState("");
  const [previewPositions, setPreviewPositions] = useState<DraftPosition[]>([]);
  const [setupErrors, setSetupErrors] = useState<string[]>([]);
  const [savingHoldings, setSavingHoldings] = useState(false);

  function parseSetupText(text = holdingsText) {
    const result = parseHoldingsText(text);
    setPreviewPositions(result.positions);
    setSetupErrors(result.errors);
    if (result.cash != null) setSetupCash(result.cash);
    return result;
  }

  async function saveHoldingsAndRun() {
    const parsed = previewPositions.length > 0 && setupErrors.length === 0
      ? { positions: previewPositions, errors: setupErrors, cash: undefined }
      : parseSetupText();
    if (parsed.errors.length > 0 || parsed.positions.length === 0) return;
    const cash = parsed.cash ?? setupCash;
    setSavingHoldings(true);
    onClearError();
    try {
      const response = await fetch("/api/holdings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cash,
          positions: parsed.positions,
        }),
      });
      const payload = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
      if (!response.ok || payload.ok !== true) {
        throw new Error(payload.error ?? `HTTP ${response.status}`);
      }
      await onSaved();
    } catch (e) {
      setSetupErrors([e instanceof Error ? e.message : String(e)]);
    } finally {
      setSavingHoldings(false);
    }
  }

  return (
    <div className="card setup-card">
      <div className="setup-copy">
        <strong>配置真实持仓</strong>
        <p>{setupRequired.message}</p>
      </div>
      <div className="setup-form-grid">
        <label className="field">
          <span>可用现金</span>
          <input
            type="number"
            min={0}
            step={1000}
            value={setupCash}
            onChange={(e) => setSetupCash(Math.max(0, Number(e.target.value) || 0))}
            disabled={loading || savingHoldings}
          />
        </label>
        <label className="field setup-paste-field">
          <span>粘贴持仓明细</span>
          <textarea
            value={holdingsText}
            placeholder={HOLDINGS_PASTE_SAMPLE}
            onChange={(e) => {
              setHoldingsText(e.target.value);
              setPreviewPositions([]);
              setSetupErrors([]);
            }}
            disabled={loading || savingHoldings}
            spellCheck={false}
          />
        </label>
      </div>
      {setupErrors.length > 0 && (
        <div className="setup-errors">
          {setupErrors.map((message) => (
            <div key={message}>{message}</div>
          ))}
        </div>
      )}
      {previewPositions.length > 0 && (
        <div className="setup-preview">
          <div className="theme-title">
            <strong>导入预览</strong>
            <span>{previewPositions.length} 只 · 现金 {formatMoney(setupCash)}</span>
          </div>
          <div className="table-wrap compact-table">
            <table>
              <thead>
                <tr>
                  <th>代码</th>
                  <th className="num">持仓数量</th>
                  <th className="num">成本价</th>
                </tr>
              </thead>
              <tbody>
                {previewPositions.map((position) => (
                  <tr key={position.symbol}>
                    <td className="mono">{position.symbol}</td>
                    <td className="num">{formatMoney(position.shares)}</td>
                    <td className="num">{position.cost_basis.toFixed(3).replace(/\.?0+$/, "")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <div className="setup-actions">
        <button type="button" onClick={() => parseSetupText()} disabled={loading || savingHoldings}>
          解析预览
        </button>
        <button
          type="button"
          onClick={saveHoldingsAndRun}
          disabled={loading || savingHoldings || previewPositions.length === 0 || setupErrors.length > 0}
        >
          {savingHoldings ? "保存中…" : "保存并运行"}
        </button>
        <button type="button" className="secondary" onClick={onRetryReal} disabled={loading}>
          重新检测真实持仓
        </button>
        <button type="button" className="secondary" onClick={onRunPaper} disabled={loading || savingHoldings}>
          用 {formatMoney(paperCash)} 模拟运行
        </button>
      </div>
      <div className="setup-details">
        <div className="setup-path">路径 <code>{setupRequired.filePath}</code></div>
      </div>
    </div>
  );
}
