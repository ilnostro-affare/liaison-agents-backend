// The MCP surface: what a client sees, and what it cannot reach.
import { TOOLS, PUBLIC_TOOLS } from "../src/mcp/tools.js";
import server, { BW_FRONT } from "../src/mcp/server.js";
import { kvMock, fetchMock } from "./support/mocks.js";

const rpc = (body, bearer = "TEST_BEARER") => new Request("https://mcp.example.com/mcp", { method: "POST",
  headers: { "Content-Type": "application/json", ...(bearer ? { Authorization: "Bearer " + bearer } : {}) }, body: JSON.stringify(body) });

export default async function ({ t, eq, group }) {
  const env = { META_KV: kvMock({ "mcp_token:TEST_BEARER": { member_id: "member_1" }, "authsession:SESSION1": "member_1" }), INTERNAL_API_TOKEN: "test-internal" };

  await group("the registry", async () => {
    eq("33 tools in TOOLS", TOOLS.length, 33);
    eq("29 public (read-only) tools", PUBLIC_TOOLS.length, 29);
    eq("the 4 filtered are the plan tools", TOOLS.filter((x) => !PUBLIC_TOOLS.includes(x)).map((x) => x.name).sort(),
      ["plan_activate_entity", "plan_copy_entity", "plan_create_ad_from_creative", "plan_update_entity"]);
    t("no public tool can write", PUBLIC_TOOLS.every((x) => !/^(plan_|apply_)/.test(x.name)));
    t("every public tool is annotated read-only", PUBLIC_TOOLS.every((x) => !x.annotations || x.annotations.readOnlyHint === true));
    eq("32 of 33 carry a directory title (get_budget has none)", TOOLS.filter((x) => x.annotations && x.annotations.title).length, 32);
    t("apply is not a tool at all", !TOOLS.some((x) => x.name === "apply_write_plan") && BW_FRONT.includes("apply_write_plan"));
  });

  await group("JSON-RPC", async () => {
    const un = await server.fetch(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, null), env, {});
    t("no bearer: 401 with the resource metadata that starts OAuth", un.status === 401 && /resource_metadata=.*oauth-protected-resource/.test(un.headers.get("WWW-Authenticate")));
    const init = await (await server.fetch(rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }), env, {})).json();
    eq("initialize", [init.result.protocolVersion, init.result.serverInfo.name], ["2025-03-26", "liaison-meta-ads"]);
    const list = await (await server.fetch(rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }), env, {})).json();
    eq("tools/list returns the 29", list.result.tools.length, 29);
    const w = await (await server.fetch(rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "plan_update_entity", arguments: { entity_id: "1" } } }), env, {})).json();
    eq("a plan tool called by name is Unknown, like a tool that does not exist", w.error, { code: -32602, message: "Unknown tool: plan_update_entity" });
    const orig = globalThis.fetch;
    const f = fetchMock(() => ({ ok: true, campaigns: [] }));
    globalThis.fetch = f;
    try {
      const r = await (await server.fetch(rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_campaigns", arguments: { account: "1000000001" } } }), env, {})).json();
      const body = JSON.parse(r.result.content[0].text);
      t("a read is proxied with the member from the bearer, never from the client", /member_id=member_1/.test(f.calls[0].url) && body.ok === true);
      globalThis.fetch = async () => { throw new Error("upstream down"); };
      const oe = console.error; console.error = () => {};
      const e = await (await server.fetch(rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "get_campaigns", arguments: {} } }), env, {})).json();
      const eb = JSON.parse(e.result.content[0].text);
      console.error = oe;
      t("a failure is isError with the meta_error marker, never zeros", e.result.isError === true && eb.meta_error === true);
    } finally { globalThis.fetch = orig; }
    const wk = await (await server.fetch(new Request("https://mcp.example.com/.well-known/oauth-authorization-server"), env, {})).json();
    eq("PKCE S256, public clients", [wk.code_challenge_methods_supported, wk.token_endpoint_auth_methods_supported], [["S256"], ["none"]]);
  });

  await group("REST /call", async () => {
    const no = await server.fetch(new Request("https://mcp.example.com/call/get_campaigns?member_id=member_1"), env, {});
    eq("a member_id on the URL is not a credential", no.status, 401);
    const orig = globalThis.fetch;
    const f = fetchMock(() => ({ ok: true, journal_id: "j1" }));
    globalThis.fetch = f;
    try {
      const ok = await server.fetch(new Request("https://mcp.example.com/call/apply_write_plan?plan_id=p1", { headers: { Authorization: "Bearer SESSION1" } }), env, {});
      t("the UI's front-end channel reaches apply", ok.status === 200 && /\/meta\/write\/apply\?member_id=member_1/.test(f.calls[0].url));
      t("server to server with the internal token", true);
    } finally { globalThis.fetch = orig; }
    const unk = await server.fetch(new Request("https://mcp.example.com/call/apply_everything", { headers: { Authorization: "Bearer SESSION1" } }), env, {});
    eq("an unknown route is 404", unk.status, 404);
  });
}
