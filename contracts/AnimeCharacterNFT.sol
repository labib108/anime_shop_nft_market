// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Royalty.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract AnimeCharacterNFT is ERC721URIStorage, ERC721Royalty, Ownable {
    uint256 private _nextTokenId;

    // Constructor: Sets name, symbol, and DEFAULT Royalty (e.g., 500 = 5%)
    constructor(address initialOwner, address royaltyReceiver, uint96 feeNumerator)
        ERC721("AnimeChars", "ANIME")
        Ownable(initialOwner)
    {
        // Set the default royalty for the entire collection
        _setDefaultRoyalty(royaltyReceiver, feeNumerator);
    }

    // Minting Function: Only the owner (you/backend) can create new characters
    function safeMint(address to, string memory uri) public onlyOwner returns (uint256) {
        uint256 tokenId = _nextTokenId++;
        _safeMint(to, tokenId);
        _setTokenURI(tokenId, uri);
        return tokenId;
    }

    // The following functions are overrides required by Solidity
    function tokenURI(uint256 tokenId)
        public
        view
        override( ERC721URIStorage, ERC721)
        returns (string memory)
    {
        return super.tokenURI(tokenId);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721URIStorage, ERC721Royalty)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}