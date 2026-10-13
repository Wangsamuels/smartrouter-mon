# SmartRouter indexer (Envio HyperIndex)

Indexes the SmartRouterVault and SmartRouterLedger on Monad into GraphQL entities:
`Account`, `VaultMove`, `Receipt`, `ModelStats` (the public leaderboard) and `CompareVote`.

1. After deploying the contracts, copy `vault`, `ledger` and `vaultBlock` from
   `contracts/deployments/<network>.json` into `config.yaml` (and set `id: 143` for mainnet).
2. `npm i && npx envio codegen && npx envio dev` to run locally, or deploy on Envio's hosted
   service (connect this repo, root `indexer/`).
3. Set `ENVIO_GRAPHQL_URL` on Heroku to the hosted GraphQL endpoint. The API then serves
   `GET /leaderboard` from it, and the router agent's `get_model_stats` tool reads it.

Example query:

```graphql
query { ModelStats(where: {taskType: {_eq: 2}}) { modelId delivered failed up down compareWins compareLosses } }
```
