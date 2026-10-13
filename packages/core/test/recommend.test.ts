import { describe, expect, it } from 'vitest'
import { buildContext, classifyByRules, estimateCostMicro, fraction, rankModels, userPriceMicro } from '../src/index.js'

describe('userPriceMicro', () => {
  it('adds the fee and rounds up to $0.0001', () => {
    expect(userPriceMicro(750n, 10)).toBe(900n) // 825 → 900
    expect(userPriceMicro(1000n, 10)).toBe(1100n)
    expect(userPriceMicro(0n, 10)).toBe(100n) // never below $0.0001
  })
})

describe('estimateCostMicro', () => {
  it('scales text by size with a 60% floor, media is flat', () => {
    expect(estimateCostMicro(10_000n, 'image', 99_999, 99_999)).toBe(10_000n)
    expect(estimateCostMicro(10_000n, 'chat', 1, 1)).toBe(6_000n)
    expect(estimateCostMicro(10_000n, 'chat', 20_000, 4_096) > 10_000n).toBe(true)
  })
})

describe('rankModels', () => {
  const cands = [
    { id: 'big', label: 'Big', quality: 1, priceMicro: 24_000n, latencyMs: 9_000 },
    { id: 'mid', label: 'Mid', quality: 0.92, priceMicro: 4_500n, latencyMs: 1_500 },
    { id: 'cheap', label: 'Cheap', quality: 0.84, priceMicro: 600n, latencyMs: 1_500 },
  ]
  it('slider moves the winner', () => {
    expect(rankModels(cands, { taskType: 'writing', slider: 'best' })[0]!.id).toBe('big')
    expect(rankModels(cands, { taskType: 'writing', slider: 'cheapest' })[0]!.id).toBe('cheap')
  })
  it('explains picks', () => {
    const r = rankModels(cands, { taskType: 'writing', slider: 'balanced' })
    expect(r.find((c) => c.id === 'big')!.reason).toBe('Best writing quality')
    expect(r.find((c) => c.id === 'cheap')!.reason).toMatch(/84% of the best quality at 1\/40 of the price/)
  })
  it('taste nudges but never dominates', () => {
    const liked = cands.map((c) => (c.id === 'mid' ? { ...c, taste: 1 } : c))
    const r = rankModels(liked, { taskType: 'chat', slider: 'best' })
    expect(r[0]!.parts.taste === 0 || r[0]!.parts.taste <= 0.1).toBe(true)
  })
  it('favours web-grounded models for research', () => {
    const r = rankModels([...cands, { id: 'web', label: 'Sonar', quality: 0.5, priceMicro: 10_000n, latencyMs: 4_000, web: true }], { taskType: 'research', slider: 'balanced' })
    expect(r.find((c) => c.id === 'web')!.reason).toMatch(/live web/)
  })
})

describe('fraction', () => {
  it('words common ratios', () => {
    expect(fraction(0.1)).toBe('a tenth')
    expect(fraction(0.25)).toBe('a quarter')
    expect(fraction(0.7)).toBe('70%')
  })
})

describe('classifyByRules', () => {
  it.each([
    ['Draw a poster for my bakery', 'image'],
    ['Make an afrobeats song about Lagos', 'music'],
    ['Fix this TypeScript error: cannot find module', 'coding'],
    ['Translate this to Yoruba', 'translation'],
    ['Write a cover letter for a data analyst job', 'writing'],
    ['What is the latest news on the naira?', 'research'],
    ['hey how are you', 'chat'],
  ])('%s → %s', (prompt, type) => expect(classifyByRules(prompt).taskType).toBe(type))
})

describe('buildContext', () => {
  const history = Array.from({ length: 10 }, (_, i) => ({ seq: i + 1, role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', content: 'x'.repeat(400) }))
  it('keeps the newest turns within budget and flags what needs summarising', () => {
    const ctx = buildContext({ history, prompt: 'next?', budgetTokens: 450 })
    expect(ctx.messages.at(-1)).toEqual({ role: 'user', content: 'next?' })
    expect(ctx.contextTokens).toBeLessThanOrEqual(450)
    expect(ctx.firstIncludedSeq).toBeGreaterThan(1)
    expect(ctx.needsSummaryThroughSeq).toBe(ctx.firstIncludedSeq! - 1)
  })
  it('puts the summary first and skips summarised turns', () => {
    const ctx = buildContext({ history, prompt: 'next?', budgetTokens: 10_000, summary: 'they discussed X', summaryThroughSeq: 6 })
    expect(ctx.messages[0]!.content).toContain('they discussed X')
    expect(ctx.messages.length).toBe(1 + 4 + 1)
    expect(ctx.needsSummaryThroughSeq).toBeUndefined()
  })
})

describe('slider behaviour on a writing field', () => {
  const field = [
    { id: 'opus', label: 'Opus', quality: 1, priceMicro: 24_000n, latencyMs: 9000 },
    { id: 'gemini', label: 'Gemini Flash', quality: 0.911, priceMicro: 4_500n, latencyMs: 1500 },
    { id: 'gemma', label: 'Gemma', quality: 0.742, priceMicro: 430n, latencyMs: 1500 },
    { id: 'oss', label: 'gpt-oss', quality: 0.436, priceMicro: 207n, latencyMs: 1500 },
  ]
  it('best puts the strongest model first', () => {
    expect(rankModels(field, { taskType: 'writing', slider: 'best' })[0]!.id).toBe('opus')
  })
  it('cheapest skips models far below the field', () => {
    const r = rankModels(field, { taskType: 'writing', slider: 'cheapest' })
    expect(r[0]!.id).toBe('gemma')
    expect(r.at(-1)!.id).toBe('oss')
  })
})
