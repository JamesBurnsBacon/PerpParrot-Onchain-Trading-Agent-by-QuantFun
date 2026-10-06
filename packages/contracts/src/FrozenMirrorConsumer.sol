// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Immutable CRE identity checks and one-time frozen configuration.
/// @dev No custody or exchange execution. Production metadata is 64 bytes:
/// workflow ID (32), name (10), owner (20), report ID (2).
contract FrozenMirrorConsumer {
    address public immutable forwarder;
    address public immutable workflowOwner;
    address public immutable administrator;
    address public immutable account;
    bytes32 public immutable reviewWorkflowId;
    bytes32 public immutable mirrorWorkflowId;
    bytes32 public configurationHash;
    bytes32 public reviewHash;
    uint64 public lastSlot;
    bool public hasMirrorReport;
    bool public paused = true;
    mapping(bytes32 => uint64) public reportExpiryMs;

    event Frozen(bytes32 indexed configurationHash, bytes32 indexed reviewHash);
    event MirrorAccepted(bytes32 indexed reportHash, uint64 indexed slot, uint64 expiresAtMs);
    event PauseChanged(bool paused);
    error InvalidAuthority();
    error InvalidReport();

    constructor(address f, address owner, address admin, address target, bytes32 reviewId, bytes32 mirrorId) {
        if (f == address(0) || f.code.length == 0 || owner == address(0) || admin == address(0) || target == address(0) || reviewId == bytes32(0) || mirrorId == bytes32(0) || reviewId == mirrorId) revert InvalidAuthority();
        forwarder = f; workflowOwner = owner; administrator = admin; account = target;
        reviewWorkflowId = reviewId; mirrorWorkflowId = mirrorId;
    }
    function authority() external view returns (uint256,address,bytes32,bytes32,bool,address,address,bytes32,bytes32,bytes32) {
        return (block.chainid,account,configurationHash,reviewHash,!paused,forwarder,workflowOwner,reviewWorkflowId,mirrorWorkflowId,address(this).codehash);
    }
    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x01ffc9a7 || id == bytes4(keccak256("onReport(bytes,bytes)"));
    }
    function setPaused(bool value) external {
        if (msg.sender != administrator || (!value && configurationHash == bytes32(0))) revert InvalidAuthority();
        paused = value; emit PauseChanged(value);
    }
    function onReport(bytes calldata metadata, bytes calldata report) external {
        if (msg.sender != forwarder || metadata.length != 64 || report.length != 256) revert InvalidAuthority();
        bytes32 workflowId = bytes32(metadata[0:32]);
        address owner = address(bytes20(metadata[42:62]));
        if (owner != workflowOwner) revert InvalidAuthority();
        (uint8 kind, uint256 chain, address target, bytes32 config, bytes32 payloadHash, uint64 slot, uint64 issuedMs, uint64 expiresMs) =
            abi.decode(report, (uint8,uint256,address,bytes32,bytes32,uint64,uint64,uint64));
        uint256 nowMs = block.timestamp * 1000;
        if (chain != block.chainid || target != account || config == bytes32(0) || payloadHash == bytes32(0) || issuedMs > nowMs || expiresMs <= nowMs || expiresMs <= issuedMs || expiresMs - issuedMs > 600000) revert InvalidReport();
        if (kind == 1) {
            if (workflowId != reviewWorkflowId || configurationHash != bytes32(0) || slot != 0) revert InvalidAuthority();
            configurationHash = config; reviewHash = payloadHash;
            emit Frozen(config,payloadHash);
        } else if (kind == 2) {
            if (workflowId != mirrorWorkflowId || paused || config != configurationHash) revert InvalidAuthority();
            if (slot != issuedMs / 600000 || (hasMirrorReport && slot <= lastSlot) || reportExpiryMs[payloadHash] != 0) revert InvalidReport();
            lastSlot = slot; hasMirrorReport = true; reportExpiryMs[payloadHash] = expiresMs;
            emit MirrorAccepted(payloadHash,slot,expiresMs);
        } else revert InvalidReport();
    }
}
