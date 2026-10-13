/**
 * Task classifier: what kind of task is this prompt, and how big?
 * Uses the free model (Cloudflare, ~$0.00002 per call, no on-chain payment) with a fixed
 * JSON prompt; falls back to keyword rules if the call fails or returns junk.
 */
import { z } from 'zod'
import type { ProviderAdapter, ModelRef, TaskType } from '../providers/types.js'

export const Classification = z.object({
  taskType: z.enum(['chat', 'writing', 'coding', 'research', 'translation', 'image', 'music']),
  // Small models drift on the extra fields; accept anything sensible.
  complexity: z.preprocess((v) => (String(v).toLowerCase().includes('long') ? 'long' : 'short'), z.enum(['short', 'long'])),
  language: z.preprocess((v) => (typeof v === 'string' && v ? v.slice(0, 10) : 'en'), z.string()),
  needsWeb: z.preprocess((v) => v === true || v === 'true', z.boolean()),
})
export type Classification = z.infer<typeof Classification>

const SYSTEM = `You label user requests for an AI router. Reply with ONLY a JSON object:
{"taskType": one of "chat","writing","coding","research","translation","image","music",
 "complexity": "short" or "long",
 "language": ISO 639-1 code of the user's language,
 "needsWeb": true if the answer needs current information from the web}
Rules: "image" = they want a picture generated. "music" = they want a song or audio track generated.
"research" = factual questions about the world, news, comparisons that need sources.
"coding" = code, debugging, scripts, SQL. "writing" = essays, emails, posts, stories, editing.
"translation" = translate text between languages. Otherwise "chat".
"long" = needs a detailed or multi-part answer (over ~300 words or substantial code).`

const RULES: [TaskType, RegExp][] = [
  ['image', /\b(draw|image|picture|photo|illustration|logo|poster|render|paint(ing)?|wallpaper|generate an? (image|picture))\b/i],
  ['music', /\b(song|music|beat|melody|track|instrumental|lyrics|afrobeats?|jingle)\b/i],
  ['translation', /\b(translate|translation|in (french|yoruba|igbo|hausa|spanish|german|portuguese|arabic|chinese|swahili))\b/i],
  ['coding', /\b(code|function|bug|error|stack ?trace|typescript|javascript|python|sql|regex|api|compile|refactor|react|css|html)\b|```/i],
  ['research', /\b(latest|news|today|current|price of|who is|statistics|compare|vs\.?|sources?|cite|research)\b/i],
  ['writing', /\b(write|essay|email|letter|blog|post|story|poem|caption|cover letter|rewrite|proofread|summari[sz]e)\b/i],
]

export function classifyByRules(prompt: string): Classification {
  const taskType = RULES.find(([, re]) => re.test(prompt))?.[0] ?? 'chat'
  const long = prompt.length > 600 || /\b(detailed|in depth|step[- ]by[- ]step|full|complete|comprehensive|essay|report)\b/i.test(prompt)
  return { taskType, complexity: long ? 'long' : 'short', language: 'en', needsWeb: taskType === 'research' }
}

/**
 * Rules first (instant, and right for clear-cut prompts); the model is only asked when the
 * rules fall through to 'chat', so typical /recommend latency stays well under 1.5 s.
 */
export async function classifyTask(prompt: string, free: { adapter: ProviderAdapter; model: ModelRef } | undefined): Promise<Classification & { source: 'model' | 'rules' }> {
  const rules = classifyByRules(prompt)
  if (!free || rules.taskType !== 'chat') return { ...rules, source: 'rules' }
  try {
    const res = await free.adapter.run(
      free.model,
      { kind: 'text', messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: prompt.slice(0, 2000) }], maxOutputTokens: 80 },
      { signal: AbortSignal.timeout(2_500), requestId: `classify-${Date.now()}`, maxCostMicro: 1_000n },
    )
    if (res.kind !== 'text') throw new Error('non-text')
    const json = res.text.slice(res.text.indexOf('{'), res.text.lastIndexOf('}') + 1)
    const parsed = Classification.parse(JSON.parse(json))
    // Media generation is expensive: the model alone can't turn a chat prompt into an image/music job
    // (the rules, which ran first, didn't see media words).
    if (parsed.taskType === 'image' || parsed.taskType === 'music') return { ...parsed, taskType: 'chat', source: 'model' }
    return { ...parsed, source: 'model' }
  } catch {
    return { ...rules, source: 'rules' }
  }
}
