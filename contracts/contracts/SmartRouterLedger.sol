// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

interface IVaultSigners {
    function isAuthorizedSigner(address user, address who) external view returns (bool);
}

/**
 * @title SmartRouterLedger
 * @notice Public receipts and ratings for SmartRouter answers on Monad.
 *
 * - Receipts: the operator records one per paid answer (model, price, delivered or failed,
 *   and `routeHash`, the hash of the router agent's decision log). Failed answers are
 *   recorded with status FAILED: anyone can check they were not charged.
 * - Ratings and Compare votes: signed by the user (or their spending key, as registered in the
 *   vault), so nobody — SmartRouter included — can forge them. Anyone may relay them.
 * The public model leaderboard is built from these events.
 */
contract SmartRouterLedger is EIP712, Ownable2Step {
    uint8 public constant STATUS_DELIVERED = 1;
    uint8 public constant STATUS_FAILED = 2;

    struct ReceiptIn {
        bytes16 requestId; // SmartRouter request UUID
        address user;
        string modelId; // e.g. "openrouter:anthropic/claude-sonnet-4.5"
        uint8 taskType; // 0 chat, 1 writing, 2 coding, 3 research, 4 translation, 5 image, 6 music
        uint8 status; // 1 delivered, 2 failed (not charged)
        uint64 priceMicro; // what the user paid (0 when failed)
        bytes32 routeHash; // keccak256 of the router agent's decision log
    }

    struct ReceiptMeta {
        address user;
        bytes32 modelHash;
        uint8 taskType;
        uint8 status;
    }

    struct RatingIn {
        bytes16 requestId;
        int8 score; // +1 / -1
        bytes sig; // EIP-712 Rating by the user or their spending key
    }

    struct VoteIn {
        bytes16 compareGroup;
        bytes16 winnerRequestId;
        bytes16 loserRequestId;
        bytes sig; // EIP-712 Vote
    }

    bytes32 public constant RATING_TYPEHASH = keccak256("Rating(bytes16 requestId,int8 score)");
    bytes32 public constant VOTE_TYPEHASH = keccak256("Vote(bytes16 compareGroup,bytes16 winnerRequestId,bytes16 loserRequestId)");

    IVaultSigners public immutable vault;
    address public operator;

    mapping(bytes16 => ReceiptMeta) public receipts;
    mapping(bytes16 => int8) public ratingOf;
    mapping(bytes16 => bool) public voted;

    event ReceiptRecorded(bytes16 indexed requestId, address indexed user, bytes32 indexed modelHash, string modelId, uint8 taskType, uint8 status, uint64 priceMicro, bytes32 routeHash);
    event Rated(bytes16 indexed requestId, address indexed user, bytes32 indexed modelHash, uint8 taskType, int8 score, int8 previous);
    event Compared(bytes16 indexed compareGroup, address indexed user, uint8 taskType, bytes32 winnerModelHash, bytes32 loserModelHash);
    event Skipped(bytes16 indexed id, uint8 reason);
    event OperatorChanged(address operator);

    // Skip reasons (batch entries never revert the whole batch)
    uint8 internal constant SKIP_DUPLICATE = 1;
    uint8 internal constant SKIP_UNKNOWN = 2;
    uint8 internal constant SKIP_BAD_SIG = 3;
    uint8 internal constant SKIP_INVALID = 4;

    error NotOperator();
    error ZeroAddress();

    constructor(IVaultSigners vault_, address owner_, address operator_) EIP712("SmartRouterLedger", "1") Ownable(owner_) {
        if (address(vault_) == address(0) || operator_ == address(0)) revert ZeroAddress();
        vault = vault_;
        operator = operator_;
        emit OperatorChanged(operator_);
    }

    function setOperator(address operator_) external onlyOwner {
        if (operator_ == address(0)) revert ZeroAddress();
        operator = operator_;
        emit OperatorChanged(operator_);
    }

    function ratingDigest(bytes16 requestId, int8 score) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(RATING_TYPEHASH, requestId, score)));
    }

    function voteDigest(bytes16 compareGroup, bytes16 winnerRequestId, bytes16 loserRequestId) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(VOTE_TYPEHASH, compareGroup, winnerRequestId, loserRequestId)));
    }

    // ------------------------------------------------------------------ receipts

    function recordReceipts(ReceiptIn[] calldata rs) external {
        if (msg.sender != operator) revert NotOperator();
        for (uint256 i; i < rs.length; ++i) {
            ReceiptIn calldata r = rs[i];
            if (receipts[r.requestId].user != address(0)) {
                emit Skipped(r.requestId, SKIP_DUPLICATE);
                continue;
            }
            if (r.user == address(0) || (r.status != STATUS_DELIVERED && r.status != STATUS_FAILED) || (r.status == STATUS_FAILED && r.priceMicro != 0)) {
                emit Skipped(r.requestId, SKIP_INVALID);
                continue;
            }
            bytes32 modelHash = keccak256(bytes(r.modelId));
            receipts[r.requestId] = ReceiptMeta(r.user, modelHash, r.taskType, r.status);
            emit ReceiptRecorded(r.requestId, r.user, modelHash, r.modelId, r.taskType, r.status, r.priceMicro, r.routeHash);
        }
    }

    // ------------------------------------------------------------------ ratings and votes (anyone relays)

    function submitRatings(RatingIn[] calldata xs) external {
        for (uint256 i; i < xs.length; ++i) {
            RatingIn calldata x = xs[i];
            ReceiptMeta memory m = receipts[x.requestId];
            if (m.user == address(0)) {
                emit Skipped(x.requestId, SKIP_UNKNOWN);
                continue;
            }
            if (m.status != STATUS_DELIVERED || (x.score != 1 && x.score != -1)) {
                emit Skipped(x.requestId, SKIP_INVALID);
                continue;
            }
            if (!_signedBy(m.user, ratingDigest(x.requestId, x.score), x.sig)) {
                emit Skipped(x.requestId, SKIP_BAD_SIG);
                continue;
            }
            int8 prev = ratingOf[x.requestId];
            if (prev == x.score) {
                emit Skipped(x.requestId, SKIP_DUPLICATE);
                continue;
            }
            ratingOf[x.requestId] = x.score;
            emit Rated(x.requestId, m.user, m.modelHash, m.taskType, x.score, prev);
        }
    }

    function submitVotes(VoteIn[] calldata xs) external {
        for (uint256 i; i < xs.length; ++i) {
            VoteIn calldata x = xs[i];
            if (voted[x.compareGroup]) {
                emit Skipped(x.compareGroup, SKIP_DUPLICATE);
                continue;
            }
            ReceiptMeta memory w = receipts[x.winnerRequestId];
            ReceiptMeta memory l = receipts[x.loserRequestId];
            if (w.user == address(0) || l.user == address(0)) {
                emit Skipped(x.compareGroup, SKIP_UNKNOWN);
                continue;
            }
            if (w.user != l.user || w.status != STATUS_DELIVERED || w.modelHash == l.modelHash || w.taskType != l.taskType) {
                emit Skipped(x.compareGroup, SKIP_INVALID);
                continue;
            }
            if (!_signedBy(w.user, voteDigest(x.compareGroup, x.winnerRequestId, x.loserRequestId), x.sig)) {
                emit Skipped(x.compareGroup, SKIP_BAD_SIG);
                continue;
            }
            voted[x.compareGroup] = true;
            emit Compared(x.compareGroup, w.user, w.taskType, w.modelHash, l.modelHash);
        }
    }

    function _signedBy(address user, bytes32 digest, bytes calldata sig) internal view returns (bool) {
        (address who, ECDSA.RecoverError err, ) = ECDSA.tryRecover(digest, sig);
        if (err != ECDSA.RecoverError.NoError) return false;
        return vault.isAuthorizedSigner(user, who);
    }
}
