# SmartRouter on Monad

Describe a task; SmartRouter's router agent (Qwen) picks the best AI model for your budget, runs it,
and charges you per answer from an AI balance you hold in a smart contract on Monad. You are never
charged for a failed answer, your daily and weekly caps are enforced on-chain, and every answer
leaves a public receipt and rating on Monad.

Built for the Monad Metropolis hackathon (track: Trust, Identity & AI Infrastructure). It reuses the
SmartRouter backend (providers, recommendation, chats, worker) and replaces everything the user pays,
signs and trusts with Monad.

## How the money moves

```
User (Privy wallet, no MON needed)
  │  one signature: spending key + caps ──────────────┐
  │  one signature: ERC-3009 top-up ──────────────────┤  relayed by the operator (pays gas)
  │  per answer: EIP-712 voucher signed by the key ───┘
  ▼
SmartRouterVault (Monad) ── settle(counted ≤ voucher, per UTC day, within caps) ──► operator
  ▲                                                                                   │
  │ Aurora Intents: bridge from Base/Arbitrum/Solana… straight into depositFor(user)  │ Relay
  │                                                                                   ▼
SmartRouterLedger (Monad): receipts (model, price, delivered/failed, routeHash),   Tempo hot wallet
  signed ratings and Compare votes → Envio indexer → public leaderboard             pays AI providers (MPP)
```

- **Vault** (`contracts/contracts/SmartRouterVault.sol`): holds each user's USDC. Vouchers are
  cumulative ("up to X in total"). The operator settles only what was delivered, so a failed
  answer is never captured, even though the voucher covered it. Settlement is attributed to the UTC day of
  the answers and checked against the caps only the user can set. `release` returns the rest;
  `requestWithdraw` + `withdraw` is the user's escape hatch.
- **Ledger** (`contracts/contracts/SmartRouterLedger.sol`): receipts recorded by the operator;
  ratings and votes carry the user's (or their spending key's) EIP-712 signature, so they can't be
  forged.
- **Router agent** (`packages/core/src/agent`): Qwen runs a tool loop (`get_candidates`,
  `check_budget`, `get_model_stats`, `choose_models`). The keccak256 of its decision log is the
  `routeHash` in each on-chain receipt; `GET /requests/:id/route` returns the log so anyone can
  check the hash.
- **Providers** are still paid on Tempo over MPP (no AI provider accepts Monad). The worker tops up
  the Tempo hot wallet from Monad revenue through Relay (Monad USDC → Tempo USDC.e).

## Sponsor integrations

| Sponsor | Where | What it does |
| --- | --- | --- |
| Privy | sign-in, wallet | Embedded wallet on Monad signs Setup, ERC-3009 top-ups and sends; card funding lands USDC on Monad |
| Aurora Intents | `packages/core/src/aurora`, `POST /aurora/*` | Cross-chain deposits whose destination steps are `approve` + `vault.depositFor(user)`; API key stays server-side |
| Qwen (Alibaba Cloud) | `packages/core/src/agent` | Router agent picks models with tools; its decision hash goes on-chain |
| Envio | `indexer/` | HyperIndex over vault + ledger events → leaderboard, balances, activity |
| Alchemy | `MONAD_RPC_URL` | Primary Monad RPC for API, worker and frontend |

## Layout

```
apps/api          Hono API: auth, catalog, chats, quotes, paid /run (vault vouchers), wallet, ledger
apps/worker       pg-boss jobs: settle-vault, anchor-receipts, tempo-refill, wallet tracker, sweeps…
packages/config   env + Monad/Tempo constants
packages/core     providers, vault payments + settlement, agent, Aurora, treasury
packages/db       Drizzle schema + migrations (0009 = Monad vault)
packages/shared   EIP-712 typed data and API types shared with the frontend
contracts/        Hardhat: SmartRouterVault, SmartRouterLedger, tests, deploy scripts
indexer/          Envio HyperIndex config, schema and handlers
scripts/          monad-flow (end-to-end), smoke-providers, build-catalog, e2e-api
```

## Run it

```bash
pnpm install
cd contracts && npm ci && npx hardhat test          # 13 contract tests
# deploy (operator key read from Heroku, never printed):
DEPLOYER_PRIVATE_KEY=$(heroku config:get MONAD_OPERATOR_PRIVATE_KEY -a smartrouter-mon) \
OWNER_ADDRESS=<your treasury address> npx hardhat run scripts/deploy.ts --network monadTestnet
# → prints the heroku config:set line for USDC_ADDRESS, VAULT_ADDRESS, LEDGER_ADDRESS, VAULT_START_BLOCK
```

End-to-end against a running API (a test wallet with testnet USDC; no MON needed):

```bash
API_URL=https://<app>.herokuapp.com APP_ORIGIN=<frontend origin> TEST_USER_PRIVATE_KEY=0x… pnpm monad:flow
```

Local end-to-end (what was run before submission): a Hardhat node as chain 10143,
`npx hardhat run scripts/deploy-local.ts --network localhost`, Postgres + Redis, `MOCK_PROVIDERS=true`,
then `pnpm monad:flow`. It covers setup → gasless top-up → 402 voucher → paid answer → signed
rating → receipts on the ledger → settlement → release, plus a failed answer that the vault never
captures (settled 3,500 against a 5,300 voucher).

## API changes from the Tempo build (for the frontend)

- `POST /run` paid: answers `402 PAYMENT_REQUIRED` with `details.voucher` (EIP-712 typed data).
  Sign it with the spending key and resend with `X-SmartRouter-Voucher: base64(JSON {cumulativeAmount, signature})`.
  `GET /sessions/current` → `session.nextVoucherBaseMicro` lets the client sign up front.
  `409 SETUP_REQUIRED` → sign `details.setup` with the Privy wallet and `POST /wallet/setup`.
- `GET /wallet/setup?signer=0x…` / `POST /wallet/setup`: register the spending key + caps (relayed).
- `POST /wallet/deposit/authorization` → sign → `POST /wallet/deposit`: gasless top-up into the vault.
- `POST /wallet/send/code` → `POST /wallet/send` → sign → `POST /wallet/send/:id/sign`: gasless sends.
- `POST /wallet/locked/return`: settle and return the unused AI balance.
- `GET /wallet/options` → `aurora`: recipe for `@aurora-is-near/intents-connect` (`apiKeyProxyUrl` = `<API>/aurora/`).
- `POST /feedback`, `POST /compare/vote`: optional `signature` (Rating / Vote) → relayed to the ledger.
- `GET /ledger`, `GET /leaderboard`, `GET /requests/:id/route`.
- Removed: `/relay` (Tempo fee payer), `/wallet/spending-key` (Tempo access keys), mppx headers.
