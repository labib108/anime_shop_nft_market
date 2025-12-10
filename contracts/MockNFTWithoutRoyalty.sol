// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

contract MockNFTWithoutRoyalty is ERC721 {
    constructor() ERC721("Mock", "MOCK") {}

    function safeMint(address to, uint256 tokenId) external {
        _safeMint(to, tokenId);
    }
}
