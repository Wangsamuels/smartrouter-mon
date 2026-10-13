// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @dev Circle USDC (FiatToken v2.2): ERC-3009 and EIP-2612.
interface IUSDCAuth {
    function receiveWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external;
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external;
}

/**
 * @title SmartRouterVault
 * @notice The SmartRouter AI balance on Monad.
 *
 * Users deposit USDC once. Every paid answer is authorised off-chain by a signed, cumulative
 * EIP-712 voucher ("I authorise up to X in total"), signed by the user or by a short-lived
 * spending key (the "signer") the user registered. The operator settles only what was
 * actually delivered (`counted`), which may be less than the voucher: answers that failed are
 * never charged. Settlement is attributed to the UTC day of the answers and checked against
 * the user's own daily and weekly caps, which only the user can set.
 *
 * Money can only go to the payee (SmartRouter) through `settle`, or back to the user through
 * `release` (operator) or `withdraw` (user, after a 1-hour notice so in-flight answers can be
 * settled).
 */
contract SmartRouterVault is EIP712, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------ types

    struct Account {
        uint128 balance; // USDC (6 decimals) held for this user
        uint128 settled; // cumulative amount ever settled to the payee
        uint128 dailyCap; // max settled per UTC day (0 = not set up: settle refused)
        uint128 weeklyCap; // max settled per 7-day bucket
        address signer; // spending key allowed to sign vouchers
        uint64 signerExpiry; // unix seconds
        uint64 nonce; // setup nonce (replay protection for relayed setups)
        address prevSigner; // the key replaced by the last setup, honoured for a grace period
        uint64 prevSignerUntil;
        uint64 withdrawAfter; // 0 = no withdraw requested
    }

    // ------------------------------------------------------------------ constants

    uint64 public constant WITHDRAW_DELAY = 1 hours;
    /// @notice Vouchers from an expired or replaced key still settle for this long (answers already given).
    uint64 public constant SIGNER_GRACE = 1 days;
    /// @notice Settlement may be attributed to today or up to this many days back.
    uint256 public constant MAX_BACKDATE_DAYS = 6;

    bytes32 public constant VOUCHER_TYPEHASH = keccak256("Voucher(address user,uint256 cumulativeAmount)");
    bytes32 public constant SETUP_TYPEHASH =
        keccak256("Setup(address user,address signer,uint64 signerExpiry,uint128 dailyCap,uint128 weeklyCap,uint64 nonce,uint256 deadline)");

    // ------------------------------------------------------------------ storage

    IERC20 public immutable usdc;
    address public operator;
    address public payee;

    mapping(address => Account) internal _accounts;
    /// @notice user => UTC day index (unix / 86400) => amount settled for that day
    mapping(address => mapping(uint256 => uint256)) public spentOnDay;
    /// @notice user => week index (day / 7) => amount settled for that week
    mapping(address => mapping(uint256 => uint256)) public spentInWeek;

    // ------------------------------------------------------------------ events

    event Deposited(address indexed user, address indexed from, uint256 amount, uint256 balance);
    event SetupChanged(address indexed user, address indexed signer, uint64 signerExpiry, uint128 dailyCap, uint128 weeklyCap);
    event Settled(address indexed user, uint256 indexed day, uint256 amount, uint256 settledTotal, uint256 balance);
    event Released(address indexed user, uint256 amount);
    event WithdrawRequested(address indexed user, uint64 withdrawAfter);
    event Withdrawn(address indexed user, uint256 amount);
    event OperatorChanged(address operator);
    event PayeeChanged(address payee);

    // ------------------------------------------------------------------ errors

    error NotOperator();
    error ZeroAddress();
    error ZeroAmount();
    error Expired();
    error BadSignature();
    error CapsNotSet();
    error BadCaps();
    error CountedAboveVoucher();
    error NothingToSettle();
    error BadDay();
    error InsufficientBalance();
    error DailyCapExceeded();
    error WeeklyCapExceeded();
    error WithdrawNotReady();
    error Overflow();

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor(IERC20 usdc_, address owner_, address operator_, address payee_) EIP712("SmartRouterVault", "1") Ownable(owner_) {
        if (address(usdc_) == address(0) || operator_ == address(0) || payee_ == address(0)) revert ZeroAddress();
        usdc = usdc_;
        operator = operator_;
        payee = payee_;
        emit OperatorChanged(operator_);
        emit PayeeChanged(payee_);
    }

    // ------------------------------------------------------------------ admin

    function setOperator(address operator_) external onlyOwner {
        if (operator_ == address(0)) revert ZeroAddress();
        operator = operator_;
        emit OperatorChanged(operator_);
    }

    function setPayee(address payee_) external onlyOwner {
        if (payee_ == address(0)) revert ZeroAddress();
        payee = payee_;
        emit PayeeChanged(payee_);
    }

    // ------------------------------------------------------------------ views

    function accountOf(address user) external view returns (Account memory) {
        return _accounts[user];
    }

    function balanceOf(address user) external view returns (uint256) {
        return _accounts[user].balance;
    }

    /// @notice True if `who` may sign vouchers (and ratings) for `user` right now.
    function isAuthorizedSigner(address user, address who) public view returns (bool) {
        if (who == address(0)) return false;
        if (who == user) return true;
        Account storage a = _accounts[user];
        if (who == a.signer && block.timestamp <= uint256(a.signerExpiry) + SIGNER_GRACE) return true;
        if (who == a.prevSigner && block.timestamp <= a.prevSignerUntil) return true;
        return false;
    }

    function voucherDigest(address user, uint256 cumulativeAmount) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(VOUCHER_TYPEHASH, user, cumulativeAmount)));
    }

    function setupDigest(address user, address signer, uint64 signerExpiry, uint128 dailyCap, uint128 weeklyCap, uint64 nonce, uint256 deadline) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(SETUP_TYPEHASH, user, signer, signerExpiry, dailyCap, weeklyCap, nonce, deadline)));
    }

    function today() public view returns (uint256) {
        return block.timestamp / 1 days;
    }

    // ------------------------------------------------------------------ deposits

    /// @notice Deposit from the caller's own wallet (needs a prior approve).
    function deposit(uint256 amount) external nonReentrant {
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        _credit(msg.sender, msg.sender, amount);
    }

    /// @notice Credit `user` with USDC pulled from the caller (cross-chain bridges, gifts).
    function depositFor(address user, uint256 amount) external nonReentrant {
        if (user == address(0)) revert ZeroAddress();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        _credit(user, msg.sender, amount);
    }

    /// @notice Gasless deposit: the user signs an ERC-3009 ReceiveWithAuthorization to this vault; anyone relays it.
    function depositWithAuthorization(address user, uint256 amount, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external nonReentrant {
        IUSDCAuth(address(usdc)).receiveWithAuthorization(user, address(this), amount, validAfter, validBefore, nonce, v, r, s);
        _credit(user, user, amount);
    }

    /// @notice Gasless deposit with an EIP-2612 permit (fallback for tokens without ERC-3009).
    function depositWithPermit(address user, uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external nonReentrant {
        // A front-run permit leaves the allowance in place; carry on if it's already enough.
        try IUSDCAuth(address(usdc)).permit(user, address(this), amount, deadline, v, r, s) {} catch {}
        usdc.safeTransferFrom(user, address(this), amount);
        _credit(user, user, amount);
    }

    function _credit(address user, address from, uint256 amount) internal {
        if (amount == 0) revert ZeroAmount();
        Account storage a = _accounts[user];
        uint256 b = uint256(a.balance) + amount;
        if (b > type(uint128).max) revert Overflow();
        a.balance = uint128(b);
        emit Deposited(user, from, amount, b);
    }

    // ------------------------------------------------------------------ setup (spending key + caps)

    /// @notice Register the spending key and caps with the user's signature; anyone may relay it.
    function setupFor(address user, address signer, uint64 signerExpiry, uint128 dailyCap, uint128 weeklyCap, uint256 deadline, bytes calldata sig) external {
        if (block.timestamp > deadline) revert Expired();
        Account storage a = _accounts[user];
        bytes32 digest = setupDigest(user, signer, signerExpiry, dailyCap, weeklyCap, a.nonce, deadline);
        if (!SignatureChecker.isValidSignatureNow(user, digest, sig)) revert BadSignature();
        _setup(user, a, signer, signerExpiry, dailyCap, weeklyCap);
    }

    /// @notice Same, sent by the user directly.
    function setup(address signer, uint64 signerExpiry, uint128 dailyCap, uint128 weeklyCap) external {
        _setup(msg.sender, _accounts[msg.sender], signer, signerExpiry, dailyCap, weeklyCap);
    }

    function _setup(address user, Account storage a, address signer, uint64 signerExpiry, uint128 dailyCap, uint128 weeklyCap) internal {
        if (dailyCap == 0 || weeklyCap < dailyCap) revert BadCaps();
        unchecked {
            a.nonce++;
        }
        if (a.signer != address(0) && a.signer != signer) {
            a.prevSigner = a.signer;
            uint256 until = block.timestamp + SIGNER_GRACE;
            uint256 cap = uint256(a.signerExpiry) + SIGNER_GRACE;
            a.prevSignerUntil = uint64(until < cap ? until : cap);
        }
        a.signer = signer;
        a.signerExpiry = signerExpiry;
        a.dailyCap = dailyCap;
        a.weeklyCap = weeklyCap;
        emit SetupChanged(user, signer, signerExpiry, dailyCap, weeklyCap);
    }

    // ------------------------------------------------------------------ settlement

    /**
     * @notice Move delivered spend to the payee.
     * @param user              whose balance pays
     * @param cumulativeAuthorized the voucher amount (cumulative, all-time)
     * @param counted           cumulative amount actually delivered; settles counted − settled
     * @param day               UTC day index the answers belong to (today or up to 6 days back)
     * @param voucherSig        EIP-712 Voucher signature by the user or their spending key
     */
    function settle(address user, uint256 cumulativeAuthorized, uint256 counted, uint256 day, bytes calldata voucherSig) external onlyOperator nonReentrant returns (uint256 delta) {
        Account storage a = _accounts[user];
        if (a.dailyCap == 0) revert CapsNotSet();
        if (counted > cumulativeAuthorized) revert CountedAboveVoucher();
        if (counted <= a.settled) revert NothingToSettle();
        uint256 t = today();
        if (day > t || day + MAX_BACKDATE_DAYS < t) revert BadDay();

        bytes32 digest = voucherDigest(user, cumulativeAuthorized);
        if (!_validVoucherSig(user, digest, voucherSig)) revert BadSignature();

        delta = counted - a.settled;
        if (delta > a.balance) revert InsufficientBalance();
        uint256 d = spentOnDay[user][day] + delta;
        if (d > a.dailyCap) revert DailyCapExceeded();
        uint256 w = spentInWeek[user][day / 7] + delta;
        if (w > a.weeklyCap) revert WeeklyCapExceeded();

        spentOnDay[user][day] = d;
        spentInWeek[user][day / 7] = w;
        a.balance -= uint128(delta);
        a.settled = uint128(counted);
        usdc.safeTransfer(payee, delta);
        emit Settled(user, day, delta, counted, a.balance);
    }

    function _validVoucherSig(address user, bytes32 digest, bytes calldata sig) internal view returns (bool) {
        if (SignatureChecker.isValidSignatureNow(user, digest, sig)) return true;
        Account storage a = _accounts[user];
        if (a.signer != address(0) && isAuthorizedSigner(user, a.signer) && SignatureChecker.isValidSignatureNow(a.signer, digest, sig)) return true;
        if (a.prevSigner != address(0) && isAuthorizedSigner(user, a.prevSigner) && SignatureChecker.isValidSignatureNow(a.prevSigner, digest, sig)) return true;
        return false;
    }

    // ------------------------------------------------------------------ returning money

    /// @notice Operator returns the user's whole balance (idle close, "return unused"). Settle first.
    function release(address user) external onlyOperator nonReentrant returns (uint256 amount) {
        Account storage a = _accounts[user];
        amount = a.balance;
        a.balance = 0;
        a.withdrawAfter = 0;
        if (amount > 0) usdc.safeTransfer(user, amount);
        emit Released(user, amount);
    }

    /// @notice Escape hatch: the user can always get their money out, after a short notice.
    function requestWithdraw() external {
        uint64 after_ = uint64(block.timestamp) + WITHDRAW_DELAY;
        _accounts[msg.sender].withdrawAfter = after_;
        emit WithdrawRequested(msg.sender, after_);
    }

    function withdraw() external nonReentrant returns (uint256 amount) {
        Account storage a = _accounts[msg.sender];
        if (a.withdrawAfter == 0 || block.timestamp < a.withdrawAfter) revert WithdrawNotReady();
        amount = a.balance;
        a.balance = 0;
        a.withdrawAfter = 0;
        if (amount > 0) usdc.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }
}
