/**
 * The user's money on Monad, in two parts:
 *  - main wallet: their own address (Privy embedded wallet). Deposits land here; sends leave from here.
 *  - AI balance: their USDC in the SmartRouterVault, which pays for answers.
 * Balances are read from Monad, never stored. Cross-chain deposits go through Aurora Intents
 * straight into the AI balance.
 */
import { erc20Abi, isAddress } from 'viem'
import type { AppContext } from '../context.js'

export const usd = (m: bigint) => Number(m) / 1e6
export const micro = (usdAmount: number) => BigInt(Math.round(usdAmount * 1e6))

const EVM = /^0x[0-9a-fA-F]{40}$/

export function validAddress(address: string) {
  return EVM.test(address) && isAddress(address)
}

export async function tokenBalance(ctx: AppContext, address: `0x${string}`): Promise<bigint> {
  return (await ctx.rpc.readContract({ address: ctx.cfg.tokens.payment, abi: erc20Abi, functionName: 'balanceOf', args: [address] })) as bigint
}

export async function monBalance(ctx: AppContext, address: `0x${string}`): Promise<bigint> {
  return ctx.rpc.getBalance({ address })
}
