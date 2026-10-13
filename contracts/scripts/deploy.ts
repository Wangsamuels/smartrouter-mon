/**
 * Deploys SmartRouterVault + SmartRouterLedger to Monad.
 *
 *   DEPLOYER_PRIVATE_KEY=$(heroku config:get MONAD_OPERATOR_PRIVATE_KEY -a smartrouter-mon) \
 *   OWNER_ADDRESS=0x…  (optional; defaults to the deployer — use your treasury wallet) \
 *   npx hardhat run scripts/deploy.ts --network monadTestnet
 *
 * The deployer becomes the operator (settles, relays) and the payee (revenue lands there and
 * the worker pays providers / sweeps profit from it), matching REVENUE_TO=operator.
 * Writes deployments/<network>.json and prints the config vars to set.
 */
import { ethers, network } from 'hardhat'
import { mkdirSync, writeFileSync } from 'node:fs'

const USDC: Record<number, string> = {
  143: '0x754704bc059f8c67012fed69bc8a327a5aafb603', // Circle USDC, Monad mainnet
  10143: '0x534b2f3A21130d7a60830c2Df862319e593943A3', // Circle USDC, Monad testnet
}

async function main() {
  const [deployer] = await ethers.getSigners()
  if (!deployer) throw new Error('Set DEPLOYER_PRIVATE_KEY')
  const chainId = Number((await ethers.provider.getNetwork()).chainId)
  const usdc = process.env.USDC_ADDRESS ?? USDC[chainId]
  if (!usdc) throw new Error(`No USDC address for chain ${chainId}; set USDC_ADDRESS`)
  const owner = process.env.OWNER_ADDRESS ?? deployer.address
  const operator = deployer.address
  console.log(`network ${network.name} (${chainId}) deployer/operator ${operator} owner ${owner} usdc ${usdc}`)
  console.log(`deployer MON balance: ${ethers.formatEther(await ethers.provider.getBalance(operator))}`)

  const vault = await (await ethers.getContractFactory('SmartRouterVault')).deploy(usdc, owner, operator, operator)
  await vault.waitForDeployment()
  const vaultAddr = await vault.getAddress()
  const vaultBlock = (await vault.deploymentTransaction()!.wait())!.blockNumber
  console.log(`SmartRouterVault  ${vaultAddr} (block ${vaultBlock})`)

  const ledger = await (await ethers.getContractFactory('SmartRouterLedger')).deploy(vaultAddr, owner, operator)
  await ledger.waitForDeployment()
  const ledgerAddr = await ledger.getAddress()
  const ledgerBlock = (await ledger.deploymentTransaction()!.wait())!.blockNumber
  console.log(`SmartRouterLedger ${ledgerAddr} (block ${ledgerBlock})`)

  mkdirSync('deployments', { recursive: true })
  const out = { network: network.name, chainId, usdc, owner, operator, vault: vaultAddr, vaultBlock, ledger: ledgerAddr, ledgerBlock, deployedAt: new Date().toISOString() }
  writeFileSync(`deployments/${network.name}.json`, JSON.stringify(out, null, 2) + '\n')
  console.log('\nSet on Heroku:')
  console.log(`heroku config:set -a smartrouter-mon USDC_ADDRESS=${usdc} VAULT_ADDRESS=${vaultAddr} LEDGER_ADDRESS=${ledgerAddr} VAULT_START_BLOCK=${vaultBlock}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
