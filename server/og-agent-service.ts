/**
 * Agent provisioning + execution service.
 *
 * Carries the "Execute with an agent" flow the Limit order tab triggers, in the order
 * the chain forces:
 *
 *   POST /provision            -> a wallet is created, its address returned
 *   (operator signs the mandate to that address, from the Safe)
 *   (operator funds that address with gas, a separate Safe transaction — ADR 0007)
 *   POST /runs/:id/start       -> the 0G agent drives the order to a fill
 *   GET  /runs/:id             -> state and log tail
 *
 * Provision must come first: the mandate's delegate IS the agent address, so it has to
 * exist before there is anything to sign. Funding must come after signing, so gas is
 * only committed to a mandate that exists.
 *
 * The key is generated here rather than by the model. The model's job is the part that
 * needs judgement — reading the market and deciding to fill; a keypair is one deterministic
 * call, and routing it through a shell would add latency and failure modes to a step with
 * no decision in it. Set AGENT_WALLET_BY_MODEL=1 to hand that step to the model instead.
 *
 * Hourglass holds these keys. That is a deliberate reversal of the skill's non-custodial
 * stance, taken to remove friction for the DAO, and it is bounded: the mandate's caveats
 * cap what any of them can do. Give each run only enough ETH for one redeem.
 *
 * Run: OG_ROUTER_API_KEY=sk-... UNISWAP_API_KEY=... bun server/og-agent-service.ts
 */
import { mkdirSync, existsSync, writeFileSync, readFileSync, cpSync, symlinkSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createPublicClient, http, isAddress, isHex, type Address, type Hex } from 'viem'
import { base, mainnet } from 'viem/chains'
import { isOriginAllowed, parseAllowedOrigins } from './cors'

const RUNS_DIR = resolve(process.env.AGENT_RUNS_DIR ?? '.agent-runs')
const SCRIPTS_DIR = resolve(process.env.AGENT_SCRIPTS_DIR ?? 'skills/hourglass-agent/scripts')
const port = Number(process.env.OG_AGENT_PORT ?? '8789')
const allowedOriginPatterns = parseAllowedOrigins(process.env.ALLOWED_ORIGIN)

const routerKey = process.env.OG_ROUTER_API_KEY
const uniswapKey = process.env.UNISWAP_API_KEY

const CHAINS = { [base.id]: base, [mainnet.id]: mainnet } as const

type RunState = 'provisioned' | 'running' | 'filled' | 'blocked' | 'failed'

interface Run {
  id: string
  address: Address
  privateKey: Hex
  state: RunState
  detail: string | null
  startedAt: string | null
  chainId: number | null
}

const runs = new Map<string, Run>()

function runDir(id: string): string {
  return join(RUNS_DIR, id)
}

/** Per-run working directory, so two runs never share an instruction.json. */
function prepareRunDir(id: string): string {
  const dir = runDir(id)
  mkdirSync(dir, { recursive: true })
  for (const file of ['run-limit-order.ts', 'run-dca.ts', 'package.json']) {
    const src = join(SCRIPTS_DIR, file)
    if (existsSync(src)) cpSync(src, join(dir, file))
  }
  // Reuse the already-installed dependencies rather than reinstalling per run.
  const modules = join(dir, 'node_modules')
  if (!existsSync(modules) && existsSync(join(SCRIPTS_DIR, 'node_modules'))) {
    symlinkSync(join(SCRIPTS_DIR, 'node_modules'), modules, 'dir')
  }
  return dir
}

function provision(): Run {
  const privateKey = generatePrivateKey()
  const address = privateKeyToAccount(privateKey).address
  const id = address.slice(2, 10).toLowerCase()
  const run: Run = { id, address, privateKey, state: 'provisioned', detail: null, startedAt: null, chainId: null }
  runs.set(id, run)
  prepareRunDir(id)
  return run
}

interface Instruction {
  hourglassStrategy: string
  chainId: number
  agent: string
  delegationHash: string
}

function parseInstruction(raw: unknown, expected: Address): Instruction {
  if (typeof raw !== 'object' || raw === null) throw new Error('instruction must be an object')
  const i = raw as Record<string, unknown>
  if (i.hourglassStrategy !== 'limitOrder') throw new Error('only limitOrder is supported')
  if (!Number.isInteger(i.chainId) || !(i.chainId as number in CHAINS)) {
    throw new Error(`unsupported chainId (expected ${Object.keys(CHAINS).join(' or ')})`)
  }
  if (typeof i.agent !== 'string' || !isAddress(i.agent)) throw new Error('invalid agent address')
  if (i.agent.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`instruction agent ${i.agent} is not this run's address ${expected}`)
  }
  if (typeof i.delegationHash !== 'string' || !isHex(i.delegationHash)) throw new Error('invalid delegationHash')
  return i as unknown as Instruction
}

/** The balance gate: a run cannot start on an unfunded agent — it would only burn steps. */
async function assertFunded(address: Address, chainId: number): Promise<bigint> {
  const chain = CHAINS[chainId as keyof typeof CHAINS]
  const client = createPublicClient({ chain, transport: http() })
  const balance = await client.getBalance({ address })
  if (balance === 0n) throw new Error(`agent ${address} holds no gas on chain ${chainId} — fund it first`)
  return balance
}

function launch(run: Run, instruction: Instruction): void {
  const dir = runDir(run.id)
  writeFileSync(join(dir, 'instruction.json'), JSON.stringify(instruction, null, 2))
  const logPath = join(dir, 'agent.log')
  const log = Bun.file(logPath)

  const proc = Bun.spawn(
    ['bun', 'server/og-agent.ts', join(dir, 'instruction.json')],
    {
      cwd: resolve('.'),
      env: {
        ...process.env,
        AGENT_PRIVATE_KEY: run.privateKey,
        AGENT_WORKDIR: dir,
        INTUITION_NETWORK: process.env.INTUITION_NETWORK ?? 'mainnet',
      },
      stdout: log.writer(),
      stderr: log.writer(),
    },
  )

  run.state = 'running'
  run.startedAt = new Date().toISOString()
  run.chainId = instruction.chainId

  void proc.exited.then((code) => {
    const tail = existsSync(logPath) ? readFileSync(logPath, 'utf8') : ''
    if (tail.includes('done: filled')) {
      run.state = 'filled'
    } else if (tail.includes('done: blocked')) {
      run.state = 'blocked'
    } else {
      run.state = code === 0 ? 'blocked' : 'failed'
    }
    const match = tail.match(/done: \w+ — (.*)/)
    run.detail = match?.[1]?.slice(0, 400) ?? `exited with code ${code}`
  })
}

function logTail(id: string, lines = 40): string {
  const path = join(runDir(id), 'agent.log')
  if (!existsSync(path)) return ''
  return readFileSync(path, 'utf8').split('\n').slice(-lines).join('\n')
}

function view(run: Run): Record<string, unknown> {
  return {
    id: run.id,
    agentAddress: run.address,
    state: run.state,
    detail: run.detail,
    startedAt: run.startedAt,
    chainId: run.chainId,
    log: logTail(run.id),
  }
}

function cors(origin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }
  if (origin && isOriginAllowed(origin, allowedOriginPatterns)) {
    headers['Access-Control-Allow-Origin'] = origin
    headers.Vary = 'Origin'
  }
  return headers
}

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), { status, headers: cors(origin) })
}

const ready = routerKey !== undefined && uniswapKey !== undefined

Bun.serve({
  port,
  async fetch(req) {
    const origin = req.headers.get('Origin')
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) })
    const url = new URL(req.url)
    const parts = url.pathname.split('/').filter(Boolean)

    if (req.method === 'GET' && url.pathname === '/health') {
      const missing = [
        routerKey ? null : 'OG_ROUTER_API_KEY',
        uniswapKey ? null : 'UNISWAP_API_KEY',
      ].filter((v): v is string => v !== null)
      return json({ ok: true, ready, missing, runs: runs.size }, 200, origin)
    }

    if (req.method === 'POST' && url.pathname === '/provision') {
      if (!ready) return json({ error: 'not configured' }, 503, origin)
      const run = provision()
      return json({ id: run.id, agentAddress: run.address, state: run.state }, 200, origin)
    }

    if (parts[0] === 'runs' && parts[1]) {
      const run = runs.get(parts[1])
      if (!run) return json({ error: 'run not found' }, 404, origin)

      if (req.method === 'GET' && parts.length === 2) return json(view(run), 200, origin)

      if (req.method === 'POST' && parts[2] === 'start') {
        if (run.state === 'running') return json({ error: 'already running' }, 409, origin)
        try {
          const body = (await req.json()) as { instruction?: unknown }
          const instruction = parseInstruction(body.instruction, run.address)
          const balance = await assertFunded(run.address, instruction.chainId)
          launch(run, instruction)
          return json({ ...view(run), balance: balance.toString() }, 200, origin)
        } catch (err) {
          return json({ error: err instanceof Error ? err.message : 'start failed' }, 400, origin)
        }
      }
    }

    return json({ error: 'not found' }, 404, origin)
  },
})

mkdirSync(RUNS_DIR, { recursive: true })
console.log(
  ready
    ? `og-agent-service on :${port} — runs in ${RUNS_DIR}`
    : `og-agent-service on :${port} — NOT READY (need OG_ROUTER_API_KEY and UNISWAP_API_KEY)`,
)
