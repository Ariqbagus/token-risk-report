// llm.js — THE Anna LLM boundary for Token Risk Report.
//
// This module is the single place where the App talks to Anna's hosted
// model. Everything else in the bundle is LLM-agnostic:
//
//   synthesizeWithAnnaLlm(anna, checksData)
//     -> { text, model }        on success
//     -> throws LlmUnavailable  when the host LLM cannot be reached
//        (local dev harness without a developer PAT, quota exhausted,
//         host runtime without llm wired, ...). app.js catches that one
//        error type and falls back to report.js's deterministic synthesis,
//        so a run always completes with a meaningful report.
//
// Wire contract (Anna docs, "App-Side LLM & Agent API"):
//   anna.llm.complete({ messages: [{ role, content: { type: "text", text } }],
//                       maxTokens }) -> { content: { type: "text", text }, model, usage }
// No manifest declaration or API key is needed: installing the App is the
// consent, and usage is billed to the running user's Anna credits/BYOK.

import { buildLlmPrompt } from "./report.js";

export class LlmUnavailable extends Error {
  constructor(reason) {
    super(reason || "Anna LLM unavailable");
    this.name = "LlmUnavailable";
    this.code = "llm_unavailable";
  }
}

function unwrap(res) {
  // Host RPC resolves { ok, result } / { ok: false, error }; some runtime
  // versions hand back the bare result. Normalise both.
  if (res && typeof res === "object" && "ok" in res) {
    if (!res.ok) {
      const err = res.error || {};
      throw new LlmUnavailable(err.code ? `${err.code}: ${err.message || ""}` : "host returned an error");
    }
    return res.result;
  }
  return res;
}

async function callComplete(llm, prompt) {
  const res = unwrap(
    await llm.complete({
      messages: [{ role: "user", content: { type: "text", text: prompt } }],
      maxTokens: 1400,
    })
  );
  const text =
    res && res.content && typeof res.content.text === "string"
      ? res.content.text.trim()
      : "";
  if (!text) throw new LlmUnavailable("LLM returned an empty completion");
  return { text, model: res.model || null };
}

export async function synthesizeWithAnnaLlm(anna, data) {
  const prompt = buildLlmPrompt(data);
  const candidates = [];
  if (anna && anna.llm && typeof anna.llm.complete === "function")
    candidates.push(anna.llm);
  if (
    typeof window !== "undefined" &&
    window.anna && window.anna.llm &&
    typeof window.anna.llm.complete === "function" &&
    (!anna || window.anna.llm !== anna.llm)
  )
    candidates.push(window.anna.llm);
  if (candidates.length === 0)
    throw new LlmUnavailable("no llm.complete surface on this host runtime");
  let lastErr = null;
  for (const llm of candidates) {
    try {
      return await callComplete(llm, prompt);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof LlmUnavailable
    ? lastErr
    : new LlmUnavailable(lastErr ? String(lastErr.message || lastErr) : "llm call failed");
}
