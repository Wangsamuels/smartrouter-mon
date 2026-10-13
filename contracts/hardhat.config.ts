import type { HardhatUserConfig } from 'hardhat/config'
import '@nomicfoundation/hardhat-ethers'
import '@nomicfoundation/hardhat-chai-matchers'

const key = process.env.DEPLOYER_PRIVATE_KEY
const accounts = key ? [key] : []

const config: HardhatUserConfig = {
  solidity: { version: '0.8.24', settings: { optimizer: { enabled: true, runs: 500 }, evmVersion: 'cancun' } },
  networks: {
    // Local chain posing as Monad testnet (chain id 10143) for end-to-end tests.
    hardhat: { chainId: 10143 },
    localhost: { url: 'http://127.0.0.1:8545', chainId: 10143 },
    monadTestnet: { url: process.env.MONAD_RPC_URL ?? 'https://testnet-rpc.monad.xyz', chainId: 10143, accounts },
    monad: { url: process.env.MONAD_RPC_URL ?? 'https://rpc.monad.xyz', chainId: 143, accounts },
  },
}
export default config
