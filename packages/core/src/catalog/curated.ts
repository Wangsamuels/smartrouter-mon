/**
 * The hand-kept catalog: which models SmartRouter offers, where each one is paid, and
 * which leaderboard entries rate it. Prices and quality scores are NOT kept here — the
 * catalog build reads them live (402 probes, OpenRouter prices, LMArena ratings).
 *
 * `verified: false` = not yet confirmed by a paid smoke-test call (gateways return a 402
 * even for unknown model ids, so a model name can only be proven by paying). Unverified
 * entries are stored inactive. Every entry below passed the paid smoke test on Oct 9, 2026
 * (scripts/smoke-providers.ts); add new models as verified: false until they do.
 */
import type { AdapterName, TaskType } from '../providers/types.js'

export type ArenaRefs = {
  /** LMArena `text` leaderboard model name (chat, writing, coding, translation). */
  text?: string
  /** LMArena `search` leaderboard name (research). Models without one are penalised for research. */
  search?: string
  /** LMArena `text_to_image` name. */
  image?: string
}

export type CuratedModel = {
  id: string
  provider: string
  adapter: AdapterName
  baseUrl: string
  modelName: string
  label: string
  taskTypes: TaskType[]
  arena?: ArenaRefs
  /** OpenRouter id for list prices (also how we check the id exists). */
  openrouterId?: string
  /** Quality when no leaderboard entry exists (0–1), e.g. Suno, FLUX schnell. */
  fallbackQuality?: number
  speed: 'fast' | 'medium' | 'slow'
  verified: boolean
  web?: boolean // grounded in live web search (research)
}

const OR = 'https://openrouter.mpp.tempo.xyz'
const TEXT: TaskType[] = ['chat', 'writing', 'coding', 'research', 'translation']

const openrouter = (id: string, label: string, arena: ArenaRefs, speed: CuratedModel['speed'], taskTypes = TEXT): CuratedModel => ({
  id: `openrouter:${id}`,
  provider: 'openrouter',
  adapter: 'openaiStyle',
  baseUrl: OR,
  modelName: id,
  label,
  taskTypes,
  arena,
  openrouterId: id,
  speed,
  verified: true, // ids checked against OpenRouter's public model list at build time
})

const locus = (provider: string, modelName: string, label: string, extra: Partial<CuratedModel>): CuratedModel => ({
  id: `${provider}:${modelName}`,
  provider,
  adapter: 'locus',
  baseUrl: `https://${provider}.mpp.paywithlocus.com`,
  modelName,
  label,
  taskTypes: TEXT,
  speed: 'medium',
  verified: true, // every Locus model below passed the paid smoke test (Oct 9)
  ...extra,
})

export const FREE_MODEL_ID = 'free:llama-3.1-8b'

export const CURATED: CuratedModel[] = [
  // ---- Text via OpenRouter (one session-capable gateway, 100+ models, cheapest per call) ----
  openrouter('anthropic/claude-opus-5.5', 'Claude Opus 5.5', { text: 'claude-opus-5.5-high' }, 'slow'),
  openrouter('anthropic/claude-sonnet-5.5', 'Claude Sonnet 5.5', { text: 'claude-sonnet-5.5-xhigh' }, 'medium'),
  openrouter('anthropic/claude-haiku-4.5', 'Claude Haiku 4.5', { text: 'claude-haiku-4-5-20251001' }, 'fast'),
  openrouter('openai/gpt-6-sol', 'GPT-6 Sol', { text: 'gpt-6-sol-max' }, 'slow'),
  openrouter('openai/gpt-6-luna', 'GPT-6 Luna', { text: 'gpt-6-luna-max' }, 'fast'),
  openrouter('openai/gpt-5.6-sol', 'GPT-5.6 Sol', { text: 'gpt-5.6-sol-xhigh' }, 'medium'),
  openrouter('google/gemini-3.8-flash', 'Gemini 3.8 Flash', { text: 'gemini-3.8-flash-high' }, 'fast'),
  openrouter('google/gemini-3.5-flash-lite', 'Gemini 3.5 Flash Lite', { text: 'gemini-3.5-flash-lite' }, 'fast'),
  openrouter('x-ai/grok-4.7', 'Grok 4.7', { text: 'grok-4.7-xhigh' }, 'medium'),
  openrouter('deepseek/deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', { text: 'deepseek-v4.1-flash-max' }, 'fast'),
  openrouter('deepseek/deepseek-v4-pro', 'DeepSeek V4 Pro', { text: 'deepseek-v4-pro' }, 'medium'),
  openrouter('moonshotai/kimi-k3', 'Kimi K3', { text: 'kimi-k3-max' }, 'medium'),
  openrouter('z-ai/glm-5.3', 'GLM 5.3', { text: 'glm-5.3-max' }, 'medium'),
  openrouter('z-ai/glm-5.3-flash', 'GLM 5.3 Flash', { text: 'glm-5.3-flash' }, 'fast'),
  openrouter('qwen/qwen3.8-max-0902', 'Qwen 3.8 Max', { text: 'qwen3.8-max' }, 'medium'),
  openrouter('meta-llama/llama-3.3-70b-instruct', 'Llama 3.3 70B', { text: 'llama-3.3-70b-instruct' }, 'fast'),
  openrouter('openai/gpt-oss-120b', 'gpt-oss-120b', { text: 'gpt-oss-120b' }, 'fast'),
  openrouter('google/gemma-4-31b-it', 'Gemma 4 31B', { text: 'gemma-4-31b' }, 'fast'),

  // ---- Direct Tempo gateways (session-capable). Ids proven by the paid smoke test. ----
  { id: 'openai:gpt-6-luna', provider: 'openai', adapter: 'openaiStyle', baseUrl: 'https://openai.mpp.tempo.xyz', modelName: 'gpt-6-luna', label: 'GPT-6 Luna (OpenAI)', taskTypes: TEXT, arena: { text: 'gpt-6-luna-max' }, speed: 'fast', verified: true },
  { id: 'openai:gpt-5.6-sol', provider: 'openai', adapter: 'openaiStyle', baseUrl: 'https://openai.mpp.tempo.xyz', modelName: 'gpt-5.6-sol', label: 'GPT-5.6 Sol (OpenAI)', taskTypes: TEXT, arena: { text: 'gpt-5.6-sol-xhigh' }, speed: 'medium', verified: true },
  { id: 'anthropic:claude-sonnet-5-5', provider: 'anthropic', adapter: 'openaiStyle', baseUrl: 'https://anthropic.mpp.tempo.xyz', modelName: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (Anthropic)', taskTypes: TEXT, arena: { text: 'claude-sonnet-5.5-xhigh' }, speed: 'medium', verified: true },
  { id: 'anthropic:claude-haiku-4-5', provider: 'anthropic', adapter: 'openaiStyle', baseUrl: 'https://anthropic.mpp.tempo.xyz', modelName: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (Anthropic)', taskTypes: TEXT, arena: { text: 'claude-haiku-4-5-20251001' }, speed: 'fast', verified: true },

  // ---- Locus gateways (charge per call, ~$0.004–0.02 floor) ----
  locus('deepseek', 'deepseek-v4-flash', 'DeepSeek V4 Flash', { arena: { text: 'deepseek-v4-flash' }, speed: 'fast' }),
  locus('deepseek', 'deepseek-v4-pro', 'DeepSeek V4 Pro', { arena: { text: 'deepseek-v4-pro' } }),
  locus('mistral', 'mistral-large-2512', 'Mistral Large 3', { arena: { text: 'mistral-large-3' } }),
  locus('mistral', 'mistral-medium-3-5', 'Mistral Medium 3.5', { fallbackQuality: 0.55, taskTypes: ['chat', 'writing', 'translation'] }),
  locus('groq', 'openai/gpt-oss-120b', 'gpt-oss-120b on Groq', { arena: { text: 'gpt-oss-120b' }, speed: 'fast' }),
  locus('perplexity', 'sonar-pro', 'Perplexity Sonar Pro', { arena: { search: 'ppl-sonar-pro-high' }, taskTypes: ['research'], web: true }),
  locus('perplexity', 'sonar', 'Perplexity Sonar', { fallbackQuality: 0.55, taskTypes: ['research'], web: true, speed: 'fast' }),

  // ---- Images ----
  { id: 'fal:flux-schnell', provider: 'fal', adapter: 'fal', baseUrl: 'https://fal.mpp.tempo.xyz', modelName: 'fal-ai/flux/schnell', label: 'FLUX.1 schnell', taskTypes: ['image'], fallbackQuality: 0.1, speed: 'fast', verified: true },
  { id: 'fal:flux-dev', provider: 'fal', adapter: 'fal', baseUrl: 'https://fal.mpp.tempo.xyz', modelName: 'fal-ai/flux/dev', label: 'FLUX.1 dev', taskTypes: ['image'], arena: { image: 'flux-1-dev-fp8' }, speed: 'medium', verified: true },
  { id: 'fal:flux-pro-1.1', provider: 'fal', adapter: 'fal', baseUrl: 'https://fal.mpp.tempo.xyz', modelName: 'fal-ai/flux-pro/v1.1', label: 'FLUX 1.1 pro', taskTypes: ['image'], arena: { image: 'flux-1.1-pro' }, speed: 'medium', verified: true },
  { id: 'stablestudio:flux-2-pro', provider: 'stablestudio', adapter: 'stableStudio', baseUrl: 'https://stablestudio.dev', modelName: 'flux-2-pro', label: 'FLUX.2 pro', taskTypes: ['image'], arena: { image: 'flux-2-pro' }, speed: 'medium', verified: true },
  { id: 'stablestudio:nano-banana-pro', provider: 'stablestudio', adapter: 'stableStudio', baseUrl: 'https://stablestudio.dev', modelName: 'nano-banana-pro', label: 'Nano Banana Pro', taskTypes: ['image'], arena: { image: 'gemini-3-pro-image-preview (nano-banana-pro)' }, speed: 'medium', verified: true },
  { id: 'stablestudio:gpt-image-2.5-flare', provider: 'stablestudio', adapter: 'stableStudio', baseUrl: 'https://stablestudio.dev', modelName: 'gpt-image-2.5-flare', label: 'GPT Image 2.5 Flare', taskTypes: ['image'], arena: { image: 'gpt-image-2.5-flare' }, speed: 'slow', verified: true },

  // ---- Music ----
  { id: 'suno:v5', provider: 'suno', adapter: 'suno', baseUrl: 'https://suno.mpp.paywithlocus.com', modelName: 'V5', label: 'Suno V5', taskTypes: ['music'], fallbackQuality: 0.9, speed: 'slow', verified: true },
  { id: 'suno:v4.5', provider: 'suno', adapter: 'suno', baseUrl: 'https://suno.mpp.paywithlocus.com', modelName: 'V4_5', label: 'Suno V4.5', taskTypes: ['music'], fallbackQuality: 0.75, speed: 'slow', verified: true },

  // ---- Free fallback (SmartRouter-sponsored, Cloudflare Workers AI) ----
  { id: FREE_MODEL_ID, provider: 'cloudflare', adapter: 'cloudflare', baseUrl: 'https://api.cloudflare.com', modelName: '@cf/meta/llama-3.1-8b-instruct-fp8-fast', label: 'Free · Llama 3.1 8B', taskTypes: ['chat', 'writing', 'coding', 'translation'], arena: { text: 'llama-3.1-8b-instruct' }, speed: 'fast', verified: true },
]
