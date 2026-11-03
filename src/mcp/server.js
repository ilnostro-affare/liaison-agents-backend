/**
 * Liaison Meta Ads MCP server (extracted from backend/workers/meta-mcp/index.js).
 *
 * One Cloudflare Worker, two surfaces over the same tool implementations:
 *
 *   POST /mcp            JSON-RPC 2.0 for MCP clients (Claude, ChatGPT, ...).
 *                        Streamable HTTP, stateless; OAuth 2.0 discovery + dynamic
 *                        client registration so the client can connect itself.
 *                        tools/list and tools/call see PUBLIC_TOOLS only (read-only).
 *
 *   GET  /call/{tool}    A REST wrapper the product's own web UI uses for every
 *                        data fetch. Authenticated by a session token; it can also
 *                        reach the fixed front-end write routes (BW_FRONT), which
 *                        are deliberately not in TOOLS so no model ever lists them.
 *
 * Every tool call is proxied to the Meta Graph worker (`meta-auth`, see
 * src/write and src/pool) over HTTPS with a shared INTERNAL_API_TOKEN.
 *
 * Trimmed from the original: the OAuth authorize/token/callback handlers, the
 * Apple/Google/e-mail sign-in routes, storage/recycle-bin routes, AI-session
 * capture and the inline favicon. They are product plumbing, not the MCP pattern.
 */
import { TOOLS, PUBLIC_TOOLS } from "./tools.js";

const MCP_PROTOCOL_VERSION = "2025-03-26";
const LIA_API = "https://api.liaisone.com";     // the Graph worker (public address)
const LIA_APP = "https://liaisone.com";
const SERVER_NAME = "liaison-meta-ads";
const SERVER_VERSION = "1.0.0";

// The product UI's own channel to the write layer. Kept OUT of TOOLS on purpose:
// the model must never list or learn apply / undo / journal.
export const BW_FRONT = ["apply_write_plan", "undo_write", "get_write_journal", "delete_journal_entry", "copy_status", "entity_state"];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/\/+/g, "/").replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    try {
      // ── HEAD: protocol version discovery ──
      if (request.method === "HEAD") {
        return new Response(null, { headers: { "MCP-Protocol-Version": MCP_PROTOCOL_VERSION, ...corsHeaders(request) } });
      }

      // ── Health check ──
      if ((path === "/" || path === "/health") && request.method === "GET") {
        return jsonResponse({ name: SERVER_NAME, version: SERVER_VERSION, protocol: "mcp", status: "running", tools_count: TOOLS.length }, request);
      }

      // ── MCP endpoint: root POST or /mcp POST ──
      if ((path === "/" || path === "/mcp") && request.method === "POST") {
        // No Bearer token -> 401 with resource metadata, which starts the OAuth flow in the client
        const authHeader = request.headers.get("Authorization") || "";
        if (!authHeader.startsWith("Bearer ")) {
          const base = `${url.protocol}//${url.host}`;
          return new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
            headers: {
              "WWW-Authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
              "Content-Type": "application/json",
              ...corsHeaders(request)
            }
          });
        }
        return handleMcpPost(request, env, ctx);
      }

      // ── GET /mcp -> 405: POST-only MCP server ──
      if (path === "/mcp" && request.method === "GET") {
        return new Response(null, { status: 405, headers: { "Allow": "POST", "MCP-Protocol-Version": MCP_PROTOCOL_VERSION, ...corsHeaders(request) } });
      }

      // ── OAuth Protected Resource Metadata (RFC 9728) ──
      if (path === "/.well-known/oauth-protected-resource") {
        const base = `${url.protocol}//${url.host}`;
        return jsonResponse({ resource: base, authorization_servers: [`${base}`], bearer_methods_supported: ["header"] }, request);
      }

      // ── OAuth Authorization Server Metadata (RFC 8414) ──
      if (path === "/.well-known/oauth-authorization-server") {
        const base = `${url.protocol}//${url.host}`;
        return jsonResponse({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"]
        }, request);
      }

      // ── Dynamic Client Registration (RFC 7591), public clients with PKCE ──
      if (path === "/register") {
        let body = {};
        if (request.method === "POST") body = await request.json().catch(() => ({}));
        const clientId = "liaison_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
        return jsonResponse({
          client_id: clientId,
          client_name: body.client_name || "MCP Client",
          redirect_uris: body.redirect_uris || [],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none"
        }, request, 201);
      }

      // (/authorize, /token and the Meta OAuth callback are omitted from this extract.)

      // ── REST wrapper: GET /call/{tool}?param=value ──
      if (path.startsWith("/call/") && request.method === "GET") {
        const toolName = path.replace("/call/", "").replace(/\/$/, "");
        const tool = TOOLS.find(t => t.name === toolName) || (BW_FRONT.includes(toolName) ? { name: toolName } : null);
        if (!tool) {
          return jsonResponse({ error: `Unknown tool: ${toolName}`, available: TOOLS.map(t => t.name) }, request, 404);
        }

        // The tenant comes ONLY from the verified session token. A member_id in the
        // URL is never trusted - it would allow reading another tenant's data.
        let memberId = null;
        const authHeader = request.headers.get("Authorization") || "";
        const sessTok = authHeader.replace(/^Bearer\s+/i, "").trim();
        if (sessTok && env.META_KV) {
          memberId = await env.META_KV.get(`authsession:${sessTok}`);
          // sliding session: every authenticated call renews the 15-minute TTL
          if (memberId) { try { await env.META_KV.put(`authsession:${sessTok}`, memberId, { expirationTtl: 900 }); } catch (_) {} }
        }
        if (!memberId) {
          return jsonResponse({ ok: false, error: "Unauthorized", action: "refresh_session" }, request, 401);
        }

        const args = {};
        for (const [key, value] of url.searchParams) {
          if (key !== "member_id") args[key] = value;
        }
        const result = await executeTool(env, memberId, toolName, args);
        return jsonResponse(result, request);
      }

      return jsonResponse({ error: "Not found", path }, request, 404);
    } catch (error) {
      console.error("WORKER_ERROR", { error: error?.message });
      return jsonResponse({ error: "Internal error" }, request, 500);
    }
  }
};

// ─── MCP Protocol: JSON-RPC handler ────────────────────────────────────────────
export async function handleMcpPost(request, env, ctx) {
  const body = await request.json();
  const { jsonrpc, id, method, params } = body;

  if (jsonrpc !== "2.0") return mcpError(id, -32600, "Invalid JSON-RPC version", request);

  switch (method) {
    case "initialize":
      return mcpResponse(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
      }, request);

    case "notifications/initialized":
      return new Response(null, { status: 204, headers: corsHeaders(request) });

    case "tools/list":
      // The open MCP is read-only: plan_* tools exist for Liaison's own runner and
      // UI, which reach them through /call, never through this JSON-RPC surface.
      return mcpResponse(id, { tools: PUBLIC_TOOLS }, request);

    case "tools/call": {
      const toolName = params?.name;
      const args = params?.arguments || {};
      if (!toolName) return mcpError(id, -32602, "Missing tool name", request);

      // Checked against PUBLIC_TOOLS, not TOOLS: a client that guesses the name of a
      // plan tool gets "Unknown tool", the same answer as for a tool that does not exist.
      const tool = PUBLIC_TOOLS.find(t => t.name === toolName);
      if (!tool) return mcpError(id, -32602, `Unknown tool: ${toolName}`, request);

      const memberId = await resolveMemberId(request, env);
      if (!memberId) {
        return mcpResponse(id, {
          content: [{ type: "text", text: JSON.stringify({ ok: false, error: "Not authenticated. Please reconnect the Liaison Meta Ads connector.", action: "reconnect" }) }],
          isError: true
        }, request);
      }

      try {
        const result = await executeTool(env, memberId, toolName, args);
        const content = [{ type: "text", text: JSON.stringify(result, null, 2) }];
        // Meta refused the read (token expired, permission lost): an error to the
        // client, never a result it could read as zero spend.
        if (result && (result.error === "meta_reconnect" || result.error === "meta_read_failed")) {
          return mcpResponse(id, { content, isError: true }, request);
        }
        return mcpResponse(id, { content }, request);
      } catch (error) {
        console.error("TOOL_ERROR", { tool: toolName, error: error?.message });
        return mcpResponse(id, {
          content: [{
            type: "text",
            // `meta_error` is a hard marker: a failed call must never reach the user as
            // zero spend or "everything is paused". The catch wraps all of executeTool,
            // so the hint does not blame Meta outright.
            text: JSON.stringify({
              ok: false,
              meta_error: true,
              error: error?.message || "Tool execution failed",
              hint: "This tool call failed (upstream Meta API or Liaison itself). Do not present this as zero spend, zero leads, or paused campaigns, and do not state any status or number from this call. Tell the user the data could not be loaded right now and suggest retrying shortly."
            })
          }],
          isError: true
        }, request);
      }
    }

    case "ping":
      return mcpResponse(id, {}, request);

    default:
      return mcpError(id, -32601, `Method not found: ${method}`, request);
  }
}

// ─── Tool execution ────────────────────────────────────────────────────────────
// Trimmed: the original routes ~30 more front-end channels (media library,
// interest search, geo search, ...) and every read tool; a representative set is kept.
export async function executeTool(env, memberId, toolName, args) {
  // ── The write layer: plan tools (model-callable through Liaison's own runner) and
  //    the front-end channel (apply / undo / journal) ──
  if (toolName.startsWith("plan_") || BW_FRONT.includes(toolName)) {
    const get = async (wpath) => {
      const headers = {};
      if (env.INTERNAL_API_TOKEN) headers["Authorization"] = "Bearer " + env.INTERNAL_API_TOKEN;
      const sep = wpath.includes("?") ? "&" : "?";
      const res = await fetch(`${LIA_API}${wpath}${sep}member_id=${encodeURIComponent(memberId)}`, { headers });
      try { return await res.json(); } catch { return { ok: false, error: "Bad backend response" }; }
    };
    const post = async (wpath, payload) => {
      const headers = { "Content-Type": "application/json" };
      if (env.INTERNAL_API_TOKEN) headers["Authorization"] = "Bearer " + env.INTERNAL_API_TOKEN;
      const res = await fetch(`${LIA_API}${wpath}?member_id=${encodeURIComponent(memberId)}`,
        { method: "POST", headers, body: JSON.stringify(payload) });
      try { return await res.json(); } catch { return { ok: false, error: "Bad backend response" }; }
    };
    // Object args arrive from the GET /call channel as JSON strings. Parse back what
    // parses; leave scalars and sentinel strings ("auto") alone. Before this, every
    // object override arrived as the literal "[object Object]" and was dropped.
    const oarg = (v) => {
      if (v == null || typeof v === "object") return v;
      if (typeof v === "string" && (v[0] === "{" || v[0] === "[")) {
        try { const p = JSON.parse(v); return (p && typeof p === "object") ? p : v; } catch (_) { return v; }
      }
      return v;
    };
    if (toolName === "plan_update_entity") {
      // This gateway rebuilds `changes` from scratch and knows fields by name, so a
      // field absent HERE looks exactly like a backend that ignores it. `!== undefined`
      // throughout: an empty array means "clear it", "0" on end_time means "remove",
      // and a truth test would drop both.
      const changes = {};
      if (args.status) changes.status = args.status;
      if (args.daily_budget != null) changes.daily_budget = args.daily_budget;
      if (args.name) changes.name = args.name;
      if (args.lifetime_budget !== undefined) changes.lifetime_budget = args.lifetime_budget;
      if (args.end_time !== undefined) changes.end_time = args.end_time;
      if (args.special_ad_categories !== undefined) changes.special_ad_categories = oarg(args.special_ad_categories);
      if (args.special_ad_category_country !== undefined) changes.special_ad_category_country = oarg(args.special_ad_category_country);
      if (args.age_min !== undefined) changes.age_min = args.age_min;
      if (args.age_max !== undefined) changes.age_max = args.age_max;
      if (args.genders !== undefined) changes.genders = args.genders;
      if (args.interests !== undefined) changes.interests = oarg(args.interests);
      if (args.locales !== undefined) changes.locales = oarg(args.locales);
      if (args.age_range !== undefined) changes.age_range = oarg(args.age_range);
      // A targeting write REPLACES. oarg returns the raw string when the parse fails
      // (not {}), so a broken geo fails the planner's checks loudly instead of
      // emptying the ad set's locations.
      if (args.geo !== undefined) changes.geo = oarg(args.geo);
      if (args.advantage_audience !== undefined) changes.advantage_audience = args.advantage_audience;
      if (args.placements !== undefined) changes.placements = oarg(args.placements);
      if (args.device_platforms !== undefined) changes.device_platforms = oarg(args.device_platforms);
      if (args.user_os !== undefined) changes.user_os = args.user_os;
      if (args.wifi_only !== undefined) changes.wifi_only = args.wifi_only;
      if (args.placement_soft_opt_out !== undefined) changes.placement_soft_opt_out = oarg(args.placement_soft_opt_out);
      return await post("/meta/write/plan", { tool: "update_entity", entity_id: args.entity_id, entity_type: args.entity_type, changes });
    }
    if (toolName === "plan_activate_entity") return await post("/meta/write/plan", { tool: "activate_entity", entity_id: args.entity_id, entity_type: args.entity_type, changes: {} });
    if (toolName === "plan_copy_entity") return await post("/meta/write/plan", { tool: "copy_entity", entity_id: args.entity_id, entity_type: args.entity_type, changes: { rename_suffix: args.rename_suffix, destination_id: args.destination_id, copies: args.copies } });
    if (toolName === "plan_create_ad_from_creative") return await post("/meta/write/plan", { tool: "create_ad_from_creative", entity_id: args.ad_set_id, entity_type: "ad", changes: { ad_set_id: args.ad_set_id, creative_id: args.creative_id, source_ad_id: args.source_ad_id, name: args.name } });
    // The front-end channel. Only Liaison's UI reaches these, after the person pressed Yes.
    if (toolName === "apply_write_plan") return await post("/meta/write/apply", { plan_id: args.plan_id, mode: args.mode, session_id: args.session_id, account_name: args.account_name,
      overrides: args.override_name ? { name: args.override_name } : undefined });
    if (toolName === "undo_write") return await post("/meta/write/undo", { journal_id: args.journal_id });
    if (toolName === "get_write_journal") return await get("/meta/journal" + (args.account ? "?account=" + encodeURIComponent(String(args.account).replace(/[^0-9]/g, "")) : ""));
    if (toolName === "copy_status") return await get(`/meta/write/copy-status?job=${encodeURIComponent(args.job || "")}`);
    return { ok: false, error: `Unknown write tool: ${toolName}` };
  }

  // ── Read tools ──
  const qs = (params) => {
    const q = new URLSearchParams();
    q.set("member_id", memberId);
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null && String(v) !== "") q.set(k, String(v));
    });
    return q.toString();
  };
  const callMeta = async (path, params = {}) => {
    // Server-to-server: the shared internal token tells the Graph worker this is a
    // trusted proxy, so it honours the member_id resolved HERE from the bearer token.
    const headers = {};
    if (env.INTERNAL_API_TOKEN) headers["Authorization"] = "Bearer " + env.INTERNAL_API_TOKEN;
    const res = await fetch(`${LIA_API}${path}?${qs(params)}`, { headers });
    const text = await res.text();
    if (!text) return { ok: false, error: "Empty response from backend" };
    try { return JSON.parse(text); } catch { return { ok: false, error: "Invalid JSON from backend", raw: text.slice(0, 200) }; }
  };
  const liaison = (data) => ({
    ...data,
    _liaison: { dashboard: LIA_APP, data_retention: "permanent", hint: "Visual dashboards and historical data available at liaisone.com" }
  });

  switch (toolName) {
    case "list_ad_accounts":
      return liaison(await callMeta("/meta/accounts"));
    case "get_account_stats":
      return liaison(await callMeta("/meta/stats", { account: args.account, from: args.from, to: args.to }));
    case "get_campaigns":
      return liaison(await callMeta("/meta/campaigns", { account: args.account, from: args.from, to: args.to }));
    case "get_adsets":
      return liaison(await callMeta("/meta/adsets", { account: args.account, campaign: args.campaign, from: args.from, to: args.to }));
    case "find_entity":
      return liaison(await callMeta("/meta/ads/structure", { account: args.account, q: args.query, kind: args.kind, status: args.status }));
    case "get_ads_tree":
      return liaison(await callMeta("/meta/ads/tree", { account: args.account, from: args.from, to: args.to }));
    case "get_leads": {
      // limit / offset are forwarded but kept OUT of the tool's inputSchema: the model
      // always gets the whole period in one call; only the UI paginates.
      const p = { account: args.account, from: args.from, to: args.to };
      if (args.limit) p.limit = args.limit;
      if (args.offset) p.offset = args.offset;
      return liaison(await callMeta("/meta/vali/leads", p));
    }
    case "get_budget":
      return await callMeta("/meta/budget-read", { entity_id: args.entity_id, entity_type: args.entity_type });
    default:
      // (the remaining read tools follow the same callMeta pattern in the original)
      return { ok: false, error: `Unknown tool: ${toolName}` };
  }
}

// ─── Auth: resolve the tenant behind an MCP bearer token ───────────────────────
async function resolveMemberId(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return null;   // never trust a client-supplied id
  const bearer = authHeader.slice(7).trim();
  if (env.META_KV) {
    const raw = await env.META_KV.get(`mcp_token:${bearer}`);
    if (raw) {
      try { const data = JSON.parse(raw); if (data.member_id) return data.member_id; } catch {}
    }
  }
  return null;
}

function mcpResponse(id, result, request) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { headers: { "Content-Type": "application/json", ...corsHeaders(request) } });
}
function mcpError(id, code, message, request) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), { headers: { "Content-Type": "application/json", ...corsHeaders(request) } });
}
function jsonResponse(data, request, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...corsHeaders(request) } });
}
function corsHeaders(request) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Session-Id",
    "Access-Control-Expose-Headers": "Mcp-Session-Id"
  };
}
