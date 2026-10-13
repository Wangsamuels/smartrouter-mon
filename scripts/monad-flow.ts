/**
 * End-to-end payment flow on Monad against a running API (testnet first):
 *
 *   API_URL=https://smartrouter-mon-….herokuapp.com APP_ORIGIN=https://your-frontend \
 *   TEST_USER_PRIVATE_KEY=0x…   (a test wallet holding ≥ $1 testnet USDC — no MON needed) \
 *   pnpm monad:flow
 *
 * sign-in (SIWE) → register a spending key + caps (one signature, relayed) → gasless top-up
 * (ERC-3009, relayed) → recommend (Qwen agent or scorer) → /run: 402 with the voucher to sign →
 * sign with the spending key → answer streams → signed thumbs-up → return the unused balance.
 * The key is read from the environment only; the script never prints it.
 */
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { RATING_TYPES, ledgerDomain } from '@smartrouter/shared'

const API = process.env.API_URL ?? 'http://localhost:3000'
const ORIGIN = process.env.APP_ORIGIN ?? 'http://localhost:5173'
const KEY = process.env.TEST_USER_PRIVATE_KEY as `0x${string}` | undefined
if (!KEY) throw new Error('Set TEST_USER_PRIVATE_KEY (a testnet wallet with testnet USDC)')
const TOPUP_USD = Number(process.env.TOPUP_USD ?? 0.5)

let token = ''
async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', origin: ORIGIN, ...(token ? { 'x-session-token': token } : {}), ...headers },
    body: body ? JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) : undefined,
  })
  const json: any = await res.json().catch(() => ({}))
  return { status: res.status, json, res }
}
async function ok(method: string, path: string, body?: unknown) {
  const r = await call(method, path, body)
  if (r.status >= 300) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(r.json)}`)
  return r.json
}
const step = (name: string, data: unknown) => console.log(`\n✔ ${name}\n${JSON.stringify(data, null, 2).slice(0, 1500)}`)
const big = (m: Record<string, unknown>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, typeof v === 'string' && /^\d+$/.test(v) ? BigInt(v) : v]))

const user = privateKeyToAccount(KEY)
const spendingKey = privateKeyToAccount(generatePrivateKey()) // what the browser would hold

// 1. sign in
const { message } = await ok('POST', '/auth/challenge', { address: user.address, origin: ORIGIN })
const signIn = await ok('POST', '/auth/verify', { message, signature: await user.signMessage({ message }) })
token = signIn.token
step('signed in', { address: signIn.address })

// 2. spending key + caps
const setup = await ok('GET', `/wallet/setup?signer=${spendingKey.address}`)
const setupMsg = big({ ...setup.message, signer: spendingKey.address })
const setupSig = await user.signTypedData({ domain: setup.domain, types: setup.types, primaryType: 'Setup', message: setupMsg as never })
step('spending key registered (relayed, no gas)', await ok('POST', '/wallet/setup', { ...setup.message, signer: spendingKey.address, signature: setupSig }))

// 3. gasless top-up
const auth = await ok('POST', '/wallet/deposit/authorization', { amountUsd: TOPUP_USD })
const depSig = await user.signTypedData({ domain: auth.domain, types: auth.types, primaryType: 'ReceiveWithAuthorization', message: big(auth.message) as never })
step('AI balance topped up (relayed, no gas)', await ok('POST', '/wallet/deposit', { ...auth.message, signature: depSig }))

// 4. recommend
const rec = await ok('POST', '/recommend', { prompt: 'Write a two-sentence product description for a solar lantern.', slider: 'cheapest' })
step('recommendation', { router: rec.router, options: rec.options.map((o: any) => ({ modelId: o.modelId, priceUsd: o.priceUsd, reason: o.reason })) })
const pick = rec.options.find((o: any) => !o.free && o.quoteId)
if (!pick) throw new Error('no paid option quoted')
const prompt = 'Write a two-sentence product description for a solar lantern.'

// 5. run: first call returns the voucher to sign
const first = await call('POST', '/run', { quoteId: pick.quoteId, prompt })
if (first.status !== 402 || first.json.code !== 'PAYMENT_REQUIRED') throw new Error(`expected 402 PAYMENT_REQUIRED, got ${first.status} ${JSON.stringify(first.json)}`)
const v = first.json.details.voucher
const voucherSig = await spendingKey.signTypedData({ domain: v.domain, types: v.types, primaryType: 'Voucher', message: big(v.message) as never })
const header = Buffer.from(JSON.stringify({ cumulativeAmount: v.message.cumulativeAmount, signature: voucherSig })).toString('base64')
const run = await fetch(API + '/run', { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, 'x-session-token': token, 'x-smartrouter-voucher': header }, body: JSON.stringify({ quoteId: pick.quoteId, prompt }) })
if (!run.ok) throw new Error(`/run → ${run.status} ${await run.text()}`)
const text = await run.text()
const events = text.split('\n\n').filter((b) => b.startsWith('event:')).map((b) => ({ event: b.split('\n')[0]!.slice(7), data: JSON.parse(b.split('\n').find((l) => l.startsWith('data:'))!.slice(5)) }))
const meta = events.find((e) => e.event === 'meta')?.data
const done = events.find((e) => e.event === 'done' || e.event === 'error')
step('answer', { meta: { requestId: meta?.requestId, priceUsd: meta?.priceUsd, routeHash: meta?.routeHash, remainingUsd: meta?.remainingUsd }, end: done?.event, text: done?.data?.text?.slice(0, 300), message: done?.data?.message })

// 6. signed thumbs-up (relayed to the ledger by the worker)
if (done?.event === 'done') {
  const ledger = await ok('GET', '/ledger')
  if (ledger.ledger) {
    const requestId = `0x${String(meta.requestId).replace(/-/g, '')}` as `0x${string}`
    const sig = await spendingKey.signTypedData({ domain: ledgerDomain(ledger.chainId, ledger.ledger), types: RATING_TYPES, primaryType: 'Rating', message: { requestId, score: 1 } })
    step('rated (signed)', await ok('POST', '/feedback', { requestId: meta.requestId, rating: 1, signature: sig }))
  }
}

// 7. balance, then return the rest
step('session', (await ok('GET', '/sessions/current')).session)
console.log('\nWaiting 10 s so the answer is no longer in flight…')
await new Promise((r) => setTimeout(r, 10_000))
step('returned unused balance', await ok('POST', '/wallet/locked/return'))
step('activity', (await ok('GET', '/wallet/activity')).items.slice(0, 6))
