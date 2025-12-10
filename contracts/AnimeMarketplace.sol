// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol"; // For ERC20 withdrawal

interface IERC2981 {
    function royaltyInfo(uint256 _tokenId, uint256 _salePrice)
        external
        view
        returns (address receiver, uint256 royaltyAmount);
}

contract AnimeMarketplace is ReentrancyGuard, Ownable {
    
    // --- State Variables ---
    address payable public feeAccount;
    uint256 public feePercent;
    uint256 public constant MIN_BID_INCREMENT_PERCENT = 5;
    uint256 public constant AUCTION_EXTENSION_TIME = 15 minutes;
    uint256 public constant AUCTION_END_GRACE_PERIOD = 24 hours;
    
    mapping(address => uint256) public pendingWithdrawals;

    struct Listing {
        uint256 price;
        address payable seller;
        bool active;
        uint256 createdAt;
    }

    struct Auction {
        uint256 highestBid;
        address payable highestBidder;
        uint256 endTime;
        address payable seller;
        bool active;
        uint256 minBid;
        uint256 createdAt;
        bool hasBid;
    }

    mapping(address => mapping(uint256 => Listing)) public listings;
    mapping(address => mapping(uint256 => Auction)) public auctions;

    // --- Events ---
    event ItemListed(address indexed nftContract, uint256 indexed tokenId, uint256 price, address indexed seller);
    event SaleSuccessful(address indexed nftContract, uint256 indexed tokenId, uint256 price, address indexed buyer, address seller);
    event AuctionCreated(address indexed nftContract, uint256 indexed tokenId, uint256 minBid, uint256 endTime);
    event NewBid(address indexed nftContract, uint256 indexed tokenId, uint256 amount, address indexed bidder);
    event AuctionEnded(address indexed nftContract, uint256 indexed tokenId, address winner, uint256 amount);
    event ListingCancelled(address indexed nftContract, uint256 indexed tokenId, address indexed seller);
    event AuctionCancelled(address indexed nftContract, uint256 indexed tokenId, address indexed seller);
    event Withdrawn(address indexed user, uint256 amount);
    event FeeAccountUpdated(address indexed newAccount);
    event FeePercentUpdated(uint256 newPercent);

    constructor(address payable _feeAccount, uint256 _feePercent) Ownable(msg.sender) {
        require(_feeAccount != address(0), "Invalid Fee Account");
        require(_feePercent <= 1000, "Fee too high (max 1000/10000 = 10%)");
        feeAccount = _feeAccount;
        feePercent = _feePercent;
    }
    
    // --- 1. Fixed Price Sales ---

    function listCreate(address _nftContract, uint256 _tokenId, uint256 _price) external nonReentrant {
        IERC721 nft = IERC721(_nftContract);
        require(nft.ownerOf(_tokenId) == msg.sender, "Not Owner");
        require(nft.getApproved(_tokenId) == address(this) || nft.isApprovedForAll(msg.sender, address(this)), "Marketplace not approved");
        require(_price > 0, "Price must be > 0");
        require(!auctions[_nftContract][_tokenId].active, "Item is in active auction");
        require(!listings[_nftContract][_tokenId].active, "Already listed");

        listings[_nftContract][_tokenId] = Listing({
            price: _price,
            seller: payable(msg.sender),
            active: true,
            createdAt: block.timestamp
        });
        
        emit ItemListed(_nftContract, _tokenId, _price, msg.sender);
    }

    function buyItem(address _nftContract, uint256 _tokenId) external payable nonReentrant {
        Listing storage item = listings[_nftContract][_tokenId];
        require(item.active, "Listing is inactive");
        require(msg.value >= item.price, "Insufficient ETH");

        item.active = false;
        uint256 salePrice = item.price;

        // 1. Settle Payment FIRST (security fix)
        _settlePayment(_nftContract, _tokenId, salePrice, item.seller);
        
        // 2. Transfer NFT AFTER payment
        IERC721(_nftContract).safeTransferFrom(item.seller, msg.sender, _tokenId);

        // 3. Refund excess payment
        uint256 refundAmount = msg.value - salePrice;
        if (refundAmount > 0) {
            _safeTransferETH(payable(msg.sender), refundAmount);
        }
        
        emit SaleSuccessful(_nftContract, _tokenId, salePrice, msg.sender, item.seller);
    }

    function cancelListing(address _nftContract, uint256 _tokenId) external nonReentrant {
        Listing storage listing = listings[_nftContract][_tokenId];
        require(listing.active, "Listing not active");
        require(listing.seller == msg.sender, "Not seller");
        
        listing.active = false;
        emit ListingCancelled(_nftContract, _tokenId, msg.sender);
    }

    // --- 2. English Auction ---

    function createAuction(address _nftContract, uint256 _tokenId, uint256 _minBid, uint256 _duration) external {
        IERC721 nft = IERC721(_nftContract);
        require(nft.ownerOf(_tokenId) == msg.sender, "Not owner");
        require(nft.getApproved(_tokenId) == address(this) || nft.isApprovedForAll(msg.sender, address(this)), "Not approved");
        require(_minBid > 0, "Min bid must be > 0");
        require(_duration >= 1 hours && _duration <= 30 days, "Invalid duration (1h to 30d)");
        require(!listings[_nftContract][_tokenId].active, "Item is listed");
        require(!auctions[_nftContract][_tokenId].active, "Already in auction");

        auctions[_nftContract][_tokenId] = Auction({
            highestBid: _minBid, // This is just the starting point
            highestBidder: payable(address(0)),
            endTime: block.timestamp + _duration,
            seller: payable(msg.sender),
            active: true,
            minBid: _minBid,
            createdAt: block.timestamp,
            hasBid: false
        });

        emit AuctionCreated(_nftContract, _tokenId, _minBid, block.timestamp + _duration);
    }

    function placeBid(address _nftContract, uint256 _tokenId) external payable nonReentrant {
        Auction storage auction = auctions[_nftContract][_tokenId];
        require(auction.active, "Auction not active");
        require(block.timestamp < auction.endTime, "Auction ended");
        require(msg.sender != auction.seller, "Seller cannot bid on own auction");
        
        // Calculate minimum bid amount
        uint256 minBid;
        if (!auction.hasBid) {
            // First bid must be >= minBid
            minBid = auction.minBid;
        } else {
            // Subsequent bids must be >= highestBid + increment
            minBid = auction.highestBid + (auction.highestBid * MIN_BID_INCREMENT_PERCENT) / 100;
        }
        
        require(msg.value >= minBid, "Bid too low");

        // Store previous bidder's refund
        if (auction.hasBid && auction.highestBidder != address(0)) {
            pendingWithdrawals[auction.highestBidder] += auction.highestBid;
        }

        auction.highestBid = msg.value;
        auction.highestBidder = payable(msg.sender);
        auction.hasBid = true;

        // Extend auction if bid placed near end
        if (auction.endTime - block.timestamp < AUCTION_EXTENSION_TIME) {
            auction.endTime = block.timestamp + AUCTION_EXTENSION_TIME;
        }

        emit NewBid(_nftContract, _tokenId, msg.value, msg.sender);
    }

    function endAuction(address _nftContract, uint256 _tokenId) external nonReentrant {
        Auction storage auction = auctions[_nftContract][_tokenId];
        require(auction.active, "Auction not active");
        require(block.timestamp > auction.endTime, "Auction not yet ended"); // Changed >= to >

        // Authorization check
        bool canEnd = msg.sender == auction.seller || 
                     (auction.hasBid && msg.sender == auction.highestBidder) || 
                     block.timestamp >= auction.endTime + AUCTION_END_GRACE_PERIOD;
        require(canEnd, "Not authorized to end");

        auction.active = false;

        if (auction.hasBid && auction.highestBidder != address(0)) {
            // Successful auction
            _settlePayment(_nftContract, _tokenId, auction.highestBid, auction.seller);
            IERC721(_nftContract).safeTransferFrom(auction.seller, auction.highestBidder, _tokenId);
            emit AuctionEnded(_nftContract, _tokenId, auction.highestBidder, auction.highestBid);
        } else {
            // No valid bids
            emit AuctionEnded(_nftContract, _tokenId, address(0), 0);
        }
    }

    function cancelAuction(address _nftContract, uint256 _tokenId) external nonReentrant {
        Auction storage auction = auctions[_nftContract][_tokenId];
        require(auction.active, "Auction not active");
        require(auction.seller == msg.sender, "Not seller");
        require(!auction.hasBid, "Cannot cancel with existing bids");
        
        auction.active = false;
        emit AuctionCancelled(_nftContract, _tokenId, msg.sender);
    }

    // --- 3. Fee Distribution Logic ---

    function _settlePayment(address _nftContract, uint256 _tokenId, uint256 _price, address payable _seller) internal {
        uint256 platformFee = (_price * feePercent) / 10000;
        uint256 royaltyAmount = 0;
        address payable royaltyReceiver = payable(address(0));
        
        try IERC2981(_nftContract).royaltyInfo(_tokenId, _price) returns (address receiver, uint256 amount) {
            if (amount > 0 && receiver != address(0)) {
                royaltyReceiver = payable(receiver);
                royaltyAmount = amount;
                // Cap royalty to prevent overflow
                if (royaltyAmount + platformFee > _price) {
                    royaltyAmount = _price - platformFee;
                }
            }
        } catch {}
        
        uint256 netToSeller = _price - platformFee - royaltyAmount;
        
        // Transfer payments
        if (platformFee > 0) {
            _safeTransferETH(feeAccount, platformFee);
        }
        
        if (royaltyAmount > 0 && royaltyReceiver != address(0)) {
            _safeTransferETH(royaltyReceiver, royaltyAmount);
        }

        if (netToSeller > 0) {
            _safeTransferETH(_seller, netToSeller);
        }
    }

    // --- 4. Safe ETH Transfer ---
    function _safeTransferETH(address payable to, uint256 amount) internal {
        (bool success, ) = to.call{value: amount}("");
        require(success, "ETH transfer failed");
    }

    // --- 5. Withdrawal Function ---
    function withdraw() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        require(amount > 0, "No funds to withdraw");
        
        pendingWithdrawals[msg.sender] = 0;
        _safeTransferETH(payable(msg.sender), amount);
        
        emit Withdrawn(msg.sender, amount);
    }

    // --- 6. Admin Functions ---
    
    function setFeeAccount(address payable _feeAccount) external onlyOwner {
        require(_feeAccount != address(0), "Invalid address");
        feeAccount = _feeAccount;
        emit FeeAccountUpdated(_feeAccount);
    }
    
    function setFeePercent(uint256 _feePercent) external onlyOwner {
        require(_feePercent <= 1000, "Fee too high (max 10%)");
        feePercent = _feePercent;
        emit FeePercentUpdated(_feePercent);
    }
    
    function withdrawERC20(IERC20 token, address to) external onlyOwner {
        uint256 balance = token.balanceOf(address(this));
        require(balance > 0, "No tokens to withdraw");
        token.transfer(to, balance);
    }

    function emergencyWithdraw() external onlyOwner {
        uint256 balance = address(this).balance;
        require(balance > 0, "No funds");
        _safeTransferETH(payable(msg.sender), balance);
    }
    
    function getPendingWithdrawal(address user) external view returns (uint256) {
        return pendingWithdrawals[user];
    }

    // --- 7. View Functions ---
    
    function getListing(address _nftContract, uint256 _tokenId) external view returns (
        uint256 price,
        address seller,
        bool active,
        uint256 createdAt
    ) {
        Listing memory listing = listings[_nftContract][_tokenId];
        return (listing.price, listing.seller, listing.active, listing.createdAt);
    }

    function getAuction(address _nftContract, uint256 _tokenId) external view returns (
        uint256 highestBid,
        address highestBidder,
        uint256 endTime,
        address seller,
        bool active,
        uint256 minBid,
        uint256 createdAt,
        bool hasBid
    ) {
        Auction memory auction = auctions[_nftContract][_tokenId];
        return (
            auction.highestBid,
            auction.highestBidder,
            auction.endTime,
            auction.seller,
            auction.active,
            auction.minBid,
            auction.createdAt,
            auction.hasBid
        );
    }

    function getAuctionTimeLeft(address _nftContract, uint256 _tokenId) external view returns (uint256) {
        Auction memory auction = auctions[_nftContract][_tokenId];
        if (!auction.active || block.timestamp >= auction.endTime) return 0;
        return auction.endTime - block.timestamp;
    }

    // --- 8. Receive ETH ---
    receive() external payable {}
}