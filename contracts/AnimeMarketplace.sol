// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

// Interface for the ERC-2981 royalty standard, used to query the NFT contract
interface IERC2981 {
    function royaltyInfo(uint256 _tokenId, uint256 _salePrice)
        external
        view
        returns (address receiver, uint256 royaltyAmount);
}

contract AnimeMarketplace is ReentrancyGuard {
    
    // --- State Variables ---
    address payable public feeAccount; // The platform wallet (receives the fee)
    uint256 public feePercent;         // Platform fee percentage (e.g., 250 = 2.5%)

    struct Listing {
        uint256 price;
        address payable seller;
        bool active;
    }

    struct Auction {
        uint256 highestBid;
        address payable highestBidder;
        uint256 endTime;
        address payable seller;
        bool active;
    }

    // Mappings: NFT Contract Address -> TokenID -> Data
    mapping(address => mapping(uint256 => Listing)) public listings;
    mapping(address => mapping(uint256 => Auction)) public auctions;

    // --- Events (CRITICAL FOR BACKEND INDEXER) ---
    event ItemListed(address indexed nftContract, uint256 indexed tokenId, uint256 price, address indexed seller);
    event SaleSuccessful(address indexed nftContract, uint256 indexed tokenId, uint256 price, address indexed buyer, address seller);
    event AuctionCreated(address indexed nftContract, uint256 indexed tokenId, uint256 minBid, uint256 endTime);
    event NewBid(address indexed nftContract, uint256 indexed tokenId, uint256 amount, address indexed bidder);
    event AuctionEnded(address indexed nftContract, uint256 indexed tokenId, address winner, uint256 amount);
    event ListingCancelled(address indexed nftContract, uint256 indexed tokenId, address indexed seller, bool isAuction);


    constructor(address payable _feeAccount, uint256 _feePercent) {
        require(_feeAccount != address(0), "Invalid Fee Account");
        feeAccount = _feeAccount;
        feePercent = _feePercent; // Expects value like 250 for 2.5%
    }
    
    // --- 1. Fixed Price Sales ---

    function listCreate(address _nftContract, uint256 _tokenId, uint256 _price) external {
        // Non-Custodial Check: Marketplace must be approved to transfer the token
        IERC721 nft = IERC721(_nftContract);
        require(nft.ownerOf(_tokenId) == msg.sender, "Not Owner");
        require(nft.getApproved(_tokenId) == address(this) || nft.isApprovedForAll(msg.sender, address(this)), "Marketplace not approved");
        require(_price > 0, "Price must be > 0");

        listings[_nftContract][_tokenId] = Listing(_price, payable(msg.sender), true);
        emit ItemListed(_nftContract, _tokenId, _price, msg.sender);
    }

    function buyItem(address _nftContract, uint256 _tokenId) external payable nonReentrant {
        Listing storage item = listings[_nftContract][_tokenId];
        require(item.active, "Listing is inactive");
        require(msg.value >= item.price, "Incorrect ETH sent");

        item.active = false; // Deactivate listing before payment (Reentrancy Guard)
        
        uint256 salePrice = item.price;

        _settlePayment(_nftContract, _tokenId, salePrice, item.seller);

        // Transfer NFT to Buyer
        IERC721(_nftContract).safeTransferFrom(item.seller, msg.sender, _tokenId);
        emit SaleSuccessful(_nftContract, _tokenId, salePrice, msg.sender, item.seller);
    }

    // --- 2. English Auction ---

    function createAuction(address _nftContract, uint256 _tokenId, uint256 _minBid, uint256 _duration) external {
        IERC721 nft = IERC721(_nftContract);
        require(nft.ownerOf(_tokenId) == msg.sender, "Not owner");
        require(nft.getApproved(_tokenId) == address(this) || nft.isApprovedForAll(msg.sender, address(this)), "Not approved");
        require(_minBid > 0, "Min bid must be > 0");

        auctions[_nftContract][_tokenId] = Auction({
            highestBid: _minBid,
            highestBidder: payable(address(0)),
            endTime: block.timestamp + _duration,
            seller: payable(msg.sender),
            active: true
        });

        emit AuctionCreated(_nftContract, _tokenId, _minBid, block.timestamp + _duration);
    }

    function placeBid(address _nftContract, uint256 _tokenId) external payable nonReentrant {
        Auction storage auction = auctions[_nftContract][_tokenId];
        require(auction.active, "Auction not active");
        require(block.timestamp < auction.endTime, "Auction ended");
        require(msg.value > auction.highestBid, "Bid too low");

        // Refund the previous highest bidder
        if (auction.highestBidder != address(0)) {
            // Note: Use `transfer` for simple refunding in this context
            payable(auction.highestBidder).transfer(auction.highestBid);
        }

        auction.highestBid = msg.value;
        auction.highestBidder = payable(msg.sender);

        emit NewBid(_nftContract, _tokenId, msg.value, msg.sender);
    }

    function endAuction(address _nftContract, uint256 _tokenId) external nonReentrant {
        Auction storage auction = auctions[_nftContract][_tokenId];
        require(auction.active, "Auction not active");
        require(block.timestamp >= auction.endTime, "Auction not yet ended");

        auction.active = false; // Deactivate auction immediately

        address winner = auction.highestBidder;
        uint256 winningBid = auction.highestBid;
        address seller = auction.seller;

        if (winner != address(0) && winningBid >= auction.highestBid) {
            // 1. Settle Payment
            _settlePayment(_nftContract, _tokenId, winningBid, payable(seller));
            
            // 2. Transfer NFT
            IERC721(_nftContract).safeTransferFrom(seller, winner, _tokenId);
            emit AuctionEnded(_nftContract, _tokenId, winner, winningBid);
        } else {
            // No valid winner/bids
            emit AuctionEnded(_nftContract, _tokenId, address(0), 0);
        }
    }

    // --- 3. Fee Distribution Logic ---

    function _settlePayment(address _nftContract, uint256 _tokenId, uint256 _price, address payable _seller) internal {
        // 1. Calculate Platform Fee (e.g., 2.5%)
        uint256 platformFee = (_price * feePercent) / 10000;
        
        // 2. Calculate Creator Royalty (EIP-2981)
        uint256 royaltyAmount = 0;
        address royaltyReceiver = address(0);
        
        // Query the NFT contract for its royalty info
        try IERC2981(_nftContract).royaltyInfo(_tokenId, _price) returns (address receiver, uint256 amount) {
            royaltyReceiver = receiver;
            royaltyAmount = amount;
        } catch {}

        // 3. Calculate Net Amount to Seller
        uint256 netToSeller = _price - platformFee - royaltyAmount;

        // 4. Payout Transfers
        feeAccount.transfer(platformFee);
        
        if (royaltyAmount > 0 && royaltyReceiver != address(0)) {
            payable(royaltyReceiver).transfer(royaltyAmount);
        }

        _seller.transfer(netToSeller);
    }
}