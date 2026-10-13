import { expect } from 'chai'
import { ethers } from 'hardhat'
import { time } from '@nomicfoundation/hardhat-network-helpers'
import type { Signer } from 'ethers'

const usd = (n: number) => BigInt(Math.round(n * 1e6))
const DAY = 86_400

async function fixture() {
  const [owner, operator, payee, user, other] = await ethers.getSigners()
  const signer = ethers.Wallet.createRandom().connect(ethers.provider) // browser spending key
  const USDC = await ethers.getContractFactory('MockUSDC')
  const usdc = await USDC.deploy()
  const Vault = await ethers.getContractFactory('SmartRouterVault')
  const vault = await Vault.deploy(await usdc.getAddress(), owner.address, operator.address, payee.address)
  const Ledger = await ethers.getContractFactory('SmartRouterLedger')
  const ledger = await Ledger.deploy(await vault.getAddress(), owner.address, operator.address)
  await usdc.mint(user.address, usd(100))
  const chainId = (await ethers.provider.getNetwork()).chainId
  const vaultDomain = { name: 'SmartRouterVault', version: '1', chainId, verifyingContract: await vault.getAddress() }
  const ledgerDomain = { name: 'SmartRouterLedger', version: '1', chainId, verifyingContract: await ledger.getAddress() }
  return { owner, operator, payee, user, other, signer, usdc, vault, ledger, vaultDomain, ledgerDomain }
}
type F = Awaited<ReturnType<typeof fixture>>

const voucher = (f: F, by: Signer, user: string, cumulativeAmount: bigint) =>
  by.signTypedData(f.vaultDomain, { Voucher: [{ name: 'user', type: 'address' }, { name: 'cumulativeAmount', type: 'uint256' }] }, { user, cumulativeAmount })

async function setupSig(f: F, args: { signer: string; signerExpiry: bigint; dailyCap: bigint; weeklyCap: bigint; deadline: bigint }) {
  const acct = await f.vault.accountOf(f.user.address)
  return f.user.signTypedData(
    f.vaultDomain,
    {
      Setup: [
        { name: 'user', type: 'address' },
        { name: 'signer', type: 'address' },
        { name: 'signerExpiry', type: 'uint64' },
        { name: 'dailyCap', type: 'uint128' },
        { name: 'weeklyCap', type: 'uint128' },
        { name: 'nonce', type: 'uint64' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    { user: f.user.address, ...args, nonce: acct.nonce },
  )
}

async function ready(f: F, opts: { deposit?: bigint; daily?: bigint; weekly?: bigint; expiryIn?: number } = {}) {
  await f.usdc.connect(f.user).approve(await f.vault.getAddress(), opts.deposit ?? usd(10))
  await f.vault.connect(f.user).deposit(opts.deposit ?? usd(10))
  const now = BigInt(await time.latest())
  const a = { signer: f.signer.address, signerExpiry: now + BigInt(opts.expiryIn ?? 30 * DAY), dailyCap: opts.daily ?? usd(2), weeklyCap: opts.weekly ?? usd(10), deadline: now + 600n }
  const sig = await setupSig(f, a)
  // Relayed by the operator: the user pays no gas.
  await f.vault.connect(f.operator).setupFor(f.user.address, a.signer, a.signerExpiry, a.dailyCap, a.weeklyCap, a.deadline, sig)
}
const today = async (f: F) => Number(await f.vault.today())

describe('SmartRouterVault', () => {
  it('deposits: approve, depositFor and gasless ERC-3009', async () => {
    const f = await fixture()
    const v = await f.vault.getAddress()
    await f.usdc.connect(f.user).approve(v, usd(1))
    await expect(f.vault.connect(f.user).deposit(usd(1))).to.emit(f.vault, 'Deposited').withArgs(f.user.address, f.user.address, usd(1), usd(1))

    // A bridge (other) credits the user
    await f.usdc.mint(f.other.address, usd(2))
    await f.usdc.connect(f.other).approve(v, usd(2))
    await f.vault.connect(f.other).depositFor(f.user.address, usd(2))

    // ERC-3009: the user signs, the operator relays
    const now = BigInt(await time.latest())
    const nonce = ethers.hexlify(ethers.randomBytes(32))
    const msg = { from: f.user.address, to: v, value: usd(3), validAfter: 0n, validBefore: now + 3600n, nonce }
    const domain = { name: 'USDC', version: '2', chainId: f.vaultDomain.chainId, verifyingContract: await f.usdc.getAddress() }
    const sig = ethers.Signature.from(
      await f.user.signTypedData(
        domain,
        {
          ReceiveWithAuthorization: [
            { name: 'from', type: 'address' },
            { name: 'to', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'validAfter', type: 'uint256' },
            { name: 'validBefore', type: 'uint256' },
            { name: 'nonce', type: 'bytes32' },
          ],
        },
        msg,
      ),
    )
    await f.vault.connect(f.operator).depositWithAuthorization(f.user.address, usd(3), 0, msg.validBefore, nonce, sig.v, sig.r, sig.s)
    expect(await f.vault.balanceOf(f.user.address)).to.equal(usd(6))
  })

  it('settles only what was delivered, never more than the voucher', async () => {
    const f = await fixture()
    await ready(f)
    const d = await today(f)
    // Three answers authorised ($0.30), one failed: only $0.20 counted.
    const sig = await voucher(f, f.signer, f.user.address, usd(0.3))
    await expect(f.vault.connect(f.operator).settle(f.user.address, usd(0.3), usd(0.2), d, sig))
      .to.emit(f.vault, 'Settled')
      .withArgs(f.user.address, d, usd(0.2), usd(0.2), usd(9.8))
    expect(await f.usdc.balanceOf(f.payee.address)).to.equal(usd(0.2))
    // Can't settle above the voucher, nor the same amount twice.
    await expect(f.vault.connect(f.operator).settle(f.user.address, usd(0.3), usd(0.4), d, sig)).to.be.revertedWithCustomError(f.vault, 'CountedAboveVoucher')
    await expect(f.vault.connect(f.operator).settle(f.user.address, usd(0.3), usd(0.2), d, sig)).to.be.revertedWithCustomError(f.vault, 'NothingToSettle')
    // Later: the next cumulative voucher settles the rest.
    const sig2 = await voucher(f, f.signer, f.user.address, usd(0.5))
    await f.vault.connect(f.operator).settle(f.user.address, usd(0.5), usd(0.5), d, sig2)
    expect(await f.usdc.balanceOf(f.payee.address)).to.equal(usd(0.5))
  })

  it('rejects vouchers from anyone but the user or their key, and non-operators', async () => {
    const f = await fixture()
    await ready(f)
    const d = await today(f)
    const forged = await voucher(f, f.other, f.user.address, usd(1))
    await expect(f.vault.connect(f.operator).settle(f.user.address, usd(1), usd(1), d, forged)).to.be.revertedWithCustomError(f.vault, 'BadSignature')
    const good = await voucher(f, f.user, f.user.address, usd(1)) // the user's own signature also works
    await expect(f.vault.connect(f.other).settle(f.user.address, usd(1), usd(1), d, good)).to.be.revertedWithCustomError(f.vault, 'NotOperator')
    await f.vault.connect(f.operator).settle(f.user.address, usd(1), usd(1), d, good)
  })

  it('enforces the daily and weekly caps by the day the answers were given', async () => {
    const f = await fixture()
    await ready(f, { daily: usd(2), weekly: usd(3) })
    const d = await today(f)
    const s = (amt: bigint) => voucher(f, f.signer, f.user.address, amt)
    await expect(f.vault.connect(f.operator).settle(f.user.address, usd(2.5), usd(2.5), d, await s(usd(2.5)))).to.be.revertedWithCustomError(f.vault, 'DailyCapExceeded')
    await f.vault.connect(f.operator).settle(f.user.address, usd(2), usd(2), d, await s(usd(2)))
    // Yesterday's answers, settled after midnight, count against yesterday's cap, not today's.
    await f.vault.connect(f.operator).settle(f.user.address, usd(2.5), usd(2.5), d - 1, await s(usd(2.5)))
    expect(await f.vault.spentOnDay(f.user.address, d - 1)).to.equal(usd(0.5))
    await expect(f.vault.connect(f.operator).settle(f.user.address, usd(5), usd(5), d + 1, await s(usd(5)))).to.be.revertedWithCustomError(f.vault, 'BadDay')
    await expect(f.vault.connect(f.operator).settle(f.user.address, usd(5), usd(5), d - 7, await s(usd(5)))).to.be.revertedWithCustomError(f.vault, 'BadDay')
  })

  it('weekly cap holds across days in one week bucket', async () => {
    const f = await fixture()
    // Move to the start of a week bucket so the next days share it.
    const t = await time.latest()
    await time.increaseTo((Math.floor(t / (7 * DAY)) + 1) * 7 * DAY + 60)
    await ready(f, { daily: usd(2), weekly: usd(3) })
    const d = await today(f)
    await f.vault.connect(f.operator).settle(f.user.address, usd(2), usd(2), d, await voucher(f, f.signer, f.user.address, usd(2)))
    await time.increase(DAY)
    await expect(f.vault.connect(f.operator).settle(f.user.address, usd(3.5), usd(3.5), d + 1, await voucher(f, f.signer, f.user.address, usd(3.5)))).to.be.revertedWithCustomError(f.vault, 'WeeklyCapExceeded')
    await f.vault.connect(f.operator).settle(f.user.address, usd(3), usd(3), d + 1, await voucher(f, f.signer, f.user.address, usd(3)))
  })

  it('refuses to settle before the user set caps', async () => {
    const f = await fixture()
    await f.usdc.connect(f.user).approve(await f.vault.getAddress(), usd(1))
    await f.vault.connect(f.user).deposit(usd(1))
    const sig = await voucher(f, f.user, f.user.address, usd(1))
    await expect(f.vault.connect(f.operator).settle(f.user.address, usd(1), usd(1), await today(f), sig)).to.be.revertedWithCustomError(f.vault, 'CapsNotSet')
  })

  it('setup: relayed signature only once, bad caps refused', async () => {
    const f = await fixture()
    const now = BigInt(await time.latest())
    const a = { signer: f.signer.address, signerExpiry: now + 1000n, dailyCap: usd(2), weeklyCap: usd(10), deadline: now + 600n }
    const sig = await setupSig(f, a)
    await f.vault.connect(f.other).setupFor(f.user.address, a.signer, a.signerExpiry, a.dailyCap, a.weeklyCap, a.deadline, sig)
    await expect(f.vault.connect(f.other).setupFor(f.user.address, a.signer, a.signerExpiry, a.dailyCap, a.weeklyCap, a.deadline, sig)).to.be.revertedWithCustomError(f.vault, 'BadSignature')
    await expect(f.vault.connect(f.user).setup(f.signer.address, a.signerExpiry, usd(5), usd(1))).to.be.revertedWithCustomError(f.vault, 'BadCaps')
  })

  it('expired keys stop after the grace period; a replaced key works for one more day', async () => {
    const f = await fixture()
    await ready(f, { expiryIn: DAY })
    const v1 = await voucher(f, f.signer, f.user.address, usd(0.1))
    await time.increase(2 * DAY + 10) // past expiry + 1 day grace
    await expect(f.vault.connect(f.operator).settle(f.user.address, usd(0.1), usd(0.1), await today(f), v1)).to.be.revertedWithCustomError(f.vault, 'BadSignature')

    // New key; vouchers signed by the old one before the swap still settle during the grace window.
    const f2 = await fixture()
    await ready(f2)
    const old = await voucher(f2, f2.signer, f2.user.address, usd(0.2))
    const fresh = ethers.Wallet.createRandom()
    await f2.vault.connect(f2.user).setup(fresh.address, BigInt(await time.latest()) + 1000n, usd(2), usd(10))
    await f2.vault.connect(f2.operator).settle(f2.user.address, usd(0.2), usd(0.2), await today(f2), old)
    expect(await f2.vault.isAuthorizedSigner(f2.user.address, f2.signer.address)).to.equal(true)
    await time.increase(DAY + 10)
    expect(await f2.vault.isAuthorizedSigner(f2.user.address, f2.signer.address)).to.equal(false)
  })

  it('release returns the rest; withdraw needs one hour of notice', async () => {
    const f = await fixture()
    await ready(f, { deposit: usd(5) })
    await f.vault.connect(f.operator).settle(f.user.address, usd(1), usd(1), await today(f), await voucher(f, f.signer, f.user.address, usd(1)))
    await expect(f.vault.connect(f.operator).release(f.user.address)).to.emit(f.vault, 'Released').withArgs(f.user.address, usd(4))
    expect(await f.usdc.balanceOf(f.user.address)).to.equal(usd(99))

    await f.usdc.connect(f.user).approve(await f.vault.getAddress(), usd(2))
    await f.vault.connect(f.user).deposit(usd(2))
    await expect(f.vault.connect(f.user).withdraw()).to.be.revertedWithCustomError(f.vault, 'WithdrawNotReady')
    await f.vault.connect(f.user).requestWithdraw()
    await expect(f.vault.connect(f.user).withdraw()).to.be.revertedWithCustomError(f.vault, 'WithdrawNotReady')
    // The operator can still settle answers already given during the notice.
    await f.vault.connect(f.operator).settle(f.user.address, usd(1.5), usd(1.5), await today(f), await voucher(f, f.signer, f.user.address, usd(1.5)))
    await time.increase(3601)
    await expect(f.vault.connect(f.user).withdraw()).to.emit(f.vault, 'Withdrawn').withArgs(f.user.address, usd(1.5))
  })

  it('only the owner changes operator and payee', async () => {
    const f = await fixture()
    await expect(f.vault.connect(f.operator).setPayee(f.other.address)).to.be.revertedWithCustomError(f.vault, 'OwnableUnauthorizedAccount')
    await f.vault.connect(f.owner).setPayee(f.other.address)
    expect(await f.vault.payee()).to.equal(f.other.address)
  })
})

describe('SmartRouterLedger', () => {
  const rid = () => ethers.hexlify(ethers.randomBytes(16))
  const rating = (f: F, by: Signer, requestId: string, score: number) =>
    by.signTypedData(f.ledgerDomain, { Rating: [{ name: 'requestId', type: 'bytes16' }, { name: 'score', type: 'int8' }] }, { requestId, score })
  const vote = (f: F, by: Signer, compareGroup: string, winnerRequestId: string, loserRequestId: string) =>
    by.signTypedData(
      f.ledgerDomain,
      { Vote: [{ name: 'compareGroup', type: 'bytes16' }, { name: 'winnerRequestId', type: 'bytes16' }, { name: 'loserRequestId', type: 'bytes16' }] },
      { compareGroup, winnerRequestId, loserRequestId },
    )
  const receipt = (user: string, requestId: string, modelId: string, status = 1, price = usd(0.01)) => ({ requestId, user, modelId, taskType: 2, status, priceMicro: status === 1 ? price : 0n, routeHash: ethers.id('route') })

  it('records receipts once; failed answers must show $0', async () => {
    const f = await fixture()
    const a = rid()
    const b = rid()
    await expect(f.ledger.connect(f.operator).recordReceipts([receipt(f.user.address, a, 'openai:gpt-5'), { ...receipt(f.user.address, b, 'x'), status: 2, priceMicro: 5n }]))
      .to.emit(f.ledger, 'ReceiptRecorded')
      .and.to.emit(f.ledger, 'Skipped')
    await expect(f.ledger.connect(f.operator).recordReceipts([receipt(f.user.address, a, 'openai:gpt-5')])).to.emit(f.ledger, 'Skipped').withArgs(a, 1)
    await expect(f.ledger.connect(f.other).recordReceipts([])).to.be.revertedWithCustomError(f.ledger, 'NotOperator')
  })

  it('accepts ratings signed by the user or their key, skips forgeries', async () => {
    const f = await fixture()
    await ready(f)
    const a = rid()
    await f.ledger.connect(f.operator).recordReceipts([receipt(f.user.address, a, 'openai:gpt-5')])
    const forged = await rating(f, f.other, a, -1)
    await expect(f.ledger.connect(f.other).submitRatings([{ requestId: a, score: -1, sig: forged }])).to.emit(f.ledger, 'Skipped').withArgs(a, 3)
    const byKey = await rating(f, f.signer, a, 1)
    await expect(f.ledger.connect(f.operator).submitRatings([{ requestId: a, score: 1, sig: byKey }]))
      .to.emit(f.ledger, 'Rated')
      .withArgs(a, f.user.address, ethers.id('openai:gpt-5'), 2, 1, 0)
  })

  it('records a compare vote once', async () => {
    const f = await fixture()
    await ready(f)
    const g = rid()
    const w = rid()
    const l = rid()
    await f.ledger.connect(f.operator).recordReceipts([receipt(f.user.address, w, 'openai:gpt-5'), receipt(f.user.address, l, 'deepseek:chat')])
    const sig = await vote(f, f.signer, g, w, l)
    await expect(f.ledger.submitVotes([{ compareGroup: g, winnerRequestId: w, loserRequestId: l, sig }]))
      .to.emit(f.ledger, 'Compared')
      .withArgs(g, f.user.address, 2, ethers.id('openai:gpt-5'), ethers.id('deepseek:chat'))
    await expect(f.ledger.submitVotes([{ compareGroup: g, winnerRequestId: w, loserRequestId: l, sig }])).to.emit(f.ledger, 'Skipped').withArgs(g, 1)
  })
})
