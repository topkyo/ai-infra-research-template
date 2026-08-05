/** Client-safe constant — do not import server modules here. */
export const BACKTEST_FUNDAMENTAL_EXCLUSION_WARNING =
  "回测打分仅使用截至调仓日的价格动量与主题标签；静态 PE/PB/利润增速等基本面未纳入（无 point-in-time 历史基本面，避免 look-ahead）。" +
  " Backtest scoring uses price momentum and theme only; static fundamentals (PE/PB/profit_yoy) are excluded to avoid look-ahead bias.";
