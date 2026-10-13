/**
 * SmartRouter data model. Money is integer micro-USD (bigint, 6 decimals) — never floats.
 * Wallet and vault balances are read from Monad, never stored.
 */
import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

const micro = (name: string) => bigint(name, { mode: 'bigint' })
const ts = (name: string) => timestamp(name, { withTimezone: true })
const createdAt = () => ts('created_at').notNull().defaultNow()

// ---------- enums ----------
export const sliderEnum = pgEnum('slider', ['cheapest', 'balanced', 'best'])
export const taskTypeEnum = pgEnum('task_type', ['chat', 'writing', 'coding', 'research', 'translation', 'image', 'music'])
export const sessionStatusEnum = pgEnum('session_status', ['open', 'closing', 'closed'])
export const requestStatusEnum = pgEnum('request_status', ['pending', 'running', 'succeeded', 'failed', 'cancelled'])
/** 'free' = SmartRouter-sponsored fallback model (Cloudflare Workers AI), never paid over MPP. */
export const paymentKindEnum = pgEnum('payment_kind', ['session', 'charge', 'free'])
export const messageRoleEnum = pgEnum('message_role', ['user', 'assistant', 'system'])
export const messageStatusEnum = pgEnum('message_status', ['pending', 'streaming', 'done', 'failed'])
export const providerSessionStatusEnum = pgEnum('provider_session_status', ['open', 'closing', 'closed'])
export const aliasSourceEnum = pgEnum('alias_source', ['lmarena', 'aa', 'openrouter'])
export const treasuryKindEnum = pgEnum('treasury_kind', ['settle', 'close', 'provider_topup', 'charge', 'swap', 'refill', 'sweep', 'release', 'bridge'])
export const walletMoveKindEnum = pgEnum('wallet_move_kind', ['deposit', 'send', 'send_cross_chain', 'to_ai_balance', 'from_ai_balance'])
export const walletMoveStatusEnum = pgEnum('wallet_move_status', ['pending', 'completed', 'failed', 'refunding', 'refunded', 'action_required'])
export const txStatusEnum = pgEnum('tx_status', ['pending', 'confirmed', 'failed'])
export const waitlistInterestEnum = pgEnum('waitlist_interest', ['naira', 'credits'])

// ---------- users & auth ----------
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** The user's EVM address (Privy embedded wallet), lowercase 0x… — on Monad. Column name kept from the Tempo build. */
  tempoAddress: text('tempo_address').notNull().unique(),
  /** Privy user id (did:privy:…) when the user signed in with email / Google through Privy. */
  privyDid: text('privy_did').unique(),
  email: text('email'), // verified by Privy (email OTP or Google)
  loginMethod: text('login_method'), // 'email' | 'google' | 'wallet'
  country: text('country'),
  slider: sliderEnum('slider').notNull().default('balanced'),
  allocationMicro: micro('allocation_micro').notNull().default(sql`2000000`),
  weeklyLimitMicro: micro('weekly_limit_micro').notNull().default(sql`10000000`),
  /** Daily spending cap (resets 00:00 UTC). */
  dailyLimitMicro: micro('daily_limit_micro').notNull().default(sql`2000000`),
  /** Spending key registered in the vault (browser-held; signs vouchers, ratings, votes). */
  spendingKeyAddress: text('spending_key_address'),
  spendingKeyExpiresAt: ts('spending_key_expires_at'),
  /** When the allocation runs out, continue the chat on the free model instead of stopping. */
  autoFreeFallback: boolean('auto_free_fallback').notNull().default(true),
  createdAt: createdAt(),
})

export const authNonces = pgTable(
  'auth_nonces',
  {
    nonce: text('nonce').primaryKey(),
    address: text('address').notNull(),
    expiresAt: ts('expires_at').notNull(),
  },
  (t) => [index('auth_nonces_expires_idx').on(t.expiresAt)],
)

// ---------- vault accounts: one row per user per vault (channel_id = `<vault>:<user>`) ----------
export const userSessions = pgTable(
  'user_sessions',
  {
    channelId: text('channel_id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id),
    payer: text('payer').notNull(),
    authorizedSigner: text('authorized_signer'),
    depositMicro: micro('deposit_micro').notNull().default(sql`0`),
    highestVoucherMicro: micro('highest_voucher_micro').notNull().default(sql`0`),
    /** Only delivered results count; settlement captures this, never more than the voucher. */
    countedMicro: micro('counted_micro').notNull().default(sql`0`),
    /** Accepted vouchers minus refunds of failed answers (delivered + in flight). */
    chargedMicro: micro('charged_micro').notNull().default(sql`0`),
    /** Highest voucher's EIP-712 signature and who signed it (the user or their spending key). */
    voucherSig: text('voucher_sig'),
    voucherSigner: text('voucher_signer'),
    settledMicro: micro('settled_micro').notNull().default(sql`0`),
    lastSettleTx: text('last_settle_tx'),
    lastSettledAt: ts('last_settled_at'),
    lastUsedAt: ts('last_used_at').notNull().defaultNow(),
    status: sessionStatusEnum('status').notNull().default('open'),
    createdAt: createdAt(),
  },
  (t) => [
    index('user_sessions_user_status_idx').on(t.userId, t.status),
    index('user_sessions_status_last_used_idx').on(t.status, t.lastUsedAt),
  ],
)

// ---------- models & catalog ----------
export const models = pgTable('models', {
  id: text('id').primaryKey(), // e.g. 'openrouter:anthropic/claude-sonnet-4.5'
  provider: text('provider').notNull(),
  mppUrl: text('mpp_url').notNull(),
  modelName: text('model_name').notNull(),
  label: text('label').notNull().default(''),
  adapter: text('adapter').notNull(), // openaiStyle | locus | fal | stableStudio | suno | cloudflare | mock
  payment: paymentKindEnum('payment').notNull(),
  taskTypes: taskTypeEnum('task_types').array().notNull(),
  qualityByTask: jsonb('quality_by_task').$type<Partial<Record<string, number>>>().notNull().default({}),
  priceEstMicro: micro('price_est_micro').notNull(),
  medianLatencyMs: integer('median_latency_ms'),
  speedClass: text('speed_class').notNull().default('medium'), // fast | medium | slow, until latency is measured
  web: boolean('web').notNull().default(false), // grounded in live web search
  errorRate: real('error_rate').notNull().default(0),
  /** Model id proven by a paid call (gateways 402 even for unknown ids). */
  verified: boolean('verified').notNull().default(false),
  active: boolean('active').notNull().default(true),
  updatedAt: ts('updated_at').notNull().defaultNow(),
})

export const modelAliases = pgTable(
  'model_aliases',
  {
    leaderboardName: text('leaderboard_name').notNull(),
    source: aliasSourceEnum('source').notNull(),
    modelId: text('model_id').notNull().references(() => models.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.source, t.leaderboardName] })],
)

// ---------- chats (one thread per topic; model can change per turn, like Cursor) ----------
export const chats = pgTable(
  'chats',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id),
    title: text('title'), // auto-generated after the first turn; user can rename
    taskType: taskTypeEnum('task_type').notNull(), // picked or classified when the chat starts
    slider: sliderEnum('slider').notNull().default('balanced'),
    currentModelId: text('current_model_id').references(() => models.id),
    /** Running summary of older turns once history exceeds the context budget. */
    summary: text('summary'),
    summaryThroughSeq: integer('summary_through_seq').notNull().default(0),
    messageCount: integer('message_count').notNull().default(0),
    spentMicro: micro('spent_micro').notNull().default(sql`0`),
    lastMessageAt: ts('last_message_at').notNull().defaultNow(),
    archivedAt: ts('archived_at'),
    createdAt: createdAt(),
  },
  (t) => [index('chats_user_last_idx').on(t.userId, t.lastMessageAt.desc())],
)

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chatId: uuid('chat_id').notNull().references(() => chats.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(), // 1, 2, 3… within the chat
    role: messageRoleEnum('role').notNull(),
    content: text('content').notNull().default(''),
    attachments: jsonb('attachments').$type<{ kind: string; ref: string; mime?: string; name?: string; sizeBytes?: number }[]>(), // kind 'file': ref = upload id
    modelId: text('model_id').references(() => models.id), // which model wrote this (assistant)
    requestId: uuid('request_id'), // the paid/free run that produced it
    resultRef: text('result_ref'), // image/music file in object storage
    tokensIn: integer('tokens_in'),
    tokensOut: integer('tokens_out'),
    status: messageStatusEnum('status').notNull().default('done'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('messages_chat_seq_idx').on(t.chatId, t.seq)],
)

/** Per-user daily free-model usage (also capped globally by FREE_GLOBAL_DAILY_USD). */
export const freeUsage = pgTable(
  'free_usage',
  {
    userId: uuid('user_id').notNull().references(() => users.id),
    day: text('day').notNull(), // YYYY-MM-DD UTC
    messages: integer('messages').notNull().default(0),
    costMicro: micro('cost_micro').notNull().default(sql`0`), // what Cloudflare charged us
  },
  (t) => [primaryKey({ columns: [t.userId, t.day] })],
)

// ---------- quotes & requests ----------
export const quotes = pgTable(
  'quotes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id),
    chatId: uuid('chat_id').references(() => chats.id),
    taskType: taskTypeEnum('task_type').notNull(),
    modelId: text('model_id').notNull().references(() => models.id),
    promptHash: text('prompt_hash'), // /run must send the prompt that was quoted
    attachmentIds: jsonb('attachment_ids').$type<string[]>(), // uploaded files priced into the quote; /run uses the same
    contextTokens: integer('context_tokens'), // history + prompt tokens priced into the quote
    maxOutputTokens: integer('max_output_tokens'), // reply cap priced into the quote; /run uses the same
    priceMicro: micro('price_micro').notNull(), // what the user pays (0 for the free model)
    estCostMicro: micro('est_cost_micro').notNull(), // what we expect to pay the provider
    /** Router agent decision behind this option (Qwen tool calls, scores, reasons) and its keccak256. */
    routeLog: jsonb('route_log').$type<Record<string, unknown>>(),
    routeHash: text('route_hash'),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
    createdAt: createdAt(),
  },
  (t) => [index('quotes_expires_idx').on(t.expiresAt)],
)

export const requests = pgTable(
  'requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').notNull().references(() => users.id),
    quoteId: uuid('quote_id').notNull().unique().references(() => quotes.id), // idempotency key
    channelId: text('channel_id').references(() => userSessions.channelId), // null for free runs
    chatId: uuid('chat_id').references(() => chats.id),
    userMessageId: uuid('user_message_id'),
    assistantMessageId: uuid('assistant_message_id'),
    modelId: text('model_id').notNull().references(() => models.id),
    isFree: boolean('is_free').notNull().default(false),
    fallbackReason: text('fallback_reason'), // e.g. allocation_exhausted, provider_failed
    taskType: taskTypeEnum('task_type').notNull(),
    compareGroup: uuid('compare_group'),
    status: requestStatusEnum('status').notNull().default('pending'),
    priceMicro: micro('price_micro').notNull(),
    providerCostMicro: micro('provider_cost_micro'),
    latencyMs: integer('latency_ms'),
    providerReceipt: jsonb('provider_receipt'),
    resultRef: text('result_ref'),
    /** Text answer (also in the chat message); kept for compare runs and /requests polling. */
    outputText: text('output_text'),
    errorCode: text('error_code'),
    /** keccak256 of the router agent's decision log (copied from the quote; goes on-chain in the receipt). */
    routeHash: text('route_hash'),
    /** SmartRouterLedger receipt: the batch transaction that recorded it. */
    ledgerTx: text('ledger_tx'),
    createdAt: createdAt(),
    finishedAt: ts('finished_at'),
  },
  (t) => [
    index('requests_user_created_idx').on(t.userId, t.createdAt.desc()),
    index('requests_compare_group_idx').on(t.compareGroup),
    index('requests_chat_idx').on(t.chatId, t.createdAt),
  ],
)

// ---------- SmartRouter's own provider sessions ----------
export const providerSessions = pgTable('provider_sessions', {
  provider: text('provider').notNull(),
  channelId: text('channel_id').primaryKey(),
  depositMicro: micro('deposit_micro').notNull().default(sql`0`),
  spentMicro: micro('spent_micro').notNull().default(sql`0`),
  lastTopupAt: ts('last_topup_at'),
  status: providerSessionStatusEnum('status').notNull().default('open'),
  createdAt: createdAt(),
})

// ---------- feedback, compare, taste ----------
export const feedback = pgTable(
  'feedback',
  {
    requestId: uuid('request_id').notNull().references(() => requests.id),
    userId: uuid('user_id').notNull().references(() => users.id),
    rating: smallint('rating').notNull(), // +1 / -1
    /** EIP-712 Rating signature (spending key or wallet); relayed to the ledger. */
    sig: text('sig'),
    ledgerTx: text('ledger_tx'),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.requestId, t.userId] })],
)

export const compareVotes = pgTable(
  'compare_votes',
  {
    compareGroup: uuid('compare_group').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id),
    taskType: taskTypeEnum('task_type').notNull(),
    winnerModelId: text('winner_model_id').notNull().references(() => models.id),
    loserModelId: text('loser_model_id').notNull().references(() => models.id),
    winnerRequestId: uuid('winner_request_id'),
    loserRequestId: uuid('loser_request_id'),
    /** EIP-712 Vote signature; relayed to the ledger. */
    sig: text('sig'),
    ledgerTx: text('ledger_tx'),
    createdAt: createdAt(),
  },
  (t) => [index('compare_votes_task_idx').on(t.taskType)],
)

export const userTaste = pgTable(
  'user_taste',
  {
    userId: uuid('user_id').notNull().references(() => users.id),
    taskType: taskTypeEnum('task_type').notNull(),
    modelId: text('model_id').notNull().references(() => models.id, { onDelete: 'cascade' }),
    score: real('score').notNull().default(0),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.taskType, t.modelId] })],
)

// ---------- ops ----------
export const providerHealth = pgTable(
  'provider_health',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    provider: text('provider').notNull(),
    checkedAt: ts('checked_at').notNull().defaultNow(),
    ok: boolean('ok').notNull(),
    latencyMs: integer('latency_ms'),
    error: text('error'),
  },
  (t) => [index('provider_health_provider_checked_idx').on(t.provider, t.checkedAt.desc())],
)

export const treasuryMoves = pgTable(
  'treasury_moves',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: treasuryKindEnum('kind').notNull(),
    amountMicro: micro('amount_micro').notNull(),
    token: text('token').notNull(),
    txHash: text('tx_hash'),
    refId: text('ref_id'), // channel id / request id this move belongs to
    status: txStatusEnum('status').notNull().default('pending'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('treasury_moves_tx_hash_idx').on(t.txHash), index('treasury_moves_kind_created_idx').on(t.kind, t.createdAt)],
)

export const waitlist = pgTable(
  'waitlist',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    country: text('country'),
    interest: waitlistInterestEnum('interest').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('waitlist_email_interest_idx').on(t.email, t.interest)],
)

/**
 * Backs mppx's AtomicStore (channel state, replay markers). update(key, fn) runs under a
 * per-key advisory lock. value is mppx's bigint-aware JSON (ox Json), stored as text.
 */
export const sessionStore = pgTable('session_store', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
})

// ---------- wallet (main wallet deposits and sends; the AI balance lives in user_sessions) ----------

/** Cross-chain deposit addresses (Aurora Intents): one per user per source chain + token. */
export const depositAddresses = pgTable(
  'deposit_addresses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull().default('aurora'),
    sourceChain: text('source_chain').notNull(), // e.g. base
    sourceChainId: integer('source_chain_id').notNull(),
    sourceToken: text('source_token').notNull(), // symbol, e.g. USDC
    sourceTokenAddress: text('source_token_address').notNull(),
    sourceTokenDecimals: integer('source_token_decimals').notNull(),
    address: text('address').notNull(), // where the user sends funds on the source chain
    refundAddress: text('refund_address'),
    providerRef: text('provider_ref'), // quote request id
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('deposit_addresses_user_route_idx').on(t.userId, t.sourceChain, t.sourceToken)],
)

/** Block cursors for chain scanners (e.g. the wallet transfer scanner). */
export const chainCursors = pgTable('chain_cursors', {
  name: text('name').primaryKey(),
  block: bigint('block', { mode: 'bigint' }).notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
})

/** Money in and out of a user's main wallet that went through SmartRouter (activity feed). */
export const walletMoves = pgTable(
  'wallet_moves',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: walletMoveKindEnum('kind').notNull(),
    status: walletMoveStatusEnum('status').notNull().default('pending'),
    /** Amount leaving (send) or arriving (deposit), micro-USD. */
    amountMicro: micro('amount_micro').notNull(),
    /** What actually arrived at the destination, once known. */
    deliveredMicro: micro('delivered_micro'),
    chain: text('chain').notNull(), // the other side: source chain of a deposit, destination of a send
    token: text('token').notNull(),
    counterparty: text('counterparty'), // recipient of a send / deposit address
    txHash: text('tx_hash'), // Monad transaction
    externalId: text('external_id').unique(), // Aurora execution id, or `<txHash>:<logIndex>` for on-chain transfers
    /** Unused in the Monad build (sends are gasless ERC-3009 transfers relayed by the operator). */
    allowedTargets: jsonb('allowed_targets').$type<string[]>(),
    detail: jsonb('detail').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [index('wallet_moves_user_created_idx').on(t.userId, t.createdAt), index('wallet_moves_status_idx').on(t.status)],
)

/** Files users upload into chats (documents; their text goes to the model). Bytes live in R2. */
export const uploads = pgTable(
  'uploads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    objectKey: text('object_key').notNull(),
    filename: text('filename').notNull(),
    mime: text('mime').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    status: text('status').notNull().default('pending'), // pending | ready | failed | deleted
    text: text('text'), // extracted text (capped)
    tokens: integer('tokens'),
    truncated: boolean('truncated').notNull().default(false),
    error: text('error'),
    expiresAt: ts('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('uploads_user_created_idx').on(t.userId, t.createdAt)],
)

/** 6-digit email codes that confirm money leaving a user's wallet; one per send, bound to its amount and recipient. */
export const sendCodes = pgTable(
  'send_codes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** HMAC-SHA256(sessionSecret, id:code) — the code itself is never stored. */
    codeHash: text('code_hash').notNull(),
    chain: text('chain').notNull(),
    token: text('token').notNull(),
    recipient: text('recipient').notNull(),
    amountMicro: micro('amount_micro').notNull(),
    attempts: integer('attempts').notNull().default(0),
    expiresAt: ts('expires_at').notNull(),
    usedAt: ts('used_at'),
    moveId: uuid('move_id'),
    createdAt: createdAt(),
  },
  (t) => [index('send_codes_user_created_idx').on(t.userId, t.createdAt)],
)

/** Network fees the operator paid for a user's own wallet transactions (the daily cap counts these). */
export const sponsoredTxs = pgTable(
  'sponsored_txs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    signPayload: text('sign_payload').notNull().unique(),
    method: text('method').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('sponsored_txs_user_created_idx').on(t.userId, t.createdAt)],
)
