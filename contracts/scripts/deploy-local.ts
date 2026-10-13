/**
 * Local end-to-end setup (hardhat node posing as Monad testnet, chain 10143):
 *   npx hardhat node &   then   npx hardhat run scripts/deploy-local.ts --network localhost
 * Deploys MockUSDC + vault + ledger. Operator/payee = hardhat account #1, test user = #2 (gets $20 mock USDC).
 */
import { ethers } from 'hardhat'
import { writeFileSync, mkdirSync } from 'node:fs'

async function main() {
  const [owner, operator, user] = await ethers.getSigners()
  const usdc = await (await ethers.getContractFactory('MockUSDC')).deploy()
  await usdc.waitForDeployment()
  const vault = await (await ethers.getContractFactory('SmartRouterVault')).deploy(await usdc.getAddress(), owner!.address, operator!.address, operator!.address)
  await vault.waitForDeployment()
  const ledger = await (await ethers.getContractFactory('SmartRouterLedger')).deploy(await vault.getAddress(), owner!.address, operator!.address)
  await ledger.waitForDeployment()
  await (await usdc.mint(user!.address, 20_000_000n)).wait()
  await (await operator!.sendTransaction({ to: operator!.address, value: 0n })).wait()
  const out = { usdc: await usdc.getAddress(), vault: await vault.getAddress(), ledger: await ledger.getAddress(), operator: operator!.address, user: user!.address }
  mkdirSync('deployments', { recursive: true })
  writeFileSync('deployments/localhost.json', JSON.stringify(out, null, 2))
  console.log(JSON.stringify(out))
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
