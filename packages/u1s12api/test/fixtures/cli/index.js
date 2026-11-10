// Offline child-process fixture: accepts the CLI's print arguments or piped stdin.
const args = process.argv.slice(2)
let input = ""
process.stdin.setEncoding("utf8")
for await (const chunk of process.stdin) input += chunk
const prompt = input || args[args.indexOf("-p") + 1] || ""
if (prompt.includes("FIXTURE_FAIL")) {
  console.error("fixture upstream failure")
  process.exitCode = 9
} else if (!prompt.includes("FIXTURE_EMPTY")) {
  await new Promise((resolve) => setTimeout(resolve, prompt.includes("FIXTURE_SLOW") ? 500 : 40))
  process.stdout.write(JSON.stringify({ prompt, args, pid: process.pid }) + "\n")
}
