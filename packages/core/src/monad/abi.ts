/** ABIs of the SmartRouter contracts on Monad (contracts/contracts/*.sol), as viem const ABIs. */
import { parseAbi } from 'viem'

export const vaultAbi = parseAbi([
  'struct Account { uint128 balance; uint128 settled; uint128 dailyCap; uint128 weeklyCap; address signer; uint64 signerExpiry; uint64 nonce; address prevSigner; uint64 prevSignerUntil; uint64 withdrawAfter; }',
  'function accountOf(address user) view returns (Account)',
  'function balanceOf(address user) view returns (uint256)',
  'function isAuthorizedSigner(address user, address who) view returns (bool)',
  'function spentOnDay(address user, uint256 day) view returns (uint256)',
  'function spentInWeek(address user, uint256 week) view returns (uint256)',
  'function today() view returns (uint256)',
  'function payee() view returns (address)',
  'function operator() view returns (address)',
  'function usdc() view returns (address)',
  'function depositFor(address user, uint256 amount)',
  'function depositWithAuthorization(address user, uint256 amount, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)',
  'function depositWithPermit(address user, uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
  'function setupFor(address user, address signer, uint64 signerExpiry, uint128 dailyCap, uint128 weeklyCap, uint256 deadline, bytes sig)',
  'function settle(address user, uint256 cumulativeAuthorized, uint256 counted, uint256 day, bytes voucherSig) returns (uint256)',
  'function release(address user) returns (uint256)',
  'event Deposited(address indexed user, address indexed from, uint256 amount, uint256 balance)',
  'event SetupChanged(address indexed user, address indexed signer, uint64 signerExpiry, uint128 dailyCap, uint128 weeklyCap)',
  'event Settled(address indexed user, uint256 indexed day, uint256 amount, uint256 settledTotal, uint256 balance)',
  'event Released(address indexed user, uint256 amount)',
  'event WithdrawRequested(address indexed user, uint64 withdrawAfter)',
  'event Withdrawn(address indexed user, uint256 amount)',
  'error NotOperator()',
  'error ZeroAddress()',
  'error ZeroAmount()',
  'error Expired()',
  'error BadSignature()',
  'error CapsNotSet()',
  'error BadCaps()',
  'error CountedAboveVoucher()',
  'error NothingToSettle()',
  'error BadDay()',
  'error InsufficientBalance()',
  'error DailyCapExceeded()',
  'error WeeklyCapExceeded()',
  'error WithdrawNotReady()',
  'error Overflow()',
])

export const ledgerAbi = parseAbi([
  'struct ReceiptIn { bytes16 requestId; address user; string modelId; uint8 taskType; uint8 status; uint64 priceMicro; bytes32 routeHash; }',
  'struct RatingIn { bytes16 requestId; int8 score; bytes sig; }',
  'struct VoteIn { bytes16 compareGroup; bytes16 winnerRequestId; bytes16 loserRequestId; bytes sig; }',
  'function recordReceipts(ReceiptIn[] rs)',
  'function submitRatings(RatingIn[] xs)',
  'function submitVotes(VoteIn[] xs)',
  'function receipts(bytes16 requestId) view returns (address user, bytes32 modelHash, uint8 taskType, uint8 status)',
  'event ReceiptRecorded(bytes16 indexed requestId, address indexed user, bytes32 indexed modelHash, string modelId, uint8 taskType, uint8 status, uint64 priceMicro, bytes32 routeHash)',
  'event Rated(bytes16 indexed requestId, address indexed user, bytes32 indexed modelHash, uint8 taskType, int8 score, int8 previous)',
  'event Compared(bytes16 indexed compareGroup, address indexed user, uint8 taskType, bytes32 winnerModelHash, bytes32 loserModelHash)',
  'event Skipped(bytes16 indexed id, uint8 reason)',
])

/** Order matches the ledger's uint8 taskType. */
export const TASK_TYPE_CODES = ['chat', 'writing', 'coding', 'research', 'translation', 'image', 'music'] as const
export const taskTypeCode = (t: string) => Math.max(0, TASK_TYPE_CODES.indexOf(t as (typeof TASK_TYPE_CODES)[number]))

/** UUID → bytes16 for the ledger. */
export const uuidToBytes16 = (id: string) => `0x${id.replace(/-/g, '').toLowerCase()}` as `0x${string}`
export const bytes16ToUuid = (b: string) => {
  const h = b.replace(/^0x/, '').toLowerCase()
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}
