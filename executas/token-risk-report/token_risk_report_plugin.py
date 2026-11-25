"""token-risk-report — Anna Executa plugin (stdio, JSON-RPC 2.0).

Deterministic on-chain risk checks for a token contract/mint address.
Data sources are free public APIs only (no keys, no cost):

  * DexScreener public API  — DEX pairs, liquidity, pair age, FDV, volume.
  * Solana public RPC        — mint/freeze authority, supply, largest accounts.
  * Blockscout public APIs   — EVM token info + holder list (per chain).

The plugin never calls an LLM. It returns structured, auditable checks plus
a deterministic risk score; narrative synthesis happens in the App bundle
via Anna's host LLM (anna.llm.complete).
"""

import json
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

TOOL_ID = "tool-dev-token-risk-report"
DEXSCREENER_TOKENS = "https://api.dexscreener.com/latest/dex/tokens/"
# Public Solana RPC endpoints, tried in order. The mainnet-beta endpoint is
# rate-limited (HTTP 429 under load), so calls retry with backoff and fall
# back to a second public endpoint before giving up.
SOLANA_RPCS = [
    "https://api.mainnet-beta.solana.com",
    "https://solana-rpc.publicnode.com",
]
BLOCKSCOUT_BASES = {
    "ethereum": "https://eth.blockscout.com",
    "base": "https://base.blockscout.com",
    "bsc": "https://bsc.blockscout.com",
    "arbitrum": "https://arbitrum.blockscout.com",
    "polygon": "https://polygon.blockscout.com",
}
HTTP_TIMEOUT = 12
UA = {"User-Agent": "anna-app-token-risk-report/0.1 (+https://anna.partners)"}

MANIFEST = {
    "name": TOOL_ID,
    "display_name": "Token Risk Checker",
    "version": "0.1.0",
    "description": (
        "Deterministic risk checks for a token contract address: age, "
        "liquidity, holder concentration and (on Solana) mint/freeze "
        "authority, from free public data sources."
    ),
    "tools": [
        {
            "name": "ping",
            "description": "Smoke-test method.",
            "parameters": {
                "type": "object",
                "properties": {},
                "additionalProperties": False,
            },
        },
        {
            "name": "token_risk_check",
            "description": (
                "Run the full deterministic risk check suite for one token "
                "contract/mint address and return structured checks plus a "
                "0-100 risk score (higher = riskier)."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "address": {
                        "type": "string",
                        "description": "Token contract address (EVM 0x...) or Solana mint address (base58).",
                    },
                    "chain": {
                        "type": "string",
                        "description": "Optional chain hint: solana, ethereum, base, bsc, arbitrum, polygon, or auto (default).",
                        "enum": ["auto", "solana", "ethereum", "base", "bsc", "arbitrum", "polygon"],
                    },
                },
                "required": ["address"],
                "additionalProperties": False,
            },
        },
    ],
}


# --------------------------------------------------------------------------
# HTTP helpers
# --------------------------------------------------------------------------

def http_get_json(url: str):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8"))


def http_post_json(url: str, payload: dict):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=data, headers={**UA, "Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
        return json.loads(resp.read().decode("utf-8"))


def log(*args):
    print("[token-risk]", *args, file=sys.stderr, flush=True)


# --------------------------------------------------------------------------
# Address handling
# --------------------------------------------------------------------------

BASE58 = set("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz")


def detect_chain(address: str, hint: str) -> str:
    if hint and hint != "auto":
        return hint
    if address.startswith("0x") and len(address) == 42:
        return "ethereum"  # EVM family; refined by DexScreener pair chainId
    if 32 <= len(address) <= 44 and all(c in BASE58 for c in address):
        return "solana"
    return "unknown"


def valid_address(address: str, chain: str) -> bool:
    if chain == "solana":
        return 32 <= len(address) <= 44 and all(c in BASE58 for c in address)
    if chain in BLOCKSCOUT_BASES:
        if not (address.startswith("0x") and len(address) == 42):
            return False
        try:
            int(address[2:], 16)
            return True
        except ValueError:
            return False
    return False


# --------------------------------------------------------------------------
# Data collection
# --------------------------------------------------------------------------

def dexscreener_pairs(address: str) -> list:
    try:
        data = http_get_json(DEXSCREENER_TOKENS + address)
    except Exception as exc:  # noqa: BLE001
        log("dexscreener failed:", exc)
        return []
    pairs = data.get("pairs") or []
    mine = [
        p for p in pairs
        if (p.get("baseToken") or {}).get("address", "").lower() == address.lower()
    ]
    return mine or pairs


def best_pair(pairs: list, chain: str):
    """Highest-liquidity pair, preferring pairs on the requested chain."""
    if not pairs:
        return None
    pool = pairs
    if chain != "solana" and chain in BLOCKSCOUT_BASES:
        on_chain = [p for p in pairs if p.get("chainId") == chain]
        if on_chain:
            pool = on_chain
    elif chain == "solana":
        on_chain = [p for p in pairs if p.get("chainId") == "solana"]
        if on_chain:
            pool = on_chain
    return max(pool, key=lambda p: (p.get("liquidity") or {}).get("usd") or 0)


def pair_facts(pair):
    if not pair:
        return {}
    created_ms = pair.get("pairCreatedAt")
    age_days = None
    if created_ms:
        age_days = max(0.0, (time.time() * 1000 - created_ms) / 86_400_000)
    return {
        "dex": pair.get("dexId"),
        "pair_address": pair.get("pairAddress"),
        "pair_url": pair.get("url"),
        "price_usd": _to_float(pair.get("priceUsd")),
        "liquidity_usd": _to_float((pair.get("liquidity") or {}).get("usd")),
        "fdv_usd": _to_float(pair.get("fdv")),
        "market_cap_usd": _to_float(pair.get("marketCap")),
        "volume_24h_usd": _to_float((pair.get("volume") or {}).get("h24")),
        "pair_created_at": (
            datetime.fromtimestamp(created_ms / 1000, tz=timezone.utc).isoformat()
            if created_ms else None
        ),
        "age_days": age_days,
        "token_name": (pair.get("baseToken") or {}).get("name"),
        "token_symbol": (pair.get("baseToken") or {}).get("symbol"),
        "chain_id": pair.get("chainId"),
    }


def _to_float(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


class RpcError(Exception):
    pass


def solana_rpc(method: str, params: list):
    """One Solana JSON-RPC call with retry + endpoint fallback.

    The public endpoints rate-limit heavy methods (notably
    getTokenLargestAccounts) both as HTTP 429 and as a JSON-RPC error body
    on an HTTP 200, so both shapes are treated as retryable failures.
    """
    payload = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
    last_exc: Exception | None = None
    for endpoint in SOLANA_RPCS:
        for attempt in range(3):
            try:
                data = http_post_json(endpoint, payload)
                if isinstance(data, dict) and data.get("error"):
                    err = data["error"]
                    raise RpcError(f"rpc error {err.get('code')}: {err.get('message')}")
                return data
            except urllib.error.HTTPError as exc:
                last_exc = exc
                if exc.code not in (429, 500, 502, 503):
                    break  # endpoint refuses this method; try the next one
                time.sleep(1.5 * (attempt + 1))
            except Exception as exc:  # noqa: BLE001
                last_exc = exc
                time.sleep(1.5 * (attempt + 1))
    raise last_exc if last_exc else RpcError("all RPC endpoints failed")


def solana_mint_info(address: str):
    """Return (info dict, error string). info keys: supply_raw, decimals,
    mint_authority, freeze_authority."""
    data = solana_rpc("getAccountInfo", [address, {"encoding": "jsonParsed"}])
    value = (data.get("result") or {}).get("value")
    if not value:
        return None, "mint account not found on Solana"
    parsed = ((value.get("data") or {}).get("parsed") or {})
    if parsed.get("type") not in ("mint",):
        return None, "address is not an SPL token mint"
    info = parsed.get("info") or {}
    return {
        "supply_raw": int(info.get("supply") or 0),
        "decimals": info.get("decimals"),
        "mint_authority": info.get("mintAuthority"),
        "freeze_authority": info.get("freezeAuthority"),
    }, None


def solana_largest_accounts(address: str):
    data = solana_rpc("getTokenLargestAccounts", [address])
    return ((data.get("result") or {}).get("value")) or []


def blockscout_token(base: str, address: str):
    return http_get_json(f"{base}/api/v2/tokens/{address}")


def blockscout_holders(base: str, address: str):
    data = http_get_json(f"{base}/api/v2/tokens/{address}/holders")
    return data.get("items") or []


# --------------------------------------------------------------------------
# Checks + scoring
# --------------------------------------------------------------------------

def check(key, label, value, status, detail):
    return {
        "key": key,
        "label": label,
        "value": value,
        "status": status,  # ok | warn | bad | unknown
        "detail": detail,
    }


def score_age(age_days, checks, flags):
    if age_days is None:
        checks.append(check("age", "Token age", None, "unknown",
                            "Pair creation time is not published by the data source."))
        flags.append("age_unknown")
        return 10
    days = age_days
    label = f"{days:.0f} days" if days >= 2 else f"{days * 24:.0f} hours"
    if days < 1:
        checks.append(check("age", "Token age", label, "bad",
                            "Less than a day old. Brand-new tokens carry the highest rug risk."))
        return 35
    if days < 7:
        checks.append(check("age", "Token age", label, "bad",
                            "Less than a week old; almost no track record."))
        return 25
    if days < 30:
        checks.append(check("age", "Token age", label, "warn",
                            "Less than a month old; still unproven."))
        return 15
    if days < 90:
        checks.append(check("age", "Token age", label, "warn",
                            "Under three months old."))
        return 5
    checks.append(check("age", "Token age", label, "ok",
                        "Older than three months; has a real track record."))
    return 0


def score_liquidity(facts, checks, flags):
    liq = facts.get("liquidity_usd")
    if liq is None:
        checks.append(check("liquidity", "Liquidity", None, "unknown",
                            "No liquidity figure published for the main pair."))
        flags.append("liquidity_unknown")
        return 15
    points = 0
    if liq < 1_000:
        status, points = "bad", 30
        detail = "Under $1k of liquidity: any sell of size will crater the price, if it fills at all."
    elif liq < 10_000:
        status, points = "bad", 20
        detail = "Under $10k of liquidity: exit is expensive and easily manipulated."
    elif liq < 50_000:
        status, points = "warn", 12
        detail = "Under $50k of liquidity: thin market, expect heavy slippage."
    elif liq < 250_000:
        status, points = "warn", 5
        detail = "Under $250k of liquidity: workable for small positions only."
    else:
        status = "ok"
        detail = "Deep enough for normal retail-size trades."
    checks.append(check("liquidity", "Liquidity", f"${liq:,.0f}", status, detail))
    fdv = facts.get("fdv_usd")
    if fdv and fdv > 0 and liq / fdv < 0.01:
        points += 10
        flags.append("liquidity_below_1pct_of_fdv")
        checks.append(check(
            "liquidity_ratio", "Liquidity vs valuation", f"{liq / fdv * 100:.2f}% of FDV",
            "bad",
            "Liquidity is under 1% of the fully diluted valuation: the price is "
            "held up by a very thin pool relative to the paper valuation."))
    return points


def score_concentration(top1, top10, checks, flags, source_note):
    if top10 is None:
        checks.append(check("concentration", "Holder concentration", None, "unknown",
                            f"Holder distribution unavailable ({source_note})."))
        flags.append("concentration_unknown")
        return 8
    points = 0
    if top10 > 0.80:
        status, points = "bad", 30
    elif top10 > 0.60:
        status, points = "bad", 22
    elif top10 > 0.40:
        status, points = "warn", 14
    elif top10 > 0.25:
        status, points = "warn", 6
    else:
        status = "ok"
    checks.append(check(
        "concentration", "Holder concentration",
        f"top 10 holders own {top10 * 100:.1f}% of supply", status,
        "A small group can move or dump the market when a few wallets hold "
        "most of the supply. Note: exchange and liquidity-pool wallets count "
        "as holders here."))
    if top1 is not None and top1 > 0.30:
        points += 8
        flags.append("single_wallet_over_30pct")
        checks.append(check(
            "top_holder", "Largest single holder", f"{top1 * 100:.1f}% of supply",
            "bad",
            "One wallet holds over 30% of the supply and can crash the price alone."))
    return points


def band_for(score: int) -> str:
    if score >= 75:
        return "EXTREME"
    if score >= 50:
        return "HIGH"
    if score >= 25:
        return "MODERATE"
    return "LOW"


# --------------------------------------------------------------------------
# Chain flows
# --------------------------------------------------------------------------

def run_solana(address: str) -> dict:
    checks, flags, sources = [], [], ["DexScreener", "Solana public RPC"]
    pairs = dexscreener_pairs(address)
    pair = best_pair(pairs, "solana")
    facts = pair_facts(pair)

    mint, err = solana_mint_info(address)
    if mint is None and pair is None:
        return {"success": False, "error": f"Token not found on Solana: {err}."}

    points = 0
    if pair is None:
        flags.append("no_dex_pair")
        checks.append(check("market", "DEX market", None, "bad",
                            "No DEX pair found for this mint: there is no open "
                            "market to buy or sell into."))
        points += 40
    else:
        points += score_age(facts.get("age_days"), checks, flags)
        points += score_liquidity(facts, checks, flags)

    top1 = top10 = None
    if mint is not None:
        # Authorities
        ma = mint["mint_authority"]
        fa = mint["freeze_authority"]
        if ma:
            points += 15
            flags.append("mint_authority_active")
            checks.append(check("mint_authority", "Mint authority", "ACTIVE", "bad",
                                "The mint authority is still set: new supply can "
                                "be created at any time and dilute holders."))
        else:
            checks.append(check("mint_authority", "Mint authority", "Renounced", "ok",
                                "Mint authority is revoked: the supply cannot be inflated."))
        if fa:
            points += 15
            flags.append("freeze_authority_active")
            checks.append(check("freeze_authority", "Freeze authority", "ACTIVE", "bad",
                                "The freeze authority is still set: token accounts "
                                "can be frozen, which can block selling."))
        else:
            checks.append(check("freeze_authority", "Freeze authority", "Renounced", "ok",
                                "Freeze authority is revoked: accounts cannot be frozen."))
        # Concentration
        try:
            largest = solana_largest_accounts(address)
            supply = mint["supply_raw"]
            if largest and supply > 0:
                amounts = sorted((int(a.get("amount") or 0) for a in largest), reverse=True)
                top1 = amounts[0] / supply
                top10 = sum(amounts[:10]) / supply
        except Exception as exc:  # noqa: BLE001
            log("largest accounts failed:", exc)
    points += score_concentration(top1, top10, checks, flags, "Solana RPC")

    score = max(0, min(100, points))
    return {
        "success": True,
        "data": {
            "chain": "solana",
            "address": address,
            "token": {
                "name": facts.get("token_name"),
                "symbol": facts.get("token_symbol"),
                "decimals": mint["decimals"] if mint else None,
            },
            "market": facts,
            "checks": checks,
            "flags": flags,
            "risk_score": score,
            "risk_band": band_for(score),
            "data_sources": sources,
            "fetched_at": datetime.now(timezone.utc).isoformat(),
        },
    }


def run_evm(address: str, chain: str) -> dict:
    checks, flags = [], []
    pairs = dexscreener_pairs(address)
    pair = best_pair(pairs, chain)
    facts = pair_facts(pair)
    resolved_chain = chain
    if pair and pair.get("chainId") in BLOCKSCOUT_BASES:
        resolved_chain = pair["chainId"]
    base = BLOCKSCOUT_BASES.get(resolved_chain)
    sources = ["DexScreener"] + ([f"Blockscout ({resolved_chain})"] if base else [])

    token_meta = {"name": facts.get("token_name"), "symbol": facts.get("token_symbol"),
                  "decimals": None}
    top1 = top10 = None
    holders_count = None
    if base:
        try:
            tok = blockscout_token(base, address)
            token_meta["name"] = tok.get("name") or token_meta["name"]
            token_meta["symbol"] = tok.get("symbol") or token_meta["symbol"]
            token_meta["decimals"] = (
                int(tok["decimals"]) if str(tok.get("decimals", "")).isdigit() else None
            )
            hc = tok.get("holders_count")
            holders_count = int(hc) if str(hc).isdigit() else None
            total_supply = int(tok.get("total_supply") or 0)
            holders = blockscout_holders(base, address)
            if holders and total_supply > 0:
                amounts = sorted((int(h.get("value") or 0) for h in holders), reverse=True)
                top1 = amounts[0] / total_supply
                top10 = sum(amounts[:10]) / total_supply
        except Exception as exc:  # noqa: BLE001
            log("blockscout failed:", exc)

    points = 0
    if pair is None:
        if not base or token_meta["name"] is None:
            return {"success": False,
                    "error": "Token not found: no DEX pair and no Blockscout record "
                             f"for this address on {resolved_chain}."}
        flags.append("no_dex_pair")
        checks.append(check("market", "DEX market", None, "bad",
                            "No DEX pair found for this contract: there is no open "
                            "market to buy or sell into."))
        points += 40
    else:
        points += score_age(facts.get("age_days"), checks, flags)
        points += score_liquidity(facts, checks, flags)
    points += score_concentration(top1, top10, checks, flags,
                                  f"no Blockscout data for {resolved_chain}")
    if holders_count is not None:
        checks.append(check("holders", "Holder count", f"{holders_count:,}", "ok" if holders_count >= 500 else "warn",
                            "More independent holders generally means a healthier distribution."))
    checks.append(check("authorities", "Mint/freeze authority", None, "unknown",
                        "EVM mint permissions depend on the contract code and are "
                        "not checked in this version; treat them as unverified."))

    score = max(0, min(100, points))
    return {
        "success": True,
        "data": {
            "chain": resolved_chain,
            "address": address,
            "token": token_meta,
            "market": facts,
            "checks": checks,
            "flags": flags,
            "risk_score": score,
            "risk_band": band_for(score),
            "data_sources": sources,
            "fetched_at": datetime.now(timezone.utc).isoformat(),
        },
    }


def token_risk_check(args: dict) -> dict:
    address = str(args.get("address") or "").strip()
    hint = str(args.get("chain") or "auto").strip().lower()
    if not address:
        return {"success": False, "error": "address is required"}
    chain = detect_chain(address, hint)
    if chain == "unknown":
        return {"success": False,
                "error": "Could not recognise this address. Paste a Solana mint "
                         "address (base58) or an EVM contract address (0x...)."}
    if not valid_address(address, chain):
        return {"success": False, "error": f"Address format is not valid for {chain}."}
    try:
        if chain == "solana":
            return run_solana(address)
        return run_evm(address, chain)
    except urllib.error.URLError as exc:
        return {"success": False, "error": f"Data source unreachable: {exc.reason}"}
    except Exception as exc:  # noqa: BLE001
        log("token_risk_check failed:", exc)
        return {"success": False, "error": f"Check failed: {exc}"}


# --------------------------------------------------------------------------
# Protocol loop (per Executa spec: describe / health / invoke over stdio)
# --------------------------------------------------------------------------

def invoke(method: str, args: dict) -> dict:
    # Dispatcher contract envelope:
    #   {"success": True,  "data":  <payload-dict>}
    #   {"success": False, "error": "<reason>"}
    if method == "ping":
        return {"success": True, "data": {"pong": True}}
    if method == "token_risk_check":
        return token_risk_check(args or {})
    return {"success": False, "error": f"unknown method: {method}"}


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as exc:
            sys.stdout.write(json.dumps({
                "jsonrpc": "2.0", "id": None,
                "error": {"code": -32700, "message": str(exc)},
            }) + "\n")
            sys.stdout.flush()
            continue
        try:
            if req.get("method") == "describe":
                result = MANIFEST
            elif req.get("method") == "health":
                result = {"status": "ready"}
            elif req.get("method") == "invoke":
                result = invoke(req["params"]["tool"], req["params"].get("arguments", {}))
            else:
                raise ValueError(f"unknown rpc: {req.get('method')}")
            payload = {"jsonrpc": "2.0", "id": req.get("id"), "result": result}
        except Exception as e:  # noqa: BLE001
            payload = {
                "jsonrpc": "2.0",
                "id": req.get("id"),
                "error": {"code": -32601, "message": str(e)},
            }
        sys.stdout.write(json.dumps(payload) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
