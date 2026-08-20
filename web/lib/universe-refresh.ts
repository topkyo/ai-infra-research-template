// DeepSeek-driven universe refresh.
//
// Asks the model to act as a sector curator: given the current watchlist
// and the investment thesis, propose ADDS / REMOVES / RECLASSIFIES.
// Every proposed symbol is validated against pyserver before being written
// (DeepSeek will otherwise hallucinate codes that don't trade).
import { chat } from "./deepseek";
import { loadThesisNarrative } from "./load-thesis";
import { fetchFundamental } from "./pyserver";
import type { UniverseEntry, UniverseFile } from "./universe";
import { readUniverse, writeUniverse } from "./universe";

export interface RefreshProposal {
  adds: UniverseEntry[];
  removes: string[];                       // symbols to drop
  reclassifies: { symbol: string; theme: string }[];
  rationale: string;
}

export interface RefreshResult {
  proposal: RefreshProposal;
  applied: {
    added: UniverseEntry[];
    rejected: { symbol: string; reason: string }[];
    removed: string[];
    reclassified: { symbol: string; from: string; to: string }[];
  };
  finalCount: number;
}

const CURATOR_TASK = `任务：审阅当前股票池，发现遗漏的子主题与未覆盖的龙头，识别需要剔除的标的或重新分类的标的。

要求：
- 添加项必须是 A 股真实上市公司，给出 6 位股票代码、中文简称、所属子主题、一句话说明。
- 不要添加港股、美股或任何 hk 前缀代码。
- 每个添加项必须标注 global_supply (布尔)：是否进入全球 AI 供应链（向 NVIDIA / AMD / Apple / Google /
  Microsoft / TSMC / 三星 / 海力士 / 全球 IDM 大批量供货）。纯内销标 false。
- 优先补齐"龙头缺失"的子主题，举例：之前漏了 胜宏科技 (300476) 在 AI-PCB、工业富联 (601138) 在 AI 服务器、
  整条 AIDC 功率半导体链 (IGBT/SiC/MOSFET)。
- 不要包含 ST、暂停上市、纯人类消费品（白酒/食品/服饰）。
- 子主题命名沿用当前列表（算力/AI芯片、光模块、AI服务器、液冷、电力、IDC、功率半导体、存储/HBM、半导体设备、半导体材料、AI-PCB、晶圆代工、云/AI基建）。

严格输出 JSON：
{
  "adds": [{"symbol":"...","name":"...","theme":"...","note":"...","global_supply":true|false}, ...],
  "removes": ["symbol", ...],
  "reclassifies": [{"symbol":"...","theme":"新主题"}, ...],
  "rationale": "中文,<=200字,总结主要变更与逻辑"
}
不要输出其他文本。`;

export function curatorSystem(): string {
  return `你是中国 A 股主题股票池研究员。

主题：
${loadThesisNarrative()}

${CURATOR_TASK}`;
}

function envPositiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Runtime shape check for LLM JSON — rejects malformed proposals before apply. */
export function validateRefreshProposal(value: unknown): RefreshProposal {
  if (!isRecord(value)) {
    throw new Error("universe refresh proposal must be a JSON object");
  }

  const adds: UniverseEntry[] = [];
  if (value.adds !== undefined) {
    if (!Array.isArray(value.adds)) {
      throw new Error("universe refresh proposal adds must be an array");
    }
    for (let i = 0; i < value.adds.length; i++) {
      const item = value.adds[i];
      if (!isRecord(item)) {
        throw new Error(`universe refresh proposal adds[${i}] must be an object`);
      }
      const symbol = typeof item.symbol === "string" ? item.symbol.trim() : "";
      const name = typeof item.name === "string" ? item.name.trim() : "";
      const theme = typeof item.theme === "string" ? item.theme.trim() : "";
      if (!symbol) {
        throw new Error(`universe refresh proposal adds[${i}].symbol must be a non-empty string`);
      }
      if (!name) {
        throw new Error(`universe refresh proposal adds[${i}].name must be a non-empty string`);
      }
      if (!theme) {
        throw new Error(`universe refresh proposal adds[${i}].theme must be a non-empty string`);
      }
      const entry: UniverseEntry = { symbol, name, theme };
      if (item.note !== undefined) {
        if (typeof item.note !== "string") {
          throw new Error(`universe refresh proposal adds[${i}].note must be a string`);
        }
        entry.note = item.note;
      }
      if (item.global_supply !== undefined) {
        if (typeof item.global_supply !== "boolean") {
          throw new Error(`universe refresh proposal adds[${i}].global_supply must be a boolean`);
        }
        entry.global_supply = item.global_supply;
      }
      adds.push(entry);
    }
  }

  const removes: string[] = [];
  if (value.removes !== undefined) {
    if (!Array.isArray(value.removes)) {
      throw new Error("universe refresh proposal removes must be an array");
    }
    for (let i = 0; i < value.removes.length; i++) {
      const item = value.removes[i];
      if (typeof item !== "string") {
        throw new Error(`universe refresh proposal removes[${i}] must be a string`);
      }
      removes.push(item);
    }
  }

  const reclassifies: { symbol: string; theme: string }[] = [];
  if (value.reclassifies !== undefined) {
    if (!Array.isArray(value.reclassifies)) {
      throw new Error("universe refresh proposal reclassifies must be an array");
    }
    for (let i = 0; i < value.reclassifies.length; i++) {
      const item = value.reclassifies[i];
      if (!isRecord(item)) {
        throw new Error(`universe refresh proposal reclassifies[${i}] must be an object`);
      }
      const symbol = typeof item.symbol === "string" ? item.symbol.trim() : "";
      const theme = typeof item.theme === "string" ? item.theme.trim() : "";
      if (!symbol) {
        throw new Error(`universe refresh proposal reclassifies[${i}].symbol must be a non-empty string`);
      }
      if (!theme) {
        throw new Error(`universe refresh proposal reclassifies[${i}].theme must be a non-empty string`);
      }
      reclassifies.push({ symbol, theme });
    }
  }

  let rationale = "";
  if (value.rationale !== undefined) {
    if (typeof value.rationale !== "string") {
      throw new Error("universe refresh proposal rationale must be a string");
    }
    rationale = value.rationale;
  }

  return { adds, removes, reclassifies, rationale };
}

export async function proposeRefresh(
  current: UniverseFile,
): Promise<RefreshProposal> {
  const userPayload = {
    current_entries: current.entries.map((e) => ({
      symbol: e.symbol,
      name: e.name,
      theme: e.theme,
    })),
    distinct_themes: [...new Set(current.entries.map((e) => e.theme))],
  };
  const timeoutMs = envPositiveInt("UNIVERSE_REFRESH_LLM_TIMEOUT_MS", 900_000);
  const raw = await chat(
    [
      { role: "system", content: curatorSystem() },
      { role: "user", content: JSON.stringify(userPayload) },
    ],
    { responseFormat: "json_object", temperature: 0.3, bypassCache: true, timeoutMs },
  );
  const parsed: unknown = JSON.parse(raw);
  return validateRefreshProposal(parsed);
}

/** Validate a symbol by calling pyserver /fundamental. Returns true if pyserver
 *  knows it (200) regardless of whether all fields populated. */
function isHongKongSymbol(symbol: string): boolean {
  return symbol.trim().toLowerCase().startsWith("hk");
}

async function validateSymbol(symbol: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    const timeoutMs = envPositiveInt("UNIVERSE_REFRESH_VALIDATE_TIMEOUT_MS", 20_000);
    const f = await fetchFundamental(symbol, timeoutMs);
    // Even if fields are null, pyserver returned 200 -> symbol parses + tushare didn't 502.
    if (!f) return { ok: false, reason: "pyserver returned empty" };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export async function applyRefresh(
  current: UniverseFile,
  proposal: RefreshProposal,
  opts: { onValidate?: (symbol: string, ok: boolean) => void } = {},
): Promise<RefreshResult> {
  const known = new Map(current.entries.map((e) => [e.symbol, e]));

  // 1. Validate adds in parallel (bounded).
  const added: UniverseEntry[] = [];
  const rejected: { symbol: string; reason: string }[] = [];
  const ADD_CONCURRENCY = 6;
  const hkAdds = proposal.adds.filter((a) => a.symbol && !known.has(a.symbol) && isHongKongSymbol(a.symbol));
  rejected.push(...hkAdds.map((a) => ({ symbol: a.symbol, reason: "Hong Kong stocks are excluded from the universe" })));

  const candidates = proposal.adds.filter((a) => a.symbol && !known.has(a.symbol) && !isHongKongSymbol(a.symbol));
  for (let i = 0; i < candidates.length; i += ADD_CONCURRENCY) {
    const slice = candidates.slice(i, i + ADD_CONCURRENCY);
    const results = await Promise.all(
      slice.map(async (a) => {
        const v = await validateSymbol(a.symbol);
        opts.onValidate?.(a.symbol, v.ok);
        return { add: a, v };
      }),
    );
    for (const { add, v } of results) {
      if (v.ok) added.push(add);
      else rejected.push({ symbol: add.symbol, reason: v.reason ?? "unknown" });
    }
  }

  // 2. Apply removes (only if currently present).
  const removeSet = new Set(proposal.removes.filter((s) => known.has(s)));

  // 3. Apply reclassifies.
  const reclassMap = new Map(
    proposal.reclassifies
      .filter((r) => known.has(r.symbol) && !removeSet.has(r.symbol))
      .map((r) => [r.symbol, r.theme]),
  );
  const reclassified: { symbol: string; from: string; to: string }[] = [];

  const newEntries: UniverseEntry[] = [];
  for (const e of current.entries) {
    if (removeSet.has(e.symbol)) continue;
    const newTheme = reclassMap.get(e.symbol);
    if (newTheme && newTheme !== e.theme) {
      reclassified.push({ symbol: e.symbol, from: e.theme, to: newTheme });
      newEntries.push({ ...e, theme: newTheme });
    } else {
      newEntries.push(e);
    }
  }
  newEntries.push(...added);

  const changed = added.length > 0 || removeSet.size > 0 || reclassified.length > 0;
  if (changed) {
    const next: UniverseFile = {
      ...current,
      updated_at: new Date().toISOString().slice(0, 10),
      updated_by: "deepseek-refresh",
      entries: newEntries,
    };
    writeUniverse(next);
  }

  return {
    proposal,
    applied: { added, rejected, removed: [...removeSet], reclassified },
    finalCount: newEntries.length,
  };
}

export async function refreshUniverse(
  opts: { onValidate?: (symbol: string, ok: boolean) => void } = {},
): Promise<RefreshResult> {
  const current = readUniverse();
  const proposal = await proposeRefresh(current);
  return applyRefresh(current, proposal, opts);
}
