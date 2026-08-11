// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

interface IEarthlingPassportV3 {
    function burnByHolder(uint256 tokenId) external;
}

/**
 * @dev Test-only. Calls burnByHolder on the passport contract from inside
 * onERC721Received, while the mint that produced the token is still in
 * progress on the call stack. Exists to prove (and then, after the fix in
 * EarthlingPassportV3, disprove) that _issue() called _safeMint before its
 * own bookkeeping was complete.
 */
contract ReentrantReceiver is IERC721Receiver {
    address public passport;

    function setPassport(address passport_) external {
        passport = passport_;
    }

    function onERC721Received(
        address,
        address,
        uint256 tokenId,
        bytes calldata
    ) external returns (bytes4) {
        IEarthlingPassportV3(passport).burnByHolder(tokenId);
        return IERC721Receiver.onERC721Received.selector;
    }
}
