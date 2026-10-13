/** Static per-network constants. Anything secret or deployment-specific lives in env vars. */
export const NETWORKS = {
  testnet: {
    name: 'Monad Testnet',
    chainId: 10143,
    rpcUrl: 'https://testnet-rpc.monad.xyz',
    fallbackRpcUrls: [] as string[],
    explorer: 'https://testnet.monadexplorer.com',
    tokens: {
      // Circle USDC on Monad testnet (FiatToken v2: ERC-3009 + permit). Circle's faucet hands it out.
      USDC: '0x534b2f3A21130d7a60830c2Df862319e593943A3',
    },
  },
  mainnet: {
    name: 'Monad',
    chainId: 143,
    rpcUrl: 'https://rpc.monad.xyz',
    fallbackRpcUrls: [] as string[],
    explorer: 'https://monadscan.com',
    tokens: {
      // Circle USDC on Monad mainnet (FiatToken v2: ERC-3009 + permit).
      USDC: '0x754704bc059f8c67012fed69bc8a327a5aafb603',
    },
  },
} as const

export type NetworkName = keyof typeof NETWORKS

/**
 * Tempo mainnet: where SmartRouter pays AI providers over MPP in USDC.e. Users never touch it;
 * the worker tops the Tempo hot wallet up from Monad revenue through Relay.
 */
export const TEMPO = {
  name: 'Tempo Mainnet',
  chainId: 4217,
  rpcUrl: 'https://rpc.tempo.xyz',
  fallbackRpcUrls: ['https://tempo.drpc.org', 'https://tempo-rpc.publicnode.com'],
  explorer: 'https://explore.tempo.xyz',
  USDCe: '0x20c000000000000000000000b9537d11c60e8b50',
} as const

/** USDC and USDC.e both use 6 decimals; all money is stored as integer micro-USD. */
export const TOKEN_DECIMALS = 6
export const MICRO = 1_000_000
