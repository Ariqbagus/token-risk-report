// app.js — Token Risk Report bundle entry.
//
// Flow of one Qualified App Run:
//   1. User pastes a token contract address (+ optional chain).
//   2. anna.tools.invoke -> bundled Executa `token_risk_check` runs the
//      deterministic checks (age, liquidity, holder concentration,
//      mint/freeze authority) against free public data sources.
//   3. The measured checks are synthesised into a one-page plain-language
//      report by Anna's host LLM (llm.js). If the LLM is unreachable in
//      this session, report.js's deterministic synthesis is used instead,
//      clearly labelled — the run still completes with a real report.
//   4. A summary of the run is persisted with anna.storage for next open.

import { AnnaAppRuntime } from "/static/anna-apps/_sdk/latest/index.js";
import { synthesizeWithAnnaLlm, LlmUnavailable } from "./llm.js";
import { fallbackReport, renderMarkdown, fmtUsd, fmtAge, tokenTitle } from "./report.js";

const DEV_TOOL_ID = "tool-dev-token-risk-report";

function resolveToolId() {
  const ids = typeof window !== "undefined" ? window.__ANNA_TOOL_IDS__ : null;
  if (ids && typeof ids === "object") {
    if (typeof ids["token-risk-report"] === "string") return ids["token-risk-report"];
    const vals = Object.values(ids).filter((v) => typeof v === "string");
    if (vals.length) return vals[0];
  }
  return DEV_TOOL_ID;
}

const $ = (id) => document.getElementById(id);

function setStatus(msg, kind = "") {
  const el = $("status");
  el.textContent = msg;
  el.dataset.kind = kind;
}

function setBusy(busy) {
  $("run-btn").disabled = busy;
  $("address-input").disabled = busy;
  $("chain-select").disabled = busy;
}

function unwrapRpc(res) {
  if (res && typeof res === "object" && "ok" in res) {
    if (!res.ok) {
      const err = res.error || {};
      throw new Error(err.message || err.code || "Host call failed");
    }
    return res.result;
  }
  return res;
}

function renderFacts(data) {
  const m = data.market || {};
  $("facts").hidden = false;
  $("score-num").textContent = String(data.risk_score);
  const band = $("band-chip");
  band.textContent = data.risk_band + " RISK";
  band.dataset.band = data.risk_band;
  $("token-title").textContent = tokenTitle(data);
  $("token-sub").textContent = `${data.chain} · ${data.address}`;
  $("fact-age").textContent = fmtAge(m.age_days);
  $("fact-liq").textContent = fmtUsd(m.liquidity_usd);
  $("fact-fdv").textContent = fmtUsd(m.fdv_usd);
  $("fact-vol").textContent = fmtUsd(m.volume_24h_usd);

  const list = $("checks-list");
  list.innerHTML = "";
  for (const c of data.checks || []) {
    const li = document.createElement("li");
    li.className = "check";
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.dataset.status = c.status;
    chip.textContent = c.status.toUpperCase();
    const body = document.createElement("div");
    const head = document.createElement("div");
    head.innerHTML = `<strong></strong> <span class="val"></span>`;
    head.querySelector("strong").textContent = c.label;
    head.querySelector(".val").textContent =
      c.value === null || c.value === undefined ? "" : String(c.value);
    const detail = document.createElement("p");
    detail.textContent = c.detail;
    body.append(head, detail);
    li.append(chip, body);
    list.append(li);
  }
}

async function runReport(anna, toolId) {
  const address = $("address-input").value.trim();
  const chain = $("chain-select").value;
  if (!address) {
    setStatus("Paste a token contract address first.", "error");
    return;
  }
  setBusy(true);
  $("report-wrap").hidden = true;
  $("facts").hidden = true;
  setStatus("Running on-chain checks (age, liquidity, holders, authorities)…");
  let data;
  try {
    const raw = await anna.tools.invoke({
      tool_id: toolId,
      method: "token_risk_check",
      args: { address, chain },
    });
    const envelope = unwrapRpc(raw);
    if (!envelope || envelope.success !== true) {
      throw new Error((envelope && envelope.error) || "The checker returned no result.");
    }
    data = envelope.data;
  } catch (e) {
    setStatus(`Check failed: ${e.message}`, "error");
    setBusy(false);
    return;
  }

  renderFacts(data);
  setStatus("Checks complete. Writing your report…");

  let markdown, sourceLabel;
  try {
    const { text, model } = await synthesizeWithAnnaLlm(anna, data);
    markdown = text;
    sourceLabel = `Report written by Anna's AI${model ? ` (${model})` : ""} from the measured checks above.`;
  } catch (e) {
    if (!(e instanceof LlmUnavailable)) {
      setStatus(`Report failed: ${e.message}`, "error");
      setBusy(false);
      return;
    }
    markdown = fallbackReport(data);
    sourceLabel =
      "Report generated locally from the measured checks (Anna's AI was not reachable in this session).";
  }

  $("report").innerHTML = renderMarkdown(markdown);
  $("report-source").textContent = sourceLabel;
  $("report-wrap").hidden = false;
  setStatus("Report ready.");
  setBusy(false);

  try {
    await anna.storage.set({
      key: "token-risk-report:last",
      value: {
        address: data.address,
        chain: data.chain,
        symbol: (data.token || {}).symbol || null,
        risk_score: data.risk_score,
        risk_band: data.risk_band,
        at: data.fetched_at,
      },
    });
  } catch {
    /* storage is best-effort; the run already succeeded */
  }
}

async function main() {
  let anna;
  try {
    anna = await AnnaAppRuntime.connect();
  } catch {
    setStatus(
      "Standalone preview: open this App inside Anna (or via `anna-app dev`) to run a report.",
      "error"
    );
    setBusy(true);
    return;
  }

  await anna.window.set_title({ title: "Token Risk Report" });
  if (anna.theme) document.documentElement.dataset.theme = anna.theme;
  if (typeof anna.onThemeChange === "function") {
    anna.onThemeChange(({ theme }) => {
      document.documentElement.dataset.theme = theme;
    });
  }

  const toolId = resolveToolId();

  const payload = anna.entryPayload || {};
  if (typeof payload.address === "string") $("address-input").value = payload.address;
  if (typeof payload.chain === "string") $("chain-select").value = payload.chain;

  const last = anna.runtimeState && anna.runtimeState["token-risk-report:last"];
  if (last && last.address) {
    setStatus(
      `Last report: ${last.symbol || last.address} on ${last.chain} — ${last.risk_band} risk (${last.risk_score}/100). Paste an address to run a new one.`
    );
  } else {
    setStatus("Ready. Paste a token address to get a one-page risk report.");
  }

  $("run-btn").addEventListener("click", () => runReport(anna, toolId));
  $("address-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") runReport(anna, toolId);
  });
  if (payload.address) runReport(anna, toolId);
}

main();
