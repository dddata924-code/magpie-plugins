// yetone/magpie#899: DeepSeek V4.1 Flash, Kimi K3 (Fireworks) and GLM-5.2
// (Baseten) stop thinking at reasoning_effort "none", droid 0.231.0's
// "off"; offered only low/high/max, a request turning reasoning off was
// asked for low, and they thought anyway. GLM-5.3 and GLM-5.3-Flash can't
// (Fireworks: "Reasoning is mandatory"): low stays their least. The cases
// are the built-in's TestFactoryThinkingOff.
import { afterEach, expect, test } from "bun:test"
import { FactoryAuthPlugin } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => (globalThis.fetch = real))

test("the models that can stop thinking offer none, the others don't", async () => {
  const hooks = await FactoryAuthPlugin({ client: { auth: { set: async () => {} } } })
  const cfg = { provider: {} }
  await hooks.config(cfg)
  const levels = (id) => Object.keys(cfg.provider.factory.models[id].variants)
  expect(levels("deepseek-v4.1-flash")).toEqual(["none", "low", "high", "max"])
  expect(levels("kimi-k3")).toEqual(["none", "low", "high", "max"])
  expect(levels("glm-5.2")).toEqual(["none", "high", "max"])
  expect(cfg.provider.factory.models["kimi-k3"].variants.none).toEqual({ reasoningEffort: "none" })
  for (const id of ["glm-5.3", "glm-5.3-flash", "qwen3.8-max", "minimax-m3"]) expect(levels(id)).not.toContain("none")
})

test("none is sent on to Factory as it was asked", async () => {
  const sent = []
  globalThis.fetch = async (url, init = {}) => {
    if (new URL(String(url)).pathname === "/api/cli/whoami") return new Response(JSON.stringify({ userId: "u", orgId: "fac_D", email: "d@example.com", region: "" }))
    sent.push(init.body)
    return new Response('{"id":"ok"}')
  }
  let saved = { type: "oauth", access: "tok", refresh: "r", expires: Date.now() + 3_600_000, accountId: "d@example.com", activeOrganizationId: "fac_D", region: "", premBaseHost: "" }
  const hooks = await FactoryAuthPlugin({ client: { auth: { set: async ({ body }) => (saved = body) } } })
  const l = await hooks.auth.loader(async () => saved)
  const res = await l.fetch("https://api.factory.ai/api/llm/o/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: `{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"hi"}],"reasoning_effort":"none"}`,
  })
  expect(res.status).toBe(200)
  expect(JSON.parse(sent.at(-1)).reasoning_effort).toBe("none")
})
