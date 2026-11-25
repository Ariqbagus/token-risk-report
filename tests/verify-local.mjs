// verify-local.mjs — local end-to-end verification without an Anna account.
//
//   node tests/verify-local.mjs [tokenAddress] [chain]
//
// What it proves, in order:
//   1. The bundled Executa answers describe/health over stdio JSON-RPC.
//   2. A real `token_risk_check` invoke against live public data sources
//      returns structured checks + a deterministic score.
//   3. bundle/report.js turns those checks into the one-page report via the
//      deterministic synthesis path (the path used whenever the Anna LLM
//      is unreachable, e.g. local dev without a developer PAT).
//   4. bundle/llm.js boundary: a failing llm.complete surfaces as
//      LlmUnavailable (so app.js falls back), and a working llm.complete
//      is passed through untouched.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pluginPath = join(here, "..", "executas", "token-risk-report", "token_risk_report_plugin.py");
const address = process.argv[2] || "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"; // BONK
const chain = process.argv[3] || "auto";

function rpcSession() {
  const proc = spawn("python3", [pluginPath], { stdio: ["pipe", "pipe", "inherit"] });
  const rl = createInterface({ input: proc.stdout });
  const pending = new Map();
  let id = 0;
  rl.on("line", (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const p = pending.get(msg.id);
    if (p) { pending.delete(msg.id); p(msg); }
  });
  return {
    call(method, params) {
      const myId = ++id;
      return new Promise((resolve) => {
        pending.set(myId, resolve);
        proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
      });
    },
    close() { proc.stdin.end(); proc.kill(); },
  };
}

const fail = (msg) => { console.error("FAIL:", msg); process.exit(1); };

const s = rpcSession();
const desc = await s.call("describe");
if (!desc.result || !desc.result.tools.some((t) => t.name === "token_risk_check"))
  fail("describe did not advertise token_risk_check");
console.log("1. describe OK — tools:", desc.result.tools.map((t) => t.name).join(", "));

const health = await s.call("health");
if (!health.result || health.result.status !== "ready") fail("health not ready");
console.log("2. health OK");

const inv = await s.call("invoke", { tool: "token_risk_check", arguments: { address, chain } });
s.close();
const env = inv.result;
if (!env || env.success !== true) fail("token_risk_check failed: " + (env && env.error));
const data = env.data;
console.log(
  `3. token_risk_check OK — ${data.token.name || "?"} (${data.token.symbol || "?"}) on ${data.chain}: ` +
  `score ${data.risk_score}/100, band ${data.risk_band}, ${data.checks.length} checks, flags [${data.flags.join(", ")}]`
);

const { fallbackReport, renderMarkdown } = await import(join(here, "..", "bundle", "report.js"));
const md = fallbackReport(data);
if (!md.includes("## Verdict") || !md.includes(String(data.risk_score))) fail("fallback report malformed");
const html = renderMarkdown(md);
if (!html.includes("<h3>Verdict</h3>")) fail("markdown renderer malformed");
console.log("4. fallback report OK —", md.split("\n").length, "lines; renderer OK");

const { synthesizeWithAnnaLlm, LlmUnavailable } = await import(join(here, "..", "bundle", "llm.js"));
let fellBack = false;
try {
  await synthesizeWithAnnaLlm(
    { llm: { complete: async () => { throw Object.assign(new Error("not_implemented"), { code: "not_implemented" }); } } },
    data
  );
} catch (e) {
  fellBack = e instanceof LlmUnavailable;
}
if (!fellBack) fail("llm.js did not map a failing llm.complete to LlmUnavailable");
console.log("5. llm.js OK — failing llm.complete surfaces as LlmUnavailable (fallback engages)");

const canned = await synthesizeWithAnnaLlm(
  { llm: { complete: async (req) => {
      if (!req.messages?.[0]?.content?.text?.includes("Token Risk Report")) fail("prompt missing app framing");
      return { content: { type: "text", text: "## Verdict\nCanned LLM report." }, model: "test-model" };
    } } },
  data
);
if (!canned.text.includes("Canned LLM report") || canned.model !== "test-model")
  fail("llm.js did not pass a working llm.complete through");
console.log("6. llm.js OK — working llm.complete passes through with its model name");

console.log("\n----- ONE-PAGE REPORT (deterministic synthesis of live data) -----\n");
console.log(md);
console.log("\nALL LOCAL CHECKS PASSED");
