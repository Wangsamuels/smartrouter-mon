/**
 * EIP-712 messages users sign on Monad. Shared by the backend (verification) and the frontend
 * (signing with the Privy embedded wallet or the browser-held spending key), so both always
 * agree byte for byte with the contracts.
 *
 *   Voucher   — "I authorise SmartRouter to take up to `cumulativeAmount` in total" (spending key, per answer)
 *   Setup     — registers the spending key and the daily/weekly caps (Privy wallet, once)
 *   Rating    — thumbs up/down on an answer (spending key)
 *   Vote      — Compare winner (spending key)
 *   ReceiveWithAuthorization — gasless USDC deposit into the vault (Privy wallet, ERC-3009)
 */
export type Hex = `0x${string}`

export const vaultDomain = (chainId: number, vault: Hex) => ({ name: 'SmartRouterVault', version: '1', chainId, verifyingContract: vault }) as const
export const ledgerDomain = (chainId: number, ledger: Hex) => ({ name: 'SmartRouterLedger', version: '1', chainId, verifyingContract: ledger }) as const
/** Circle USDC on Monad (FiatToken v2): name "USDC", version "2". */
export const usdcDomain = (chainId: number, usdc: Hex, name = 'USDC', version = '2') => ({ name, version, chainId, verifyingContract: usdc }) as const

export const VOUCHER_TYPES = {
  Voucher: [
    { name: 'user', type: 'address' },
    { name: 'cumulativeAmount', type: 'uint256' },
  ],
} as const

export const SETUP_TYPES = {
  Setup: [
    { name: 'user', type: 'address' },
    { name: 'signer', type: 'address' },
    { name: 'signerExpiry', type: 'uint64' },
    { name: 'dailyCap', type: 'uint128' },
    { name: 'weeklyCap', type: 'uint128' },
    { name: 'nonce', type: 'uint64' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const

export const RATING_TYPES = {
  Rating: [
    { name: 'requestId', type: 'bytes16' },
    { name: 'score', type: 'int8' },
  ],
} as const

export const VOTE_TYPES = {
  Vote: [
    { name: 'compareGroup', type: 'bytes16' },
    { name: 'winnerRequestId', type: 'bytes16' },
    { name: 'loserRequestId', type: 'bytes16' },
  ],
} as const

export const RECEIVE_WITH_AUTHORIZATION_TYPES = {
  ReceiveWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const

/** Header that carries a signed voucher on POST /run: base64(JSON { cumulativeAmount, signature }). */
export const VOUCHER_HEADER = 'x-smartrouter-voucher'
