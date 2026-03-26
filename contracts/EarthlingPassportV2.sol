// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

/**
 * @title EarthlingPassportV2
 * @dev Soulbound (non-transferable) ERC-721 passport token
 *      - One passport per wallet
 *      - Owner can burn any passport (moderation)
 *      - Holder can burn their own passport (opt-out)
 *      - Owner can pause minting
 *      - Transfers are blocked (SBT)
 */
contract EarthlingPassportV2 is ERC721, Ownable, Pausable {
    using Strings for uint256;

    // Token counter
    uint256 private _nextTokenId;

    // Base URI for metadata
    string private _baseTokenURI;

    // Passport data
    struct PassportData {
        string earthlingId;
        string pseudonym;
        string verificationHash;
        uint256 mintedAt;
    }

    // Mappings
    mapping(uint256 => PassportData) public passportData;
    mapping(address => bool) public hasPassport;
    mapping(string => uint256) public earthlingIdToToken;

    // Events
    event PassportMinted(
        uint256 indexed tokenId,
        address indexed holder,
        string earthlingId,
        string pseudonym,
        uint256 timestamp
    );

    event PassportBurned(
        uint256 indexed tokenId,
        address indexed holder,
        uint256 timestamp
    );

    constructor() ERC721("Earthling Passport", "EARTH") Ownable(msg.sender) {
        _nextTokenId = 1; // Start from token ID 1
    }

    /**
     * @dev Mint a new passport (only owner)
     * @param to Recipient address
     * @param earthlingId Unique earthling identifier
     * @param pseudonym User pseudonym
     * @param verificationHash KYC verification hash
     */
    function mintPassport(
        address to,
        string memory earthlingId,
        string memory pseudonym,
        string memory verificationHash
    ) external onlyOwner whenNotPaused returns (uint256) {
        require(to != address(0), "Cannot mint to zero address");
        require(!hasPassport[to], "Address already has a passport");
        require(bytes(earthlingId).length > 0, "EarthlingId required");
        require(earthlingIdToToken[earthlingId] == 0, "EarthlingId already used");

        uint256 tokenId = _nextTokenId++;

        _safeMint(to, tokenId);

        passportData[tokenId] = PassportData({
            earthlingId: earthlingId,
            pseudonym: pseudonym,
            verificationHash: verificationHash,
            mintedAt: block.timestamp
        });

        hasPassport[to] = true;
        earthlingIdToToken[earthlingId] = tokenId;

        emit PassportMinted(tokenId, to, earthlingId, pseudonym, block.timestamp);

        return tokenId;
    }

    /**
     * @dev Burn a passport (only contract owner - for moderation)
     * @param tokenId Token to burn
     */
    function burn(uint256 tokenId) external onlyOwner {
        require(_ownerOf(tokenId) != address(0), "Token does not exist");
        address holder = ownerOf(tokenId);
        _burnPassport(tokenId, holder);
    }

    /**
     * @dev Burn own passport (holder can opt-out)
     * @param tokenId Token to burn (must be owned by caller)
     */
    function burnByHolder(uint256 tokenId) external {
        require(ownerOf(tokenId) == msg.sender, "Not the token owner");
        _burnPassport(tokenId, msg.sender);
    }

    /**
     * @dev Internal burn logic
     */
    function _burnPassport(uint256 tokenId, address holder) internal {
        // Clear passport data
        string memory eid = passportData[tokenId].earthlingId;
        delete earthlingIdToToken[eid];
        delete passportData[tokenId];
        hasPassport[holder] = false;

        // Burn the token
        _burn(tokenId);

        emit PassportBurned(tokenId, holder, block.timestamp);
    }

    /**
     * @dev Override _update to make tokens soulbound (non-transferable)
     *      Allows only mint (from == 0) and burn (to == 0)
     */
    function _update(
        address to,
        uint256 tokenId,
        address auth
    ) internal override returns (address) {
        address from = _ownerOf(tokenId);

        // Allow minting (from == 0) and burning (to == 0)
        if (from != address(0) && to != address(0)) {
            revert("Soulbound: transfers are disabled");
        }

        return super._update(to, tokenId, auth);
    }

    // ---- View functions ----

    /**
     * @dev Get total number of minted passports (including burned)
     */
    function totalMinted() external view returns (uint256) {
        return _nextTokenId - 1;
    }

    /**
     * @dev Get total supply (current, excluding burned)
     *      Note: This is a simplified version - counts from 1 to _nextTokenId
     */
    function totalSupply() external view returns (uint256) {
        uint256 count = 0;
        for (uint256 i = 1; i < _nextTokenId; i++) {
            if (_ownerOf(i) != address(0)) {
                count++;
            }
        }
        return count;
    }

    /**
     * @dev Get passport data by token ID
     */
    function getPassport(uint256 tokenId) external view returns (
        string memory earthlingId,
        string memory pseudonym,
        string memory verificationHash,
        uint256 mintedAt,
        address holder
    ) {
        require(_ownerOf(tokenId) != address(0), "Token does not exist");
        PassportData memory pd = passportData[tokenId];
        return (pd.earthlingId, pd.pseudonym, pd.verificationHash, pd.mintedAt, ownerOf(tokenId));
    }

    /**
     * @dev Get token ID by earthling ID
     */
    function getTokenByEarthlingId(string memory earthlingId) external view returns (uint256) {
        uint256 tokenId = earthlingIdToToken[earthlingId];
        require(tokenId != 0, "EarthlingId not found");
        return tokenId;
    }

    // ---- Admin functions ----

    function setBaseURI(string memory baseURI) external onlyOwner {
        _baseTokenURI = baseURI;
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ---- Metadata ----

    function _baseURI() internal view override returns (string memory) {
        return _baseTokenURI;
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        require(_ownerOf(tokenId) != address(0), "Token does not exist");

        string memory baseURI = _baseURI();
        if (bytes(baseURI).length > 0) {
            return string(abi.encodePacked(baseURI, tokenId.toString()));
        }

        // Default: return on-chain data as JSON
        PassportData memory pd = passportData[tokenId];
        return string(abi.encodePacked(
            "data:application/json;utf8,{",
            "\"name\":\"Earthling Passport #", tokenId.toString(), "\",",
            "\"description\":\"Soulbound Earthling Passport\",",
            "\"attributes\":[",
            "{\"trait_type\":\"Earthling ID\",\"value\":\"", pd.earthlingId, "\"},",
            "{\"trait_type\":\"Pseudonym\",\"value\":\"", pd.pseudonym, "\"}",
            "]}"
        ));
    }

    // ---- ERC-165 ----

    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return super.supportsInterface(interfaceId);
    }
}
