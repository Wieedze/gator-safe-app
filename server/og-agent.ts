/**
 * 0G-driven agent harness.
 *
 * Gives a 0G Compute model a shell and the hourglass-agent skill, and lets it drive a
 * limit order to completion. The model is the brain; this file is the hands.
 *
 * Why this is safe enough to demo, and where it is not:
 *
 * The mandate's on-chain caveats bound what any redeem can do — `erc20BalanceChange`
 * Decrease caps the spend, the Increase bound is the price floor, `limitedCalls(1)`
 * allows exactly one fill. A confused or prompt-injected model cannot exceed the cap,
 * touch a different token, or drain the Safe. That is the property this harness exists
 * to demonstrate.
 *
 * Those caveats protect the SAFE. They do not protect this process. The shell is bounded
 * by nothing, and this container holds the agent key. So it must run as a throwaway with
 * nothing else in it and only enough ETH for one redeem. Never give this harness a key
 * that guards anything but the gas it spends.
 *
 * Run: OG_ROUTER_API_KEY=sk-... AGENT_PRIVATE_KEY=0x... UNISWAP_API_KEY=... \
 *      bun server/og-agent.ts <instruction.json>
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const ROUTER_URL = process.env.OG_ROUTER_URL ?? 'https://router-api.0g.ai/v1'
const MODEL = process.env.OG_MODEL ?? '0gm-1.0-35b-a3b'
const SKILL_PATH = process.env.SKILL_PATH ?? 'skills/hourglass-agent/SKILL.md'
const WORKDIR = process.env.AGENT_WORKDIR ?? 'skills/hourglass-agent/scripts'
const MAX_STEPS = Number(process.env.AGENT_MAX_STEPS ?? '40')
const COMMAND_TIMEOUT_MS = Number(process.env.AGENT_COMMAND_TIMEOUT_MS ?? '900000')

const apiKey = process.env.OG_ROUTER_API_KEY

interface ToolCall {
  id: string
  function: { name: string; arguments: string }
}
interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description:
        'Run a shell command in the agent working directory and return its stdout, stderr and exit code. ' +
        'Use it to install dependencies, inspect files, create a wallet, and run the limit-order runner.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to run.' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'done',
      description: 'Call when the order has filled, or when you cannot proceed. Ends the run.',
      parameters: {
        type: 'object',
        properties: {
          outcome: { type: 'string', enum: ['filled', 'blocked'] },
          detail: { type: 'string', description: 'One sentence on what happened.' },
        },
        required: ['outcome', 'detail'],
      },
    },
  },
]

async function runBash(command: string): Promise<string> {
  const proc = Bun.spawn(['bash', '-lc', command], {
    cwd: resolve(WORKDIR),
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  })
  const timer = setTimeout(() => proc.kill(), COMMAND_TIMEOUT_MS)
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const code = await proc.exited
  clearTimeout(timer)
  // Truncate hard: a runaway command must not blow the context window.
  const clip = (s: string): string => (s.length > 4000 ? `${s.slice(0, 4000)}\n…[truncated]` : s)
  return `exit=${code}\n--- stdout ---\n${clip(stdout)}\n--- stderr ---\n${clip(stderr)}`
}

interface Completion {
  choices?: { message?: Message; finish_reason?: string }[]
  error?: { message?: string }
}

async function complete(key: string, messages: Message[]): Promise<Message> {
  const res = await fetch(`${ROUTER_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: MODEL, messages, tools: TOOLS, tool_choice: 'auto', temperature: 0 }),
  })
  if (!res.ok) throw new Error(`0G Router ${res.status}: ${(await res.text()).slice(0, 400)}`)
  const body = (await res.json()) as Completion
  const message = body.choices?.[0]?.message
  if (!message) throw new Error(`0G Router returned no message: ${JSON.stringify(body).slice(0, 300)}`)
  return message
}

function systemPrompt(skill: string, instruction: string): string {
  return `${skill}

---

You are operating this skill autonomously.

Your shell ALREADY starts in the runner directory, which contains run-limit-order.ts,
run-dca.ts and package.json. Do not cd anywhere, do not search the filesystem for it, and
do not guess absolute paths — run 'ls' first and work with relative paths from there.

There is no human to hand anything back to: the wallet is already funded and the mandate
is already signed to it, so skip every step that asks the operator to act.

Your job: install dependencies if needed, then run the limit-order runner against the
instruction below and report what happened. Prefer running the bundled runner over
reimplementing its logic.

The environment already carries AGENT_PRIVATE_KEY, UNISWAP_API_KEY and INTUITION_NETWORK.
Never print, copy or transmit AGENT_PRIVATE_KEY.

Call done() when the order fills or when you are blocked. Do not loop forever.

Instruction (also on disk as instruction.json):
${instruction}`
}

async function main(): Promise<void> {
  const [instructionPath] = process.argv.slice(2)
  if (!apiKey) throw new Error('OG_ROUTER_API_KEY is not set')
  if (!instructionPath) throw new Error('usage: bun server/og-agent.ts <instruction.json>')
  if (!existsSync(instructionPath)) throw new Error(`instruction not found: ${instructionPath}`)
  if (!existsSync(SKILL_PATH)) throw new Error(`skill not found: ${SKILL_PATH}`)

  const skill = readFileSync(SKILL_PATH, 'utf8')
  const instruction = readFileSync(instructionPath, 'utf8')

  const messages: Message[] = [
    { role: 'system', content: systemPrompt(skill, instruction) },
    { role: 'user', content: 'Run the limit order described in the instruction. Begin.' },
  ]

  console.log(`og-agent → ${MODEL} @ ${ROUTER_URL}, cwd=${WORKDIR}, max ${MAX_STEPS} steps`)

  for (let step = 1; step <= MAX_STEPS; step += 1) {
    const message = await complete(apiKey, messages)
    messages.push(message)

    if (message.content) console.log(`\n[${step}] ${message.content}`)

    const calls = message.tool_calls ?? []
    if (calls.length === 0) {
      console.log(`\n[${step}] no tool call — ending run`)
      return
    }

    for (const call of calls) {
      const args = JSON.parse(call.function.arguments) as Record<string, unknown>

      if (call.function.name === 'done') {
        console.log(`\ndone: ${String(args.outcome)} — ${String(args.detail)}`)
        return
      }

      if (call.function.name !== 'bash' || typeof args.command !== 'string') {
        messages.push({ role: 'tool', tool_call_id: call.id, content: `unknown tool call` })
        continue
      }

      console.log(`\n[${step}] $ ${args.command}`)
      const output = await runBash(args.command)
      console.log(output)
      messages.push({ role: 'tool', tool_call_id: call.id, content: output })
    }
  }

  console.log(`\nstopped: reached ${MAX_STEPS} steps without done()`)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
