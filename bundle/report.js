// report.js — pure report-building logic for Token Risk Report.
//
// No host/DOM dependencies: this module is imported by app.js in the
// browser and by the local verification script in Node, unchanged.
//
// Two synthesis paths produce the SAME one-page structure:
//   1. buildLlmPrompt(data)  -> prompt for Anna's host LLM (llm.js)
//   2. fallbackReport(data)  -> deterministic synthesis used when the host
//      LLM is unavailable (e.g. local dev without a developer PAT). It is a
//      real synthesis of the check results, not a placeholder: verdict,
//      evidence, red flags and what-would-change-this are all derived from
//      the structured checks returned by the Executa.

export function fmtUsd(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return "unknown";
  if (v >= 1_000_000) return "$" + (v / 1_000_000).toFixed(2) + "M";
  if (v >= 1_000) return "$" + (v / 1_000).toFixed(1) + "k";
  return "$" + v.toFixed(2);
}

export function fmtAge(days) {
  if (days === null || days === undefined) return "unknown";
  if (days < 1) return `${Math.max(1, Math.round(days * 24))} hours`;
  if (days < 60) return `${Math.round(days)} days`;
  if (days < 730) return `${(days / 30.44).toFixed(1)} months`;
  return `${(days / 365.25).toFixed(1)} years`;
}

export function tokenTitle(data) {
  const t = data.token || {};
  const name = t.name || "Unknown token";
  const sym = t.symbol ? ` (${t.symbol})` : "";
  return `${name}${sym}`;
}

export function buildLlmPrompt(data) {
  return [
    "You are the report writer inside the 'Token Risk Report' Anna App.",
    "A deterministic checker has already measured the token below. Your job",
    "is ONLY to explain those measurements in plain language. Rules:",
    "- Use ONLY the numbers and facts in the JSON. Never invent figures,",
    "  dates, audits, partnerships or events that are not in the data.",
    "- If a check has status 'unknown', say plainly that it could not be",
    "  verified; do not guess it.",
    "- Write for a non-technical reader. Short sentences. No hype, no",
    "  price predictions, no 'buy' or 'sell' recommendation.",
    "- Output GitHub-flavoured markdown with EXACTLY these sections:",
    "  ## Verdict (one or two sentences, must state the risk band and score)",
    "  ## Why this score (3-6 bullets, each tied to a measured fact)",
    "  ## Red flags (bullets; write 'None measured.' if there are none)",
    "  ## What would change this verdict (2-4 bullets)",
    "  ## The numbers (compact bullet list of the key measured values)",
    "",
    "Measured data (JSON):",
    JSON.stringify(data, null, 2),
  ].join("\n");
}

function checkLine(c) {
  const v = c.value === null || c.value === undefined ? "not available" : c.value;
  return `- **${c.label}:** ${v} — ${c.detail}`;
}

export function fallbackReport(data) {
  const m = data.market || {};
  const checks = data.checks || [];
  const bad = checks.filter((c) => c.status === "bad");
  const warn = checks.filter((c) => c.status === "warn");
  const unknown = checks.filter((c) => c.status === "unknown");
  const lines = [];

  lines.push(`# Token Risk Report — ${tokenTitle(data)}`);
  lines.push("");
  lines.push("## Verdict");
  const verdictByBand = {
    LOW: "On the measured evidence this token looks comparatively low risk. That is not a guarantee of safety; it only means the standard structural red flags were not found.",
    MODERATE: "This token shows a mix of healthy signs and real concerns. It is not an obvious trap, but the concerns below deserve weight before any money goes in.",
    HIGH: "This token carries serious structural risk. Several measured checks point the same way: getting money out, or trusting the supply, could become a problem.",
    EXTREME: "This token shows the classic pattern of a likely rug or trap. The measured evidence below is the kind that precedes most total losses in this market.",
  };
  lines.push(
    `**Risk band: ${data.risk_band} (score ${data.risk_score}/100, higher = riskier).** ` +
      (verdictByBand[data.risk_band] || "")
  );
  lines.push("");
  lines.push("## Why this score");
  for (const c of checks) lines.push(checkLine(c));
  lines.push("");
  lines.push("## Red flags");
  if (bad.length === 0 && warn.length === 0) {
    lines.push("None measured.");
  } else {
    for (const c of [...bad, ...warn]) {
      lines.push(`- **${c.label}** (${c.status}): ${c.detail}`);
    }
  }
  if (unknown.length) {
    lines.push("");
    lines.push("Could not be verified:");
    for (const c of unknown) lines.push(`- **${c.label}:** ${c.detail}`);
  }
  lines.push("");
  lines.push("## What would change this verdict");
  const changes = [];
  if ((data.flags || []).includes("no_dex_pair"))
    changes.push("A live DEX pair with real liquidity appearing for this token.");
  if ((data.flags || []).includes("mint_authority_active"))
    changes.push("The mint authority being revoked, so supply can no longer be inflated.");
  if ((data.flags || []).includes("freeze_authority_active"))
    changes.push("The freeze authority being revoked, so accounts can no longer be frozen.");
  if ((data.flags || []).includes("concentration_unknown"))
    changes.push("A verified holder distribution showing no small group controls the supply.");
  if ((data.flags || []).includes("liquidity_below_1pct_of_fdv"))
    changes.push("Liquidity growing to a healthier share of the token's valuation.");
  if (changes.length === 0)
    changes.push("A material change in the measured facts above: age, liquidity depth, or holder distribution moving sharply in either direction.");
  for (const s of changes) lines.push(`- ${s}`);
  lines.push("");
  lines.push("## The numbers");
  lines.push(`- Chain: ${data.chain}`);
  lines.push(`- Address: ${data.address}`);
  if (m.age_days !== null && m.age_days !== undefined)
    lines.push(`- Oldest main pair age: ${fmtAge(m.age_days)}`);
  lines.push(`- Liquidity (main pair): ${fmtUsd(m.liquidity_usd)}`);
  lines.push(`- Fully diluted valuation: ${fmtUsd(m.fdv_usd)}`);
  lines.push(`- 24h volume: ${fmtUsd(m.volume_24h_usd)}`);
  lines.push(`- Price: ${m.price_usd ? "$" + m.price_usd : "unknown"}`);
  lines.push("");
  lines.push(
    `_Data: ${(data.data_sources || []).join(", ")}. Fetched ${data.fetched_at || ""}. ` +
      "This report is generated locally from the measured checks because the Anna " +
      "LLM was not reachable in this session. It is research information, not financial advice._"
  );
  return lines.join("\n");
}

// Minimal, safe markdown renderer: escapes HTML first, then applies the
// small subset the reports use (#, ##, **bold**, - lists, _italic_ lines).
export function renderMarkdown(md) {
  const esc = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s) =>
    esc(s)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/_([^_]+)_/g, "<em>$1</em>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  const out = [];
  let inList = false;
  for (const raw of String(md).split("\n")) {
    const line = raw.trimEnd();
    if (line.startsWith("- ")) {
      if (!inList) { out.push("<ul>"); inList = true; }
      out.push(`<li>${inline(line.slice(2))}</li>`);
      continue;
    }
    if (inList) { out.push("</ul>"); inList = false; }
    if (line.startsWith("## ")) out.push(`<h3>${inline(line.slice(3))}</h3>`);
    else if (line.startsWith("# ")) out.push(`<h2>${inline(line.slice(2))}</h2>`);
    else if (line.trim() === "") out.push("");
    else out.push(`<p>${inline(line)}</p>`);
  }
  if (inList) out.push("</ul>");
  return out.join("\n");
}
