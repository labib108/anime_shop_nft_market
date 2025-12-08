// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// OpenZeppelin 5.x imports
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721Royalty.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Strings.sol";

contract AnimeCharacterNFT is ERC721URIStorage, ERC721Royalty, Ownable, ReentrancyGuard {
    using Strings for uint256;

    // --- State Variables ---
    uint256 private _nextTokenId;
    uint256 public mintPrice = 0.01 ether;
    uint256 public maxSupply = 10000;
    bool public publicMintEnabled = false;
    uint256 public constant MAX_MINT_PER_TX = 20;
    
    mapping(address => uint256) public whitelist;
    string private _baseTokenURI;
    bool private _useBaseURI = true;

    // --- Constructor ---
    constructor(
        string memory baseURI,
        address royaltyReceiver,
        uint96 feeNumerator
    ) ERC721("AnimeChars", "ANIME") Ownable(msg.sender) {
        _setDefaultRoyalty(royaltyReceiver, feeNumerator);
        _baseTokenURI = baseURI;
    }

    function tokenURI(uint256 tokenId) 
        public 
        view 
        override(ERC721URIStorage, ERC721) 
        returns (string memory) 
    {
        return super.tokenURI(tokenId);
    }

    // --- MINTING FUNCTIONS ---
    
    function safeMint(address to, string memory uri) public onlyOwner returns (uint256) {
        require(_nextTokenId < maxSupply, "Max supply reached");
        uint256 tokenId = _nextTokenId++;
        _safeMint(to, tokenId);
        _setTokenURI(tokenId, uri);
        return tokenId;
    }

    function publicMint(uint256 count) external payable nonReentrant {
        require(publicMintEnabled, "Public mint not enabled");
        require(count > 0 && count <= MAX_MINT_PER_TX, "Invalid mint count");
        require(_nextTokenId + count <= maxSupply, "Exceeds max supply");
        uint256 totalCost = mintPrice * count;
        require(msg.value >= totalCost, "Insufficient payment");

        for (uint256 i = 0; i < count; i++) {
            uint256 tokenId = _nextTokenId++;
            _safeMint(msg.sender, tokenId);
            
            if (_useBaseURI) {
                _setTokenURI(
                    tokenId, 
                    string(abi.encodePacked(tokenId.toString(), ".json"))
                );
            }
        }
        
        uint256 refundAmount = msg.value - totalCost;
        if (refundAmount > 0) {
            (bool success, ) = payable(msg.sender).call{value: refundAmount}("");
            require(success, "Refund failed");
        }
    }

    function whitelistMint(uint256 count) external payable nonReentrant {
        uint256 maxAllowed = whitelist[msg.sender];
        require(maxAllowed >= count, "Exceeds allowance");
        require(count > 0 && count <= MAX_MINT_PER_TX, "Invalid count");
        require(_nextTokenId + count <= maxSupply, "Exceeds supply");
        uint256 totalCost = mintPrice * count;
        require(msg.value >= totalCost, "Insufficient payment");

        whitelist[msg.sender] = maxAllowed - count;

        for (uint256 i = 0; i < count; i++) {
            uint256 tokenId = _nextTokenId++;
            _safeMint(msg.sender, tokenId);
            
            if (_useBaseURI) {
                _setTokenURI(
                    tokenId, 
                    string(abi.encodePacked(tokenId.toString(), ".json"))
                );
            }
        }

        uint256 refundAmount = msg.value - totalCost;
        if (refundAmount > 0) {
            (bool success, ) = payable(msg.sender).call{value: refundAmount}("");
            require(success, "Refund failed");
        }
    }

    // --- UTILITY FUNCTIONS ---
    
    function setTokenRoyalty(uint256 tokenId, address receiver, uint96 feeNumerator) external {
    address owner = ownerOf(tokenId);
    
        require(
            owner == _msgSender() || 
            getApproved(tokenId) == _msgSender() || 
            isApprovedForAll(owner, _msgSender()), 
            "Not owner nor approved"
        );

    _setTokenRoyalty(tokenId, receiver, feeNumerator);
    }

    function setWhitelist(address[] calldata users, uint256 maxMints) external onlyOwner {
        for (uint256 i = 0; i < users.length; i++) {
            whitelist[users[i]] = maxMints;
        }
    }

    function setBaseURI(string memory baseURI) external onlyOwner {
        _baseTokenURI = baseURI;
    }
    
    function toggleBaseURIMode() external onlyOwner {
        _useBaseURI = !_useBaseURI;
    }

    function togglePublicMint() external onlyOwner {
        publicMintEnabled = !publicMintEnabled;
    }

    function setMintPrice(uint256 newPrice) external onlyOwner {
        mintPrice = newPrice;
    }

    function setMaxSupply(uint256 newMaxSupply) external onlyOwner {
        require(newMaxSupply >= _nextTokenId, "Cannot set below current");
        maxSupply = newMaxSupply;
    }

    function withdraw() external onlyOwner nonReentrant {
        uint256 balance = address(this).balance;
        require(balance > 0, "No balance");
        (bool success, ) = payable(owner()).call{value: balance}("");
        require(success, "Transfer failed");
    }

    // --- OVERRIDES ---
    
    function _baseURI() internal view override returns (string memory) {
        return _baseTokenURI;
    }

    // function _burn(uint256 tokenId) internal override(ERC721, ERC721URIStorage, ERC721Royalty) {
    //     super._burn(tokenId);
    // }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721URIStorage, ERC721Royalty)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
    
    function currentTokenId() external view returns (uint256) {
        return _nextTokenId;
    }
}