/**
 * Deploys SmartRouterVault + SmartRouterLedger to Monad from the server's own environment, so the
 * operator key never leaves Heroku:
 *
 *   heroku run -a smartrouter-mon "node scripts/deploy-contracts.mjs"
 *
 * Uses MONAD_OPERATOR_PRIVATE_KEY (deployer = operator = payee), MONAD_NETWORK, MONAD_RPC_URL,
 * MONAD_TREASURY_ADDRESS (owner). Prints only addresses and the config vars to set.
 * Bytecode: contracts/build/*.json (compiled with Hardhat, solc 0.8.24, optimizer 500 runs).
 */
import { readFileSync } from 'node:fs'
import { createPublicClient, createWalletClient, fallback, formatEther, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { monad, monadTestnet } from 'viem/chains'

const net = process.env.MONAD_NETWORK === 'mainnet' ? 'mainnet' : 'testnet'
const chain = net === 'mainnet' ? monad : monadTestnet
const USDC = { mainnet: '0x754704bc059f8c67012fed69bc8a327a5aafb603', testnet: '0x534b2f3A21130d7a60830c2Df862319e593943A3' }
const key = process.env.MONAD_OPERATOR_PRIVATE_KEY
if (!key) throw new Error('MONAD_OPERATOR_PRIVATE_KEY is not set')
const account = privateKeyToAccount(key)
const usdc = process.env.USDC_ADDRESS ?? USDC[net]
const owner = process.env.MONAD_TREASURY_ADDRESS ?? account.address
const urls = [process.env.MONAD_RPC_URL, chain.rpcUrls.default.http[0]].filter(Boolean)
const transport = fallback(urls.map((u) => http(u, { timeout: 30_000 })))
const pub = createPublicClient({ chain, transport })
const wallet = createWalletClient({ chain, account, transport })
const art = (n) => JSON.parse(readFileSync(new URL(`../contracts/build/${n}.json`, import.meta.url), 'utf8'))

console.log(`network monad-${net} (${chain.id}) operator ${account.address} owner ${owner} usdc ${usdc}`)
console.log(`operator MON: ${formatEther(await pub.getBalance({ address: account.address }))}`)

async function deploy(name, args) {
  const a = art(name)
  const hash = await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode, args })
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 })
  if (r.status !== 'success' || !r.contractAddress) throw new Error(`${name} deploy failed: ${hash}`)
  console.log(`${name} ${r.contractAddress} block ${r.blockNumber} tx ${hash}`)
  return r
}

const vault = await deploy('SmartRouterVault', [usdc, owner, account.address, account.address])
const ledger = await deploy('SmartRouterLedger', [vault.contractAddress, owner, account.address])
console.log(`DEPLOYED USDC_ADDRESS=${usdc} VAULT_ADDRESS=${vault.contractAddress} LEDGER_ADDRESS=${ledger.contractAddress} VAULT_START_BLOCK=${vault.blockNumber}`)
