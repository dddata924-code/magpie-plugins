// An account taken from the CLI's sign-in uses the key the CLI has now, as
// magpie's built-in re-reads ~/.commandcode/auth.json: a `commandcode
// login` since changes it. Others keep the key they were saved with.
// Run with HOME a scratch folder (as `HOME=$(mktemp -d) bun test`).
import { expect, test } from "bun:test"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { _internal } from "./index.mjs"

const home = homedir()

test.skipIf(existsSync(join(home, ".commandcode")))("the CLI's account follows the CLI's key; a pasted key stays", async () => {
  const cli = { type: "api", key: "saved", metadata: { cli: true } }
  expect(await _internal.liveKey(cli)).toBe("saved") // the CLI signed out: the saved one
  mkdirSync(join(home, ".commandcode"))
  writeFileSync(join(home, ".commandcode", "auth.json"), JSON.stringify({ apiKey: "rotated" }))
  expect(await _internal.liveKey(cli)).toBe("rotated")
  expect(await _internal.liveKey({ type: "api", key: "pasted", metadata: {} })).toBe("pasted")
})
