// magpie-community/plugins#86: a Go request to /alpha/generate said the
// user's home as the working directory, outside a git repository, whatever
// folder the agent worked in. The folder and the repository are the
// agent's as magpie tells them (x-magpie-work-dir, percent-encoded, and
// x-magpie-work-git), which go to no vendor; untold, the config is the
// CLI's in the user's home, as before.
import { afterEach, expect, test } from "bun:test"
import { homedir } from "node:os"
import { CommandCodePlugin, _internal } from "./index.mjs"

const real = globalThis.fetch
afterEach(() => {
  globalThis.fetch = real
  _internal.subsSeen.clear()
})

const finish = JSON.stringify({ type: "finish", finishReason: "stop", totalUsage: { inputTokens: 3, outputTokens: 1 } })

function setUp() {
  const sent = []
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(String(url)).pathname
    sent.push({ path, headers: new Headers(init.headers), body: init.body })
    if (path === "/alpha/generate") return new Response(JSON.stringify({ type: "text-delta", text: "hi" }) + "\n" + finish + "\n")
    if (path.startsWith("/provider/")) return Response.json({ choices: [] })
    return new Response("", { status: 404 })
  }
  return sent
}

async function ask(plan, place) {
  const hooks = await CommandCodePlugin({ client: { auth: { set: async () => {} } } })
  const opts = await hooks.auth.loader(async () => ({ type: "api", key: "k", metadata: { plan } }))
  const headers = {}
  if (place.dir !== undefined) headers["x-magpie-work-dir"] = place.dir
  if (place.git !== undefined) headers["x-magpie-work-git"] = place.git
  return opts.fetch("https://api.commandcode.ai/provider/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "deepseek/deepseek-v4-pro", messages: [{ role: "user", content: "hi" }] }),
  })
}

const config = (sent) => JSON.parse(sent.find((s) => s.path === "/alpha/generate").body).config

test("a Go request says the agent's folder and repository as magpie tells them (#86)", async () => {
  const dir = "C:\\Users\\me\\My Proj 中文 & <x>"
  let sent = setUp()
  expect((await ask("Go", { dir: encodeURIComponent(dir), git: "yes" })).status).toBe(200)
  expect(config(sent)).toMatchObject({ workingDir: dir, isGitRepo: true })
  for (const s of sent) {
    expect(s.headers.has("x-magpie-work-dir")).toBe(false)
    expect(s.headers.has("x-magpie-work-git")).toBe(false)
  }
  sent = setUp()
  await ask("Go", { dir: encodeURIComponent("/Users/me/notes"), git: "no" })
  expect(config(sent)).toMatchObject({ workingDir: "/Users/me/notes", isGitRepo: false })
  // a folder whose repository magpie doesn't know isn't said to be one
  sent = setUp()
  await ask("Go", { dir: encodeURIComponent("/srv/x") })
  expect(config(sent)).toMatchObject({ workingDir: "/srv/x", isGitRepo: false })
  // untold: the CLI's own config outside a project; a git word alone
  // means nothing
  sent = setUp()
  await ask("Go", { git: "yes" })
  expect(config(sent)).toMatchObject({ workingDir: homedir(), isGitRepo: false })
})

test("magpie's word on the folder goes to no vendor on the Provider API either", async () => {
  const sent = setUp()
  await ask("Pro", { dir: "%2Fx", git: "no" })
  const p = sent.find((s) => s.path.startsWith("/provider/"))
  expect(p.headers.has("x-magpie-work-dir")).toBe(false)
  expect(p.headers.has("x-magpie-work-git")).toBe(false)
})
