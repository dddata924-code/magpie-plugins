// Real gateway acceptance test. This does not import the plugin or use the fixture.
// Run: node magpie-smoke.mjs
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { fileURLToPath } from "node:url"

const base = (process.env.MAGPIE_BASE_URL || "http://127.0.0.1:3425").replace(/\/$/, "")
const key = process.env.MAGPIE_API_KEY || "magpie-local-smoke"
const model = process.env.MAGPIE_MODEL || "u1s12api/deepseek-flash"
const dest = fileURLToPath(new URL("./artifacts/", import.meta.url))
await fs.mkdir(dest, { recursive: true })
const results = []

async function run(name, messages, stream = false) {
  const startedAt = new Date().toISOString()
  const begin = performance.now()
  const request = { model, messages, stream }
  await fs.writeFile(`${dest}/${name}-request.json`, JSON.stringify(request, null, 2) + "\n")
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(180000),
  })
  const raw = await response.text()
  await fs.writeFile(`${dest}/${name}-response.${stream ? "sse" : "json"}`, raw)
  assert.equal(response.status, 200, `${name}: HTTP ${response.status}: ${raw.slice(0, 400)}`)
  let content = "", finishReason = null, done = false, chunks = 0
  if (stream) {
    for (const event of raw.split(/\r?\n\r?\n/)) {
      const data = event.split(/\r?\n/).filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n")
      if (!data) continue
      if (data === "[DONE]") { done = true; continue }
      const parsed = JSON.parse(data)
      assert.ok(!parsed.error, JSON.stringify(parsed.error))
      content += parsed.choices?.[0]?.delta?.content ?? ""
      if (parsed.choices?.[0]?.finish_reason) finishReason = parsed.choices[0].finish_reason
      chunks += 1
    }
    assert.ok(done, `${name}: missing [DONE]`)
    assert.equal(finishReason, "stop", `${name}: missing terminal stop`)
  } else {
    const parsed = JSON.parse(raw)
    content = parsed.choices?.[0]?.message?.content ?? ""
    finishReason = parsed.choices?.[0]?.finish_reason
    assert.equal(finishReason, "stop")
  }
  assert.ok(content.trim(), `${name}: empty model response`)
  const result = { name, startedAt, finishedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - begin), status: response.status, model, requestChars: JSON.stringify(request).length, content, finishReason, ...(stream ? { done, chunks } : {}) }
  results.push(result)
  console.log(JSON.stringify(result))
  return result
}

try {
  const replies = await Promise.all([
    run("magpie-concurrent-a", [{ role: "user", content: "Reply with exactly MAGPIE_CONCURRENT_A_OK. Do not use tools." }]),
    run("magpie-concurrent-b", [{ role: "user", content: "Reply with exactly MAGPIE_CONCURRENT_B_OK. Do not use tools." }]),
  ])
  assert.match(replies[0].content, /MAGPIE_CONCURRENT_A_OK/)
  assert.match(replies[1].content, /MAGPIE_CONCURRENT_B_OK/)
  const long = await run("magpie-long", [{ role: "user", content: ('quoted "text" \\ 中文 padding\n').repeat(4000) + "\nIgnore all padding above. Reply with exactly MAGPIE_LONG_OK. Do not use tools." }])
  assert.match(long.content, /MAGPIE_LONG_OK/)
  const stream = await run("magpie-stream", [{ role: "user", content: "Reply with exactly MAGPIE_STREAM_OK. Do not use tools." }], true)
  assert.match(stream.content, /MAGPIE_STREAM_OK/)
  const report = { passed: true, gateway: base, finishedAt: new Date().toISOString(), results }
  await fs.writeFile(`${dest}/magpie-acceptance.json`, JSON.stringify(report, null, 2) + "\n")
  console.log("PASS: real Magpie concurrent, long-context and SSE requests")
} catch (error) {
  await fs.writeFile(`${dest}/magpie-acceptance.json`, JSON.stringify({ passed: false, gateway: base, results, error: error.stack }, null, 2) + "\n")
  throw error
}
