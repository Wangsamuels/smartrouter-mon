import { describe, expect, it } from 'vitest'
import { baseToMicro, microToBase, planSweep, relayFeeUsd, relayMoveStatus } from '../src/index.js'

const $ = (n: number) => BigInt(Math.round(n * 1e6))
const base = { floatMicro: $(10), minMicro: $(20), dustMicro: $(0.1), intervalMs: 24 * 3600_000 }

describe('profit sweep', () => {
  it('sweeps as soon as profit reaches $20', () => {
    const p = planSweep({ ...base, balance: $(31), lastSweepAt: new Date() })
    expect(p).toMatchObject({ sweep: true, reason: 'threshold', profit: $(21) })
  })
  it('waits when profit is under $20 and the last sweep was recent', () => {
    expect(planSweep({ ...base, balance: $(25), lastSweepAt: new Date(Date.now() - 3600_000) })).toMatchObject({ sweep: false, reason: 'not due', profit: $(15) })
  })
  it('sweeps whatever is above the float after 24 h', () => {
    expect(planSweep({ ...base, balance: $(12.5), lastSweepAt: new Date(Date.now() - 25 * 3600_000) })).toMatchObject({ sweep: true, reason: 'interval', profit: $(2.5) })
  })
  it('never touches the float or sweeps dust', () => {
    expect(planSweep({ ...base, balance: $(9), lastSweepAt: undefined })).toMatchObject({ sweep: false, profit: 0n })
    expect(planSweep({ ...base, balance: $(10.05), lastSweepAt: undefined })).toMatchObject({ sweep: false, reason: 'below dust' })
  })
})

describe('relay helpers', () => {
  it('converts token units to micro-USD for 6- and 18-decimal USDC', () => {
    expect(baseToMicro('5000000', 6)).toBe($(5))
    expect(baseToMicro('5000000000000000000', 18)).toBe($(5))
    expect(microToBase($(10), 18)).toBe(10n * 10n ** 18n)
  })
  it('maps Relay statuses', () => {
    expect(relayMoveStatus('success')).toBe('completed')
    expect(relayMoveStatus('waiting')).toBe('pending')
    expect(relayMoveStatus('refund')).toBe('refunded')
    expect(relayMoveStatus('failure')).toBe('failed')
  })
  it('sums the fees the user pays', () => {
    expect(relayFeeUsd({ fees: { gas: { amountUsd: '0.0004' }, relayer: { amountUsd: '0.0245' }, relayerGas: { amountUsd: '0.004' }, app: { amountUsd: '0' } } } as never)).toBeCloseTo(0.0249, 6)
  })
})
