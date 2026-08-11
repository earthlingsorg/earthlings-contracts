// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

/**
 * @title EarthlingPassportV3
 * @dev Soulbound (non-transferable) ERC-721 passport of the Earthlings people.
 *
 * What changed against V2 and why:
 *
 *  1. No single owner. V2 used Ownable, so one key could mint, destroy any
 *     passport, pause issuance and change metadata. Issuance is a routine
 *     operation and destruction is a constitutive one; they must not share a
 *     key. V3 splits them into roles.
 *
 *  2. No unilateral burn. V2 had burn(onlyOwner) documented as "moderation".
 *     The people has no institution of moderation: the Declaration states that
 *     belonging is inalienable and nobody can be excluded. V3 therefore has no
 *     way for any role to destroy a passport immediately. What remains is
 *       - burnByHolder: the holder acts on their own passport, always, and no
 *         role can block it or perform it for them;
 *       - annulment of an invalid issuance: a two-step procedure with a delay.
 *
 *  3. Annulment carries the procedure on chain. The Charter (article 21) grants
 *     the person notice, a period to object, a vote and a right of appeal.
 *     In V2 those guarantees existed only on paper: the transaction executed
 *     instantly. Here a proposal must age MIN_ANNULMENT_DELAY before it can be
 *     executed, the delay can be raised but never lowered, and cancelling is
 *     deliberately easier than executing: a separate role can cancel, which
 *     mirrors the Charter, where reversal on appeal needs a lower threshold
 *     than the annulment itself.
 *
 *  4. Reissue preserves membership. The Charter says a technical reissue does
 *     not interrupt membership. In V2 the only way was burn plus mint, which
 *     produced a new token id and reset the issuance date. V3 has an explicit
 *     reissue that carries earthlingId, verificationHash and the ORIGINAL
 *     issuance date over to the new token.
 *
 *  5. Minting is capped per day. Whoever holds the minter key can create
 *     passports, and a passport is a vote. The cap bounds the damage of a
 *     leaked minter key and is enforced by the contract, not by a service.
 *
 *  6. The last administrator cannot be removed, so the contract cannot be
 *     left unmanageable by a single call.
 *
 * Honest note on the trust that remains. Reissue moves a passport to a new
 * address on the holder's request, and the request is made off chain because a
 * holder who lost wallet access cannot sign anything. The minter role is
 * therefore trusted for reissue. It is logged with its own event and counted
 * against the daily cap, and that is the whole of the mitigation the contract
 * can offer.
 *
 * ABI compatibility. mintPassport, burnByHolder, hasPassport, totalSupply,
 * totalMinted, getPassport, getTokenByEarthlingId, tokenURI and the standard
 * ERC-721 surface keep their V2 signatures, so the calling services need a new
 * ABI blob and a new address, not new logic.
 */
contract EarthlingPassportV3 is ERC721, AccessControl, Pausable {
    using Strings for uint256;

    // ---- Roles ----

    /// @dev Issues passports and performs technical reissues. Held by the
    ///      identity verification service. Revocable at any moment by an admin.
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    /// @dev Proposes and executes annulment of an invalid issuance. Intended
    ///      for the multi-signature wallet of elected signatories.
    bytes32 public constant ANNULMENT_ROLE = keccak256("ANNULMENT_ROLE");

    /// @dev Cancels a pending annulment. Held separately and deliberately at a
    ///      lower threshold than ANNULMENT_ROLE: stopping must be easier than
    ///      proceeding.
    bytes32 public constant CANCEL_ROLE = keccak256("CANCEL_ROLE");

    /// @dev Pauses and unpauses issuance. Intended for emergency response.
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    // ---- Annulment timing ----

    /// @dev The period to object, from article 21 of the Charter. A proposal
    ///      cannot be executed earlier than this, and the delay in force can
    ///      only ever be raised.
    uint256 public constant MIN_ANNULMENT_DELAY = 21 days;

    uint256 public annulmentDelay;

    // ---- The adopted text ----

    /**
     * @dev Hash of the adopted redaction of the Declaration. Zero until adoption.
     *
     * Set once and never again. That is deliberate: a signature binds to the text
     * it was given for, and if the text could be replaced afterwards every
     * signature already collected would become a signature of nothing. Article 26
     * of Regulation (EU) 910/2014 requires an advanced electronic signature to be
     * "linked to the data signed therewith in such a way that any subsequent
     * change in the data is detectable"; a settable-twice hash would fail that.
     */
    bytes32 public declarationHash;

    /// @dev When the adopted text was recorded. Zero until adoption.
    uint64 public adoptedAt;

    // ---- Storage ----

    uint256 private _nextTokenId;
    string private _baseTokenURI;

    struct PassportData {
        string earthlingId;
        string pseudonym;
        string verificationHash;
        uint256 mintedAt;
    }

    /// @dev proposedAt == 0 means "nothing pending". A block timestamp is never
    ///      zero on a live chain, so zero is a safe sentinel; static analysers
    ///      flag the strict comparison, and that flag is expected here.
    struct Annulment {
        uint64 proposedAt;
        string reason;
    }

    mapping(uint256 => PassportData) public passportData;
    mapping(address => bool) public hasPassport;
    mapping(string => uint256) public earthlingIdToToken;

    /// @dev One passport per wallet, so the holder maps to a single token.
    ///      Replaces the linear ownerOf scan the services had to do.
    mapping(address => uint256) private _holderToken;

    mapping(uint256 => Annulment) public annulments;

    /**
     * @dev When the holder of this passport signed the adopted Declaration.
     *      Zero means not signed, and a holder who has not signed is a
     *      participant of the founding, not an earthling.
     *
     *      Kept apart from PassportData on purpose, so that passportData() and
     *      getPassport() keep the shape they have in V2 and the calling services
     *      need no new logic.
     */
    mapping(uint256 => uint64) public signedAt;

    uint256 private _activeSupply;
    uint256 private _signedCount;
    uint256 private _adminCount;

    /// @dev Per day issuance cap. The day is block.timestamp / 1 days.
    uint256 public dailyMintLimit;
    mapping(uint256 => uint256) public mintedOnDay;

    // ---- Events ----

    event PassportMinted(
        uint256 indexed tokenId,
        address indexed holder,
        string earthlingId,
        string pseudonym,
        uint256 timestamp
    );

    /// @dev Kept from V2 so existing indexers continue to work. Emitted on
    ///      every path that destroys a passport, alongside the specific event.
    event PassportBurned(
        uint256 indexed tokenId,
        address indexed holder,
        uint256 timestamp
    );

    event PassportBurnedByHolder(uint256 indexed tokenId, address indexed holder, uint256 timestamp);
    event AnnulmentProposed(uint256 indexed tokenId, address indexed holder, string reason, uint256 executableAt);
    event AnnulmentCancelled(uint256 indexed tokenId, address indexed by, uint256 timestamp);
    event AnnulmentExecuted(uint256 indexed tokenId, address indexed holder, string reason, uint256 timestamp);
    event PassportReissued(
        uint256 indexed oldTokenId,
        uint256 indexed newTokenId,
        address indexed oldHolder,
        address newHolder,
        uint256 originalMintedAt
    );
    event DailyMintLimitChanged(uint256 previous, uint256 current);
    event AnnulmentDelayChanged(uint256 previous, uint256 current);

    /// @dev Emitted once in the life of the contract, on the day of adoption.
    event DeclarationAdopted(bytes32 indexed declarationHash, uint256 timestamp);

    /// @dev The signature itself. The holder's own transaction, nobody else's.
    event DeclarationSigned(
        uint256 indexed tokenId,
        address indexed signatory,
        bytes32 indexed declarationHash,
        uint256 timestamp
    );

    // ---- Errors ----

    error TokenDoesNotExist();
    error AddressAlreadyHasPassport();
    error EarthlingIdRequired();
    error EarthlingIdAlreadyUsed();
    error ZeroAddress();
    error NotTheHolder();
    error SoulboundTransfersDisabled();
    error AnnulmentAlreadyProposed();
    error NoAnnulmentProposed();
    error AnnulmentNotYetExecutable(uint256 executableAt);
    error DelayBelowMinimum();
    error DailyMintLimitReached();
    error LimitMustBePositive();
    error CannotRemoveLastAdmin();
    error DeclarationNotAdopted();
    error DeclarationAlreadyAdopted();
    error EmptyDeclarationHash();
    error NoPassport();
    error AlreadySigned();
    error DeclarationHashMismatch(bytes32 expected, bytes32 actual);

    /**
     * @param admin           Holds DEFAULT_ADMIN_ROLE: grants and revokes roles.
     *                        Should be a multi-signature wallet, never a single key.
     * @param minter          Holds MINTER_ROLE: the issuance service.
     * @param dailyMintLimit_ Initial per day issuance cap.
     */
    constructor(
        address admin,
        address minter,
        uint256 dailyMintLimit_
    ) ERC721("Earthling Passport", "EARTH") {
        if (admin == address(0) || minter == address(0)) revert ZeroAddress();
        if (dailyMintLimit_ == 0) revert LimitMustBePositive();

        _nextTokenId = 1;
        annulmentDelay = MIN_ANNULMENT_DELAY;
        dailyMintLimit = dailyMintLimit_;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, minter);
        // ANNULMENT_ROLE, CANCEL_ROLE and PAUSER_ROLE are intentionally left
        // unassigned. They are granted to elected bodies, and until then no
        // passport can be annulled by anyone.
    }

    // ---- Issuance ----

    /**
     * @dev Signature identical to V2.
     */
    function mintPassport(
        address to,
        string memory earthlingId,
        string memory pseudonym,
        string memory verificationHash
    ) external onlyRole(MINTER_ROLE) whenNotPaused returns (uint256) {
        return _issue(to, earthlingId, pseudonym, verificationHash, block.timestamp);
    }

    /**
     * @dev Technical reissue at the holder's request: on loss of wallet access
     *      or on contract migration. Membership is not interrupted, so the
     *      original issuance date is carried over to the new token.
     */
    function reissue(
        uint256 tokenId,
        address newHolder
    ) external onlyRole(MINTER_ROLE) whenNotPaused returns (uint256) {
        if (_ownerOf(tokenId) == address(0)) revert TokenDoesNotExist();
        if (newHolder == address(0)) revert ZeroAddress();

        address oldHolder = ownerOf(tokenId);
        if (newHolder != oldHolder && hasPassport[newHolder]) revert AddressAlreadyHasPassport();

        PassportData memory pd = passportData[tokenId];
        string memory eid = pd.earthlingId;
        // Подпись должна пережить перевыпуск: человек, потерявший доступ к
        // кошельку, не перестаёт быть earthling из-за технической аварии.
        uint64 signature = signedAt[tokenId];

        // A pending annulment does not survive the token it was aimed at.
        if (annulments[tokenId].proposedAt != 0) {
            delete annulments[tokenId];
            emit AnnulmentCancelled(tokenId, msg.sender, block.timestamp);
        }

        _release(tokenId, oldHolder, eid);

        uint256 newTokenId = _issue(newHolder, eid, pd.pseudonym, pd.verificationHash, pd.mintedAt);

        if (signature != 0) {
            signedAt[newTokenId] = signature;
            _signedCount += 1;
            emit DeclarationSigned(newTokenId, newHolder, declarationHash, signature);
        }

        emit PassportReissued(tokenId, newTokenId, oldHolder, newHolder, pd.mintedAt);
        return newTokenId;
    }

    function _issue(
        address to,
        string memory earthlingId,
        string memory pseudonym,
        string memory verificationHash,
        uint256 mintedAt
    ) internal returns (uint256) {
        if (to == address(0)) revert ZeroAddress();
        if (hasPassport[to]) revert AddressAlreadyHasPassport();
        if (bytes(earthlingId).length == 0) revert EarthlingIdRequired();
        if (earthlingIdToToken[earthlingId] != 0) revert EarthlingIdAlreadyUsed();

        uint256 day = block.timestamp / 1 days;
        uint256 used = mintedOnDay[day] + 1;
        if (used > dailyMintLimit) revert DailyMintLimitReached();
        mintedOnDay[day] = used;

        uint256 tokenId = _nextTokenId++;

        // Bookkeeping is written before _safeMint, not after. _safeMint calls
        // onERC721Received when `to` is a contract, and that callback runs
        // with ownerOf(tokenId) already resolving to `to` - the ERC-721 owner
        // mapping is set before the receiver hook fires. A malicious `to`
        // could call back into burnByHolder from inside that hook: ownership
        // already checks out, so the call would proceed against whatever this
        // function had or had not written yet. With the old order that was an
        // empty passportData and a not-yet-incremented _activeSupply - the
        // reentrant burn underflowed the counter (or, once other passports
        // existed, silently decremented one that was never counted), then
        // this function resumed and wrote real data for a token it had just
        // watched get burned out from under it: a passport with no owner,
        // an earthlingId permanently pointing at a dead token, and a
        // totalSupply one higher than the tokens that actually exist. With
        // the order below, the same reentrant burn instead burns a token
        // whose bookkeeping is already complete and consistent, which is a
        // legitimate (if unusual) instant exit, not a corruption. Covered by
        // "does not let a receiving contract corrupt the registry by burning
        // during onERC721Received" in the test suite.
        passportData[tokenId] = PassportData({
            earthlingId: earthlingId,
            pseudonym: pseudonym,
            verificationHash: verificationHash,
            mintedAt: mintedAt
        });

        hasPassport[to] = true;
        earthlingIdToToken[earthlingId] = tokenId;
        _holderToken[to] = tokenId;
        _activeSupply += 1;

        _safeMint(to, tokenId);

        emit PassportMinted(tokenId, to, earthlingId, pseudonym, block.timestamp);
        return tokenId;
    }

    // ---- Adoption and signing ----

    /**
     * @dev Records the hash of the adopted redaction. Callable once, ever.
     *      Until it is called nobody can sign, which is correct: before the text
     *      is adopted there is nothing to sign.
     */
    function setAdoptedDeclaration(bytes32 hash) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (hash == bytes32(0)) revert EmptyDeclarationHash();
        if (declarationHash != bytes32(0)) revert DeclarationAlreadyAdopted();

        declarationHash = hash;
        adoptedAt = uint64(block.timestamp);

        emit DeclarationAdopted(hash, block.timestamp);
    }

    /**
     * @dev Signing the Declaration. Only the holder of the passport can call it
     *      for their own passport: signing is a personal act, and no role, service
     *      or administrator can perform it for a person or prevent it.
     *
     * @param expectedHash the hash of the text the caller intends to sign. It is a
     *        parameter and not read from storage on purpose: this way the
     *        signatory's own transaction carries the content they are binding
     *        themselves to, rather than binding to whatever the contract happens
     *        to hold. A mismatch reverts.
     */
    function signDeclaration(bytes32 expectedHash) external {
        if (declarationHash == bytes32(0)) revert DeclarationNotAdopted();
        if (expectedHash != declarationHash) {
            revert DeclarationHashMismatch(expectedHash, declarationHash);
        }

        uint256 tokenId = _holderToken[msg.sender];
        if (tokenId == 0) revert NoPassport();
        if (signedAt[tokenId] != 0) revert AlreadySigned();

        signedAt[tokenId] = uint64(block.timestamp);
        _signedCount += 1;

        emit DeclarationSigned(tokenId, msg.sender, declarationHash, block.timestamp);
    }

    // ---- Destruction ----

    /**
     * @dev The holder's own passport, always available, blocked by nothing.
     *      Pausing issuance does not pause the exit.
     *      Signature identical to V2.
     */
    function burnByHolder(uint256 tokenId) external {
        if (_ownerOf(tokenId) == address(0)) revert TokenDoesNotExist();
        if (ownerOf(tokenId) != msg.sender) revert NotTheHolder();

        if (annulments[tokenId].proposedAt != 0) {
            delete annulments[tokenId];
            emit AnnulmentCancelled(tokenId, msg.sender, block.timestamp);
        }

        _release(tokenId, msg.sender, passportData[tokenId].earthlingId);

        emit PassportBurnedByHolder(tokenId, msg.sender, block.timestamp);
        emit PassportBurned(tokenId, msg.sender, block.timestamp);
    }

    /**
     * @dev Step one of an annulment. Records the ground and starts the clock.
     *      Nothing is destroyed here, and the event is the notice.
     */
    function proposeAnnulment(
        uint256 tokenId,
        string memory reason
    ) external onlyRole(ANNULMENT_ROLE) {
        if (_ownerOf(tokenId) == address(0)) revert TokenDoesNotExist();
        if (annulments[tokenId].proposedAt != 0) revert AnnulmentAlreadyProposed();

        annulments[tokenId] = Annulment({proposedAt: uint64(block.timestamp), reason: reason});

        emit AnnulmentProposed(tokenId, ownerOf(tokenId), reason, block.timestamp + annulmentDelay);
    }

    /**
     * @dev Step two. Cannot run before the delay has passed.
     */
    function executeAnnulment(uint256 tokenId) external onlyRole(ANNULMENT_ROLE) {
        if (_ownerOf(tokenId) == address(0)) revert TokenDoesNotExist();

        Annulment memory a = annulments[tokenId];
        if (a.proposedAt == 0) revert NoAnnulmentProposed();

        uint256 executableAt = uint256(a.proposedAt) + annulmentDelay;
        if (block.timestamp < executableAt) revert AnnulmentNotYetExecutable(executableAt);

        address holder = ownerOf(tokenId);
        delete annulments[tokenId];

        _release(tokenId, holder, passportData[tokenId].earthlingId);

        emit AnnulmentExecuted(tokenId, holder, a.reason, block.timestamp);
        emit PassportBurned(tokenId, holder, block.timestamp);
    }

    /**
     * @dev Stops a pending annulment. Held by a separate role on purpose:
     *      cancelling must never be harder than proceeding.
     */
    function cancelAnnulment(uint256 tokenId) external {
        if (!hasRole(CANCEL_ROLE, msg.sender) && !hasRole(ANNULMENT_ROLE, msg.sender)) {
            revert AccessControlUnauthorizedAccount(msg.sender, CANCEL_ROLE);
        }
        if (annulments[tokenId].proposedAt == 0) revert NoAnnulmentProposed();

        delete annulments[tokenId];
        emit AnnulmentCancelled(tokenId, msg.sender, block.timestamp);
    }

    function _release(uint256 tokenId, address holder, string memory eid) internal {
        delete earthlingIdToToken[eid];
        delete passportData[tokenId];
        hasPassport[holder] = false;
        delete _holderToken[holder];
        // Подпись уходит вместе с паспортом: человек, который вышел, больше не
        // earthling, а аннулированная выдача означает, что принадлежность
        // правомерно не возникала.
        if (signedAt[tokenId] != 0) {
            _signedCount -= 1;
            delete signedAt[tokenId];
        }
        _activeSupply -= 1;
        _burn(tokenId);
    }

    // ---- Soulbound ----

    function _update(
        address to,
        uint256 tokenId,
        address auth
    ) internal override returns (address) {
        address from = _ownerOf(tokenId);
        if (from != address(0) && to != address(0)) revert SoulboundTransfersDisabled();
        return super._update(to, tokenId, auth);
    }

    // ---- Views ----

    function totalMinted() external view returns (uint256) {
        return _nextTokenId - 1;
    }

    /// @dev Signature identical to V2, but a counter instead of a loop.
    function totalSupply() external view returns (uint256) {
        return _activeSupply;
    }

    /// @dev One call instead of scanning ownerOf(1..N). Returns 0 if none.
    function tokenOfOwner(address holder) external view returns (uint256) {
        return _holderToken[holder];
    }

    /**
     * @dev Holding a passport and being an earthling are two different things,
     *      and the chain must be able to answer both. A person who confirmed
     *      their identity during the founding period holds a passport but is not
     *      an earthling until they sign the adopted text.
     */
    function isEarthling(address holder) external view returns (bool) {
        uint256 tokenId = _holderToken[holder];
        return tokenId != 0 && signedAt[tokenId] != 0;
    }

    /// @dev How many people have signed the adopted Declaration.
    function earthlingCount() external view returns (uint256) {
        return _signedCount;
    }

    /// @dev True once the adopted text is recorded and signing is possible.
    function isDeclarationAdopted() external view returns (bool) {
        return declarationHash != bytes32(0);
    }

    function getPassport(uint256 tokenId) external view returns (
        string memory earthlingId,
        string memory pseudonym,
        string memory verificationHash,
        uint256 mintedAt,
        address holder
    ) {
        if (_ownerOf(tokenId) == address(0)) revert TokenDoesNotExist();
        PassportData memory pd = passportData[tokenId];
        return (pd.earthlingId, pd.pseudonym, pd.verificationHash, pd.mintedAt, ownerOf(tokenId));
    }

    function getTokenByEarthlingId(string memory earthlingId) external view returns (uint256) {
        uint256 tokenId = earthlingIdToToken[earthlingId];
        if (tokenId == 0) revert TokenDoesNotExist();
        return tokenId;
    }

    /// @dev 0 when nothing is pending.
    function annulmentExecutableAt(uint256 tokenId) external view returns (uint256) {
        uint64 proposedAt = annulments[tokenId].proposedAt;
        if (proposedAt == 0) return 0;
        return uint256(proposedAt) + annulmentDelay;
    }

    function remainingMintsToday() external view returns (uint256) {
        uint256 used = mintedOnDay[block.timestamp / 1 days];
        return used >= dailyMintLimit ? 0 : dailyMintLimit - used;
    }

    // ---- Administration ----

    function setBaseURI(string memory baseURI) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _baseTokenURI = baseURI;
    }

    function setDailyMintLimit(uint256 newLimit) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newLimit == 0) revert LimitMustBePositive();
        emit DailyMintLimitChanged(dailyMintLimit, newLimit);
        dailyMintLimit = newLimit;
    }

    /// @dev The delay can be raised and never lowered below the Charter period.
    function setAnnulmentDelay(uint256 newDelay) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newDelay < MIN_ANNULMENT_DELAY) revert DelayBelowMinimum();
        emit AnnulmentDelayChanged(annulmentDelay, newDelay);
        annulmentDelay = newDelay;
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // ---- Guard against losing administration ----

    function _grantRole(bytes32 role, address account) internal override returns (bool) {
        bool granted = super._grantRole(role, account);
        if (granted && role == DEFAULT_ADMIN_ROLE) {
            _adminCount += 1;
        }
        return granted;
    }

    function _revokeRole(bytes32 role, address account) internal override returns (bool) {
        if (role == DEFAULT_ADMIN_ROLE && hasRole(DEFAULT_ADMIN_ROLE, account) && _adminCount <= 1) {
            revert CannotRemoveLastAdmin();
        }
        bool revoked = super._revokeRole(role, account);
        if (revoked && role == DEFAULT_ADMIN_ROLE) {
            _adminCount -= 1;
        }
        return revoked;
    }

    function adminCount() external view returns (uint256) {
        return _adminCount;
    }

    // ---- Metadata ----

    function _baseURI() internal view override returns (string memory) {
        return _baseTokenURI;
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        if (_ownerOf(tokenId) == address(0)) revert TokenDoesNotExist();

        // string.concat instead of abi.encodePacked: the packed form of several
        // dynamic arguments is ambiguous, and although this result is only ever
        // displayed and never hashed, there is no reason to keep the ambiguity.
        string memory baseURI = _baseURI();
        if (bytes(baseURI).length > 0) {
            return string.concat(baseURI, tokenId.toString());
        }

        PassportData memory pd = passportData[tokenId];
        return string.concat(
            "data:application/json;utf8,{",
            "\"name\":\"Earthling Passport #", tokenId.toString(), "\",",
            "\"description\":\"Soulbound Earthling Passport\",",
            "\"attributes\":[",
            "{\"trait_type\":\"Earthling ID\",\"value\":\"", pd.earthlingId, "\"},",
            "{\"trait_type\":\"Pseudonym\",\"value\":\"", pd.pseudonym, "\"}",
            "]}"
        );
    }

    // ---- ERC-165 ----

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
