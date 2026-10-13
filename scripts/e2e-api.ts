/**
 * End-to-end check of the HTTP API with a throwaway wallet:
 *   API_URL=http://localhost:3000 pnpm e2e:api
 * sign-in (SIWE) → /me → /catalog → POST /chats → /chats/:id/quote (same model, switch, media) → list/read.
 */
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'

const API = process.env.API_URL ?? 'http://localhost:3000'
const ORIGIN = process.env.APP_ORIGIN ?? 'http://localhost:5173'
let cookie = ''

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', origin: ORIGIN, ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const set = res.headers.get('set-cookie')
  if (set) cookie = set.split(';')[0]!
  const json: any = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`)
  return json
}
const step = (name: string, data: unknown) => console.log(`\n✔ ${name}\n${JSON.stringify(data, null, 2).slice(0, 1200)}`)

const account = privateKeyToAccount(generatePrivateKey())
const { message } = await call('POST', '/auth/challenge', { address: account.address, origin: ORIGIN })
const signature = await account.signMessage({ message })
step('sign-in', await call('POST', '/auth/verify', { message, signature }))
step('me', await call('GET', '/me'))
const cat = await call('GET', '/catalog?taskType=writing')
step('catalog (writing)', { count: cat.models.length, first: cat.models[0], attribution: cat.attribution })

const created = await call('POST', '/chats', { description: 'Write a short, warm thank-you email to my landlord in Lagos for fixing the generator quickly.' })
step('new chat from a description', created)

const q1 = await call('POST', `/chats/${created.chatId}/quote`, { prompt: 'Make it a bit more formal.' })
step('quote, current model', q1)
const cheap = created.options.find((o: any) => !o.free && o.modelId !== q1.modelId)
const q2 = await call('POST', `/chats/${created.chatId}/quote`, { prompt: 'Make it a bit more formal.', modelId: cheap?.modelId })
step('quote after switching model', q2)
const q3 = await call('POST', `/chats/${created.chatId}/quote`, { prompt: 'Now draw a small illustration of a generator with a thank-you note.' })
step('media turn inside the chat', q3)
const q4 = await call('POST', `/chats/${created.chatId}/quote`, { prompt: 'Can you fix this python error: KeyError when reading my CSV?' })
step('different-task turn → suggestion', q4)
const qf = await call('POST', `/chats/${created.chatId}/quote`, { prompt: 'Shorter please', modelId: 'free:llama-3.1-8b' })
step('free model quote', qf)

const typed = await call('POST', '/chats', { taskType: 'coding', slider: 'cheapest' })
step('new chat from a category', typed)
step('chat list', await call('GET', '/chats'))
step('chat read', await call('GET', `/chats/${created.chatId}`))
step('recommend (one-off)', await call('POST', '/recommend', { prompt: 'What are the latest naira to dollar rates and why did they move this week?' }))
step('waitlist', await call('POST', '/waitlist', { email: 'test@example.com', interest: 'naira', country: 'ng' }))
console.log('\nE2E OK')
