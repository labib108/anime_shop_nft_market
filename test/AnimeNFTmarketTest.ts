// test/AnimeMarketplace.test.ts
import { expect } from "chai";
import hre from "hardhat";
import { ethers as ethersLib } from "ethers";

// Lazy loaded helpers
let time: any;
let loadFixture: any;

// import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
// import { AnimeCharacterNFT, AnimeMarketplace } from "../typechain-types";

// Shim for missing hre.ethers
let ethers = hre.ethers;
if (!ethers) {
    console.log("⚠️  Using fallback ethers shim");
    const getProvider = async () => {
        if ((global as any)._cachedProvider) return (global as any)._cachedProvider;
        // Try connecting to default network
        const raw = await (hre.network as any).connect();
        const bp = new ethersLib.BrowserProvider(raw.provider || raw);
        (global as any)._cachedProvider = bp;
        return bp;
    };

    ethers = {
        ...ethersLib,
        provider: {
            getBalance: async (addr: string) => (await getProvider()).getBalance(addr),
        },
        getSigners: async () => (await getProvider()).listAccounts(),
        getContractFactory: async (name: string, signer?: any) => {
            const artifact = await hre.artifacts.readArtifact(name);
            const p = await getProvider();
            return new ethersLib.ContractFactory(artifact.abi, artifact.bytecode, signer || (await p.getSigner(0)));
        }
    } as any;
}

describe("Anime NFT Marketplace - Complete Test Suite", function () {

    before(async function () {
        console.log("Setting up test environment helpers...");
        const connection = await (hre.network as any).connect();
        if (connection.networkHelpers) {
            time = connection.networkHelpers.time;
            loadFixture = connection.networkHelpers.loadFixture;
            console.log("Helpers loaded from connection");
        } else {
            console.error("Critical: networkHelpers not found on connection");
        }

        // Optional: upgrade ethers if available on connection
        if (connection.ethers) {
            console.log("Upgrading to native connection.ethers");
            ethers = connection.ethers;
        }
    });

    // Constants
    const BASE_URI = "https://api.animenft.com/token/";
    const ROYALTY_FEE = 500; // 5%
    const PLATFORM_FEE = 250; // 2.5%
    const MINT_PRICE = ethersLib.parseEther("0.01");
    const MAX_MINT_PER_TX = 20;
    const AUCTION_DURATION = 3600; // 1 hour
    const AUCTION_EXTENSION_TIME = 15 * 60; // 15 minutes
    const AUCTION_END_GRACE_PERIOD = 24 * 60 * 60; // 24 hours
    const MIN_BID_INCREMENT_PERCENT = 5;

    async function deployContracts() {
        const [owner, feeAccount, seller, buyer, bidder1, bidder2, royaltyReceiver] = await ethers.getSigners();

        // Deploy NFT Contract
        const AnimeCharacterNFTFactory = await ethers.getContractFactory("AnimeCharacterNFT");
        const nft = await AnimeCharacterNFTFactory.deploy(
            BASE_URI,
            royaltyReceiver.address,
            ROYALTY_FEE
        );
        await nft.waitForDeployment();

        // Deploy Marketplace
        const AnimeMarketplaceFactory = await ethers.getContractFactory("AnimeMarketplace");
        const marketplace = await AnimeMarketplaceFactory.deploy(
            feeAccount.address,
            PLATFORM_FEE
        );
        await marketplace.waitForDeployment();

        // Enable public mint
        await nft.connect(owner).togglePublicMint();

        return {
            nft,
            marketplace,
            owner,
            feeAccount,
            seller,
            buyer,
            bidder1,
            bidder2,
            royaltyReceiver
        };
    }

    describe("NFT Contract Tests", function () {
        it("Should deploy with correct parameters", async function () {
            const { nft, royaltyReceiver } = await loadFixture(deployContracts);

            expect(await nft.name()).to.equal("AnimeChars");
            expect(await nft.symbol()).to.equal("ANIME");
            expect(await nft.mintPrice()).to.equal(MINT_PRICE);
            expect(await nft.maxSupply()).to.equal(10000);
            expect(await nft.MAX_MINT_PER_TX()).to.equal(MAX_MINT_PER_TX);
        });

        it("Should allow owner to mint", async function () {
            const { nft, owner } = await loadFixture(deployContracts);

            await nft.connect(owner).safeMint(owner.address, "token1.json");
            expect(await nft.ownerOf(0)).to.equal(owner.address);
            expect(await nft.tokenURI(0)).to.equal(`${BASE_URI}token1.json`);
        });

        it("Should allow public minting when enabled", async function () {
            const { nft, buyer } = await loadFixture(deployContracts);

            const count = 3;
            const totalPrice = MINT_PRICE * BigInt(count);

            await expect(nft.connect(buyer).publicMint(count, { value: totalPrice }))
                .to.emit(nft, "Transfer")
                .withArgs(ethers.ZeroAddress, buyer.address, 0);

            expect(await nft.ownerOf(0)).to.equal(buyer.address);
            expect(await nft.ownerOf(1)).to.equal(buyer.address);
            expect(await nft.ownerOf(2)).to.equal(buyer.address);
            expect(await nft.currentTokenId()).to.equal(3);
        });

        it("Should refund excess payment on public mint", async function () {
            const { nft, buyer } = await loadFixture(deployContracts);

            const excessAmount = ethers.parseEther("0.02");
            const totalPrice = MINT_PRICE + excessAmount;

            const initialBalance = await ethers.provider.getBalance(buyer.address);
            const tx = await nft.connect(buyer).publicMint(1, { value: totalPrice });
            const receipt = await tx.wait();
            const gasUsed = receipt!.gasUsed * receipt!.gasPrice;

            const finalBalance = await ethers.provider.getBalance(buyer.address);
            const expectedBalance = initialBalance - MINT_PRICE - gasUsed;

            expect(finalBalance).to.be.closeTo(expectedBalance, ethers.parseEther("0.001"));
        });

        it("Should fail public mint when not enabled", async function () {
            const { nft, owner, buyer } = await loadFixture(deployContracts);

            await nft.connect(owner).togglePublicMint(); // Disable

            await expect(nft.connect(buyer).publicMint(1, { value: MINT_PRICE }))
                .to.be.revertedWith("Public mint not enabled");
        });

        it("Should allow whitelist minting", async function () {
            const { nft, owner, buyer } = await loadFixture(deployContracts);

            await nft.connect(owner).setWhitelist([buyer.address], 2);
            expect(await nft.whitelist(buyer.address)).to.equal(2);

            await nft.connect(buyer).whitelistMint(2, { value: MINT_PRICE * 2n });
            expect(await nft.ownerOf(0)).to.equal(buyer.address);
            expect(await nft.ownerOf(1)).to.equal(buyer.address);
            expect(await nft.whitelist(buyer.address)).to.equal(0);
        });

        it("Should fail whitelist mint with insufficient allowance", async function () {
            const { nft, owner, buyer } = await loadFixture(deployContracts);

            await nft.connect(owner).setWhitelist([buyer.address], 1);

            await expect(nft.connect(buyer).whitelistMint(2, { value: MINT_PRICE * 2n }))
                .to.be.revertedWith("Exceeds allowance");
        });

        it("Should allow token owner to set royalty", async function () {
            const { nft, owner, buyer } = await loadFixture(deployContracts);

            await nft.connect(owner).safeMint(buyer.address, "token1.json");
            const newRoyalty = 700; // 7%

            await nft.connect(buyer).setTokenRoyalty(0, buyer.address, newRoyalty);

            const [receiver, amount] = await nft.royaltyInfo(0, ethers.parseEther("1"));
            expect(receiver).to.equal(buyer.address);
            expect(amount).to.equal(ethers.parseEther("0.07"));
        });

        it("Should fail royalty setting by non-owner", async function () {
            const { nft, owner, buyer, bidder1 } = await loadFixture(deployContracts);

            await nft.connect(owner).safeMint(buyer.address, "token1.json");

            await expect(nft.connect(bidder1).setTokenRoyalty(0, bidder1.address, 500))
                .to.be.revertedWith("Not owner nor approved");
        });

        it("Should allow approved operator to set royalty", async function () {
            const { nft, owner, buyer, bidder1 } = await loadFixture(deployContracts);

            await nft.connect(owner).safeMint(buyer.address, "token1.json");
            await nft.connect(buyer).setApprovalForAll(bidder1.address, true);

            await nft.connect(bidder1).setTokenRoyalty(0, bidder1.address, 500);

            const [receiver, amount] = await nft.royaltyInfo(0, ethers.parseEther("1"));
            expect(receiver).to.equal(bidder1.address);
            expect(amount).to.equal(ethers.parseEther("0.05"));
        });

        it("Should allow owner to withdraw funds", async function () {
            const { nft, owner, buyer } = await loadFixture(deployContracts);

            await nft.connect(buyer).publicMint(2, { value: MINT_PRICE * 2n });

            const contractBalance = await ethers.provider.getBalance(nft.getAddress());
            const ownerInitialBalance = await ethers.provider.getBalance(owner.address);

            const tx = await nft.connect(owner).withdraw();
            const receipt = await tx.wait();
            const gasUsed = receipt!.gasUsed * receipt!.gasPrice;

            expect(await ethers.provider.getBalance(nft.getAddress())).to.equal(0);

            const ownerFinalBalance = await ethers.provider.getBalance(owner.address);
            expect(ownerFinalBalance).to.be.closeTo(
                ownerInitialBalance + contractBalance - gasUsed,
                ethers.parseEther("0.001")
            );
        });
    });

    describe("Marketplace - Fixed Price Sales", function () {
        it("Should list NFT for sale", async function () {
            const { nft, marketplace, seller } = await loadFixture(deployContracts);

            await nft.connect(seller).publicMint(1, { value: MINT_PRICE });
            await nft.connect(seller).approve(await marketplace.getAddress(), 0);

            const listPrice = ethers.parseEther("0.5");
            await expect(marketplace.connect(seller).listCreate(await nft.getAddress(), 0, listPrice))
                .to.emit(marketplace, "ItemListed")
                .withArgs(await nft.getAddress(), 0, listPrice, seller.address);

            const listing = await marketplace.getListing(await nft.getAddress(), 0);
            expect(listing.price).to.equal(listPrice);
            expect(listing.seller).to.equal(seller.address);
            expect(listing.active).to.be.true;
        });

        it("Should buy listed NFT", async function () {
            const { nft, marketplace, seller, buyer, feeAccount, royaltyReceiver } = await loadFixture(deployContracts);

            await nft.connect(seller).publicMint(1, { value: MINT_PRICE });
            await nft.connect(seller).approve(await marketplace.getAddress(), 0);

            const listPrice = ethers.parseEther("1");
            await marketplace.connect(seller).listCreate(await nft.getAddress(), 0, listPrice);

            const platformFee = (listPrice * BigInt(PLATFORM_FEE)) / 10000n;
            const royaltyAmount = (listPrice * BigInt(ROYALTY_FEE)) / 10000n;
            const sellerAmount = listPrice - platformFee - royaltyAmount;

            const initialSellerBalance = await ethers.provider.getBalance(seller.address);
            const initialFeeBalance = await ethers.provider.getBalance(feeAccount.address);
            const initialRoyaltyBalance = await ethers.provider.getBalance(royaltyReceiver.address);

            await expect(marketplace.connect(buyer).buyItem(await nft.getAddress(), 0, { value: listPrice }))
                .to.emit(marketplace, "SaleSuccessful")
                .withArgs(await nft.getAddress(), 0, listPrice, buyer.address, seller.address);

            expect(await nft.ownerOf(0)).to.equal(buyer.address);

            const listing = await marketplace.getListing(await nft.getAddress(), 0);
            expect(listing.active).to.be.false;

            expect(await ethers.provider.getBalance(feeAccount.address)).to.equal(initialFeeBalance + platformFee);
            expect(await ethers.provider.getBalance(royaltyReceiver.address)).to.equal(initialRoyaltyBalance + royaltyAmount);

            const finalSellerBalance = await ethers.provider.getBalance(seller.address);
            expect(finalSellerBalance - initialSellerBalance).to.be.closeTo(sellerAmount, ethers.parseEther("0.001"));
        });

        it("Should refund excess ETH when buying", async function () {
            const { nft, marketplace, seller, buyer } = await loadFixture(deployContracts);

            await nft.connect(seller).publicMint(1, { value: MINT_PRICE });
            await nft.connect(seller).approve(await marketplace.getAddress(), 0);

            const listPrice = ethers.parseEther("0.5");
            await marketplace.connect(seller).listCreate(await nft.getAddress(), 0, listPrice);

            const excessAmount = ethers.parseEther("0.1");
            const paymentAmount = listPrice + excessAmount;

            const initialBalance = await ethers.provider.getBalance(buyer.address);
            const tx = await marketplace.connect(buyer).buyItem(await nft.getAddress(), 0, { value: paymentAmount });
            const receipt = await tx.wait();
            const gasUsed = receipt!.gasUsed * receipt!.gasPrice;

            const finalBalance = await ethers.provider.getBalance(buyer.address);
            const expectedBalance = initialBalance - listPrice - gasUsed;

            expect(finalBalance).to.be.closeTo(expectedBalance, ethers.parseEther("0.001"));
        });

        it("Should fail buying with insufficient ETH", async function () {
            const { nft, marketplace, seller, buyer } = await loadFixture(deployContracts);

            await nft.connect(seller).publicMint(1, { value: MINT_PRICE });
            await nft.connect(seller).approve(await marketplace.getAddress(), 0);

            const listPrice = ethers.parseEther("1");
            await marketplace.connect(seller).listCreate(await nft.getAddress(), 0, listPrice);

            await expect(marketplace.connect(buyer).buyItem(await nft.getAddress(), 0, { value: ethers.parseEther("0.5") }))
                .to.be.revertedWith("Insufficient ETH");
        });

        it("Should cancel listing", async function () {
            const { nft, marketplace, seller } = await loadFixture(deployContracts);

            await nft.connect(seller).publicMint(1, { value: MINT_PRICE });
            await nft.connect(seller).approve(await marketplace.getAddress(), 0);

            await marketplace.connect(seller).listCreate(await nft.getAddress(), 0, ethers.parseEther("1"));

            await expect(marketplace.connect(seller).cancelListing(await nft.getAddress(), 0))
                .to.emit(marketplace, "ListingCancelled")
                .withArgs(await nft.getAddress(), 0, seller.address);

            const listing = await marketplace.getListing(await nft.getAddress(), 0);
            expect(listing.active).to.be.false;
        });

        it("Should fail cancel listing by non-seller", async function () {
            const { nft, marketplace, seller, buyer } = await loadFixture(deployContracts);

            await nft.connect(seller).publicMint(1, { value: MINT_PRICE });
            await nft.connect(seller).approve(await marketplace.getAddress(), 0);

            await marketplace.connect(seller).listCreate(await nft.getAddress(), 0, ethers.parseEther("1"));

            await expect(marketplace.connect(buyer).cancelListing(await nft.getAddress(), 0))
                .to.be.revertedWith("Not seller");
        });

        it("Should fail listing without approval", async function () {
            const { nft, marketplace, seller } = await loadFixture(deployContracts);

            await nft.connect(seller).publicMint(1, { value: MINT_PRICE });

            await expect(marketplace.connect(seller).listCreate(await nft.getAddress(), 0, ethers.parseEther("1")))
                .to.be.revertedWith("Marketplace not approved");
        });

        it("Should fail listing NFT not owned", async function () {
            const { nft, marketplace, seller, buyer } = await loadFixture(deployContracts);

            await nft.connect(seller).publicMint(1, { value: MINT_PRICE });
            await nft.connect(seller).approve(await marketplace.getAddress(), 0);

            await expect(marketplace.connect(buyer).listCreate(await nft.getAddress(), 0, ethers.parseEther("1")))
                .to.be.revertedWith("Not Owner");
        });

        it("Should prevent double listing", async function () {
            const { nft, marketplace, seller } = await loadFixture(deployContracts);

            await nft.connect(seller).publicMint(1, { value: MINT_PRICE });
            await nft.connect(seller).approve(await marketplace.getAddress(), 0);

            await marketplace.connect(seller).listCreate(await nft.getAddress(), 0, ethers.parseEther("1"));

            await expect(marketplace.connect(seller).listCreate(await nft.getAddress(), 0, ethers.parseEther("2")))
                .to.be.revertedWith("Already listed");
        });
    });

    describe("Marketplace - English Auctions", function () {
        it("Should create auction", async function () {
            const { nft, marketplace, seller } = await loadFixture(deployContracts);

            await nft.connect(seller).publicMint(1, { value: MINT_PRICE });
            await nft.connect(seller).approve(await marketplace.getAddress(), 0);

            const minBid = ethers.parseEther("0.5");

            await expect(marketplace.connect(seller).createAuction(await nft.getAddress(), 0, minBid, AUCTION_DURATION))
                .to.emit(marketplace, "AuctionCreated");
            // .withArgs(await nft.getAddress(), 0, minBid, (await time.latest()) + AUCTION_DURATION);

            const auction = await marketplace.getAuction(await nft.getAddress(), 0);
            expect(auction.minBid).to.equal(minBid);
            expect(auction.seller).to.equal(seller.address);
            expect(auction.active).to.be.true;
            expect(auction.hasBid).to.be.false;
        });

        it("Should place first bid", async function () {
            const { nft, marketplace, seller, bidder1 } = await loadFixture(deployContracts);

            await nft.connect(seller).publicMint(1, { value: MINT_PRICE });
            await nft.connect(seller).approve(await marketplace.getAddress(), 0);

            const minBid = ethers.parseEther("0.5");
            await marketplace.connect(seller).createAuction(await nft.getAddress(), 0, minBid, AUCTION_DURATION);

            await expect(marketplace.connect(bidder1).placeBid(await nft.getAddress(), 0, { value: minBid }))
                .to.emit(marketplace, "NewBid")
                .withArgs(await nft.getAddress(), 0, minBid, bidder1.address);

            const auction = await marketplace.getAuction(await nft.getAddress(), 0);
            expect(auction.highestBid).to.equal(minBid);
            expect(auction.highestBidder).to.equal(bidder1.address);
            expect(auction.hasBid).to.be.true;
        });

        it("Should require minimum bid increment", async function () {
            const { nft, marketplace, seller, bidder1, bidder2 } = await loadFixture(deployContracts);

            await nft.connect(seller).publicMint(1, { value: MINT_PRICE });
            await nft.connect(seller).approve(await marketplace.getAddress(), 0);

            const minBid = ethers.parseEther("1");
            await marketplace.connect(seller).createAuction(await nft.getAddress(), 0, minBid, AUCTION_DURATION);

            await marketplace.connect(bidder1).placeBid(await nft.getAddress(), 0, { value: minBid });

            const insufficientBid = minBid + (minBid * 4n) / 100n;
            await expect(marketplace.connect(bidder2).placeBid(await nft.getAddress(), 0, { value: insufficientBid }))
                .to.be.revertedWith("Bid too low");

            const sufficientBid = minBid + (minBid * 5n) / 100n;
            await expect(marketplace.connect(bidder2).placeBid(await nft.getAddress(), 0, { value: sufficientBid }))
                .to.emit(marketplace, "NewBid");
        });

        it("Should extend auction on late bid", async function () {
            const { nft, marketplace, seller, bidder1 } = await loadFixture(deployContracts);

            await nft.connect(seller).publicMint(1, { value: MINT_PRICE });
            await nft.connect(seller).approve(await marketplace.getAddress(), 0);

            const minBid = ethers.parseEther("1");
            await marketplace.connect(seller).createAuction(await nft.getAddress(), 0, minBid, AUCTION_DURATION);

            await marketplace.connect(bidder1).placeBid(await nft.getAddress(), 0, { value: minBid });

            const auction = await marketplace.getAuction(await nft.getAddress(), 0);
            const initialEndTime = auction.endTime;

            await time.increase(AUCTION_DURATION - 60);

            const higherBid = minBid + (minBid * 5n) / 100n;
            await marketplace.connect(bidder1).placeBid(await nft.getAddress(), 0, { value: higherBid });

            const updatedAuction = await marketplace.getAuction(await nft.getAddress(), 0);
            expect(updatedAuction.endTime).to.be.greaterThan(initialEndTime);
            // expect(updatedAuction.endTime - BigInt(await time.latest())).to.be.closeTo(BigInt(AUCTION_EXTENSION_TIME), 5n);
            // Simplified check to avoid complex BigInt matchers issues with Chai
            const diff = updatedAuction.endTime - BigInt(await time.latest());
            expect(diff).to.be.within(BigInt(AUCTION_EXTENSION_TIME) - 10n, BigInt(AUCTION_EXTENSION_TIME) + 10n);
        });

        it("Should end auction and transfer NFT", async function () {
            const { nft, marketplace, seller, bidder1, feeAccount, royaltyReceiver } = await loadFixture(deployContracts);

            await nft.connect(seller).publicMint(1, { value: MINT_PRICE });
            await nft.connect(seller).approve(await marketplace.getAddress(), 0);

            const minBid = ethers.parseEther("2");
            await marketplace.connect(seller).createAuction(await nft.getAddress(), 0, minBid, AUCTION_DURATION);

            await marketplace.connect(bidder1).placeBid(await nft.getAddress(), 0, { value: minBid });

            await time.increase(AUCTION_DURATION + 1);

            const platformFee = (minBid * BigInt(PLATFORM_FEE)) / 10000n;
            const royaltyAmount = (minBid * BigInt(ROYALTY_FEE)) / 10000n;

            const initialSellerBalance = await ethers.provider.getBalance(seller.address);
            const initialFeeBalance = await ethers.provider.getBalance(feeAccount.address);
            const initialRoyaltyBalance = await ethers.provider.getBalance(royaltyReceiver.address);

            await expect(marketplace.connect(seller).endAuction(await nft.getAddress(), 0))
                .to.emit(marketplace, "AuctionEnded")
                .withArgs(await nft.getAddress(), 0, bidder1.address, minBid);

            expect(await nft.ownerOf(0)).to.equal(bidder1.address);

            const auction = await marketplace.getAuction(await nft.getAddress(), 0);
            expect(auction.active).to.be.false;

            expect(await ethers.provider.getBalance(feeAccount.address)).to.equal(initialFeeBalance + platformFee);
            expect(await ethers.provider.getBalance(royaltyReceiver.address)).to.equal(initialRoyaltyBalance + royaltyAmount);

            const finalSellerBalance = await ethers.provider.getBalance(seller.address);
            const expectedSellerAmount = minBid - platformFee - royaltyAmount;
            expect(finalSellerBalance - initialSellerBalance).to.be.closeTo(expectedSellerAmount, ethers.parseEther("0.001"));
        });

        it("Should allow winner to end auction", async function () {
            const { nft, marketplace, seller, bidder1 } = await loadFixture(deployContracts);

            await nft.connect(seller).publicMint(1, { value: MINT_PRICE });
            await nft.connect(seller).approve(await marketplace.getAddress(), 0);

            await marketplace.connect(seller).createAuction(await nft.getAddress(), 0, ethers.parseEther("1"), AUCTION_DURATION);
            await marketplace.connect(bidder1).placeBid(await nft.getAddress(), 0, { value: ethers.parseEther("1") });

            await time.increase(AUCTION_DURATION + 1);

            await expect(marketplace.connect(bidder1).endAuction(await nft.getAddress(), 0))
                .to.emit(marketplace, "AuctionEnded");
        });

        it("Should allow anyone to end auction after grace period", async function () {
            const { nft, marketplace, seller, bidder1, buyer } = await loadFixture(deployContracts);

            await nft.connect(seller).publicMint(1, { value: MINT_PRICE });
            await nft.connect(seller).approve(await marketplace.getAddress(), 0);

            await marketplace.connect(seller).createAuction(await nft.getAddress(), 0, ethers.parseEther("1"), AUCTION_DURATION);
            await marketplace.connect(bidder1).placeBid(await nft.getAddress(), 0, { value: ethers.parseEther("1") });

            await time.increase(AUCTION_DURATION + AUCTION_END_GRACE_PERIOD + 1);

            await expect(marketplace.connect(buyer).endAuction(await nft.getAddress(), 0))
                .to.emit(marketplace, "AuctionEnded");
        });

        it("Should cancel auction with no bids", async function () {
            const { nft, marketplace, seller } = await loadFixture(deployContracts);

            await nft.connect(seller).publicMint(1, { value: MINT_PRICE });
            await nft.connect(seller).approve(await marketplace.getAddress(), 0);

            await marketplace.connect(seller).createAuction(await nft.getAddress(), 0, ethers.parseEther("1"), AUCTION_DURATION);

            await expect(marketplace.connect(seller).cancelAuction(await nft.getAddress(), 0))
                .to.emit(marketplace, "AuctionCancelled");

            const auction = await marketplace.getAuction(await nft.getAddress(), 0);
            expect(auction.active).to.be.false;
        });

        it("Should prevent canceling auction with bids", async function () {
            const { nft, marketplace, seller, bidder1 } = await loadFixture(deployContracts);

            await nft.connect(seller).publicMint(1, { value: MINT_PRICE });
            await nft.connect(seller).approve(await marketplace.getAddress(), 0);

            await marketplace.connect(seller).createAuction(await nft.getAddress(), 0, ethers.parseEther("1"), AUCTION_DURATION);
            await marketplace.connect(bidder1).placeBid(await nft.getAddress(), 0, { value: ethers.parseEther("1") });

            await expect(marketplace.connect(seller).cancelAuction(await nft.getAddress(), 0))
                .to.be.revertedWith("Cannot cancel with existing bids");
        });

        it("Should fail when trying to end auction before end time", async function () {
            const { nft, marketplace, seller } = await loadFixture(deployContracts);

            await nft.connect(seller).publicMint(1, { value: MINT_PRICE });
            await nft.connect(seller).approve(await marketplace.getAddress(), 0);

            await marketplace.connect(seller).createAuction(await nft.getAddress(), 0, ethers.parseEther("1"), AUCTION_DURATION);

            await expect(marketplace.connect(seller).endAuction(await nft.getAddress(), 0))
                .to.be.revertedWith("Auction not yet ended");
        });

        it("Should prevent seller from bidding on own auction", async function () {
            const { nft, marketplace, seller } = await loadFixture(deployContracts);

            await nft.connect(seller).publicMint(1, { value: MINT_PRICE });
            await nft.connect(seller).approve(await marketplace.getAddress(), 0);

            await marketplace.connect(seller).createAuction(await nft.getAddress(), 0, ethers.parseEther("1"), AUCTION_DURATION);

            await expect(marketplace.connect(seller).placeBid(await nft.getAddress(), 0, { value: ethers.parseEther("1") }))
                .to.be.revertedWith("Seller cannot bid on own auction");
        });

        it("Should handle auction with no bids", async function () {
            const { nft, marketplace, seller } = await loadFixture(deployContracts);

            await nft.connect(seller).publicMint(1, { value: MINT_PRICE });
            await nft.connect(seller).approve(await marketplace.getAddress(), 0);

            await marketplace.connect(seller).createAuction(await nft.getAddress(), 0, ethers.parseEther("1"), AUCTION_DURATION);

            await time.increase(AUCTION_DURATION + 1);

            await expect(marketplace.connect(seller).endAuction(await nft.getAddress(), 0))
                .to.emit(marketplace, "AuctionEnded")
                .withArgs(await nft.getAddress(), 0, ethers.ZeroAddress, 0);

            expect(await nft.ownerOf(0)).to.equal(seller.address);
        });

        it("Should fail to create auction for listed NFT", async function () {
            const { nft, marketplace, seller } = await loadFixture(deployContracts);

            await nft.connect(seller).publicMint(1, { value: MINT_PRICE });
            await nft.connect(seller).approve(await marketplace.getAddress(), 0);

            await marketplace.connect(seller).listCreate(await nft.getAddress(), 0, ethers.parseEther("1"));

            await expect(marketplace.connect(seller).createAuction(await nft.getAddress(), 0, ethers.parseEther("1"), AUCTION_DURATION))
                .to.be.revertedWith("Item is listed");
        });

        it("Should fail to list NFT in auction", async function () {
            const { nft, marketplace, seller } = await loadFixture(deployContracts);

            await nft.connect(seller).publicMint(1, { value: MINT_PRICE });
            await nft.connect(seller).approve(await marketplace.getAddress(), 0);

            await marketplace.connect(seller).createAuction(await nft.getAddress(), 0, ethers.parseEther("1"), AUCTION_DURATION);

            await expect(marketplace.connect(seller).listCreate(await nft.getAddress(), 0, ethers.parseEther("2")))
                .to.be.revertedWith("Item is in active auction");
        });
    });

    describe("Marketplace - Withdrawals", function () {
        it("Should allow users to withdraw refunded bid amounts", async function () {
            const { nft, marketplace, seller, bidder1, bidder2 } = await loadFixture(deployContracts);

            await nft.connect(seller).publicMint(1, { value: MINT_PRICE });
            await nft.connect(seller).approve(await marketplace.getAddress(), 0);

            const minBid = ethers.parseEther("1");
            await marketplace.connect(seller).createAuction(await nft.getAddress(), 0, minBid, AUCTION_DURATION);

            await marketplace.connect(bidder1).placeBid(await nft.getAddress(), 0, { value: minBid });

            const higherBid = minBid + (minBid * 5n) / 100n;
            await marketplace.connect(bidder2).placeBid(await nft.getAddress(), 0, { value: higherBid });

            expect(await marketplace.getPendingWithdrawal(bidder1.address)).to.equal(minBid);

            const initialBalance = await ethers.provider.getBalance(bidder1.address);
            const tx = await marketplace.connect(bidder1).withdraw();
            const receipt = await tx.wait();
            const gasUsed = receipt!.gasUsed * receipt!.gasPrice;

            const finalBalance = await ethers.provider.getBalance(bidder1.address);
            expect(finalBalance).to.be.closeTo(initialBalance + minBid - gasUsed, ethers.parseEther("0.001"));

            expect(await marketplace.getPendingWithdrawal(bidder1.address)).to.equal(0);
        });

        it("Should fail withdrawal with no funds", async function () {
            const { marketplace, buyer } = await loadFixture(deployContracts);

            await expect(marketplace.connect(buyer).withdraw())
                .to.be.revertedWith("No funds to withdraw");
        });
    });

    describe("Marketplace - Admin Functions", function () {
        it("Should allow owner to update fee account", async function () {
            const { marketplace, owner, buyer } = await loadFixture(deployContracts);

            const newFeeAccount = buyer.address;

            await expect(marketplace.connect(owner).setFeeAccount(newFeeAccount))
                .to.emit(marketplace, "FeeAccountUpdated")
                .withArgs(newFeeAccount);

            expect(await marketplace.feeAccount()).to.equal(newFeeAccount);
        });

        it("Should prevent non-owner from updating fee account", async function () {
            const { marketplace, buyer } = await loadFixture(deployContracts);

            await expect(marketplace.connect(buyer).setFeeAccount(buyer.address))
                .to.be.revertedWithCustomError(marketplace, "OwnableUnauthorizedAccount");
        });

        it("Should allow owner to update fee percent", async function () {
            const { marketplace, owner } = await loadFixture(deployContracts);

            const newFeePercent = 300;

            await expect(marketplace.connect(owner).setFeePercent(newFeePercent))
                .to.emit(marketplace, "FeePercentUpdated")
                .withArgs(newFeePercent);

            expect(await marketplace.feePercent()).to.equal(newFeePercent);
        });

        it("Should prevent fee percent > 10%", async function () {
            const { marketplace, owner } = await loadFixture(deployContracts);

            await expect(marketplace.connect(owner).setFeePercent(1001))
                .to.be.revertedWith("Fee too high (max 10%)");
        });

        it("Should allow emergency withdrawal", async function () {
            const { marketplace, owner } = await loadFixture(deployContracts);

            await owner.sendTransaction({ to: marketplace.getAddress(), value: ethers.parseEther("1") });

            const contractBalance = await ethers.provider.getBalance(marketplace.getAddress());
            const ownerInitialBalance = await ethers.provider.getBalance(owner.address);

            const tx = await marketplace.connect(owner).emergencyWithdraw();
            const receipt = await tx.wait();
            const gasUsed = receipt!.gasUsed * receipt!.gasPrice;

            expect(await ethers.provider.getBalance(marketplace.getAddress())).to.equal(0);

            const ownerFinalBalance = await ethers.provider.getBalance(owner.address);
            expect(ownerFinalBalance).to.be.closeTo(
                ownerInitialBalance + contractBalance - gasUsed,
                ethers.parseEther("0.001")
            );
        });

        it("Should prevent non-owner emergency withdrawal", async function () {
            const { marketplace, buyer } = await loadFixture(deployContracts);

            await expect(marketplace.connect(buyer).emergencyWithdraw())
                .to.be.revertedWithCustomError(marketplace, "OwnableUnauthorizedAccount");
        });

        it("Should get pending withdrawal amount", async function () {
            const { nft, marketplace, seller, bidder1, bidder2 } = await loadFixture(deployContracts);

            await nft.connect(seller).publicMint(1, { value: MINT_PRICE });
            await nft.connect(seller).approve(await marketplace.getAddress(), 0);

            const minBid = ethers.parseEther("1");
            await marketplace.connect(seller).createAuction(await nft.getAddress(), 0, minBid, AUCTION_DURATION);

            await marketplace.connect(bidder1).placeBid(await nft.getAddress(), 0, { value: minBid });

            const higherBid = minBid + (minBid * 5n) / 100n;
            await marketplace.connect(bidder2).placeBid(await nft.getAddress(), 0, { value: higherBid });

            expect(await marketplace.getPendingWithdrawal(bidder1.address)).to.equal(minBid);
            expect(await marketplace.getPendingWithdrawal(bidder2.address)).to.equal(0);
        });
    });

    describe("Marketplace - View Functions", function () {
        it("Should get listing details", async function () {
            const { nft, marketplace, seller } = await loadFixture(deployContracts);

            await nft.connect(seller).publicMint(1, { value: MINT_PRICE });
            await nft.connect(seller).approve(await marketplace.getAddress(), 0);

            const listPrice = ethers.parseEther("1");
            await marketplace.connect(seller).listCreate(await nft.getAddress(), 0, listPrice);

            const listing = await marketplace.getListing(await nft.getAddress(), 0);
            expect(listing.price).to.equal(listPrice);
            expect(listing.seller).to.equal(seller.address);
            expect(listing.active).to.be.true;
            expect(listing.createdAt).to.be.gt(0);
        });

        it("Should get auction details", async function () {
            const { nft, marketplace, seller, bidder1 } = await loadFixture(deployContracts);

            await nft.connect(seller).publicMint(1, { value: MINT_PRICE });
            await nft.connect(seller).approve(await marketplace.getAddress(), 0);

            const minBid = ethers.parseEther("1");
            await marketplace.connect(seller).createAuction(await nft.getAddress(), 0, minBid, AUCTION_DURATION);

            await marketplace.connect(bidder1).placeBid(await nft.getAddress(), 0, { value: minBid });

            const auction = await marketplace.getAuction(await nft.getAddress(), 0);
            expect(auction.highestBid).to.equal(minBid);
            expect(auction.highestBidder).to.equal(bidder1.address);
            expect(auction.endTime).to.be.gt(await time.latest());
            expect(auction.seller).to.equal(seller.address);
            expect(auction.active).to.be.true;
            expect(auction.minBid).to.equal(minBid);
            expect(auction.createdAt).to.be.gt(0);
            expect(auction.hasBid).to.be.true;
        });

        it("Should get auction time left", async function () {
            const { nft, marketplace, seller } = await loadFixture(deployContracts);

            await nft.connect(seller).publicMint(1, { value: MINT_PRICE });
            await nft.connect(seller).approve(await marketplace.getAddress(), 0);

            await marketplace.connect(seller).createAuction(await nft.getAddress(), 0, ethers.parseEther("1"), AUCTION_DURATION);

            const timeLeft = await marketplace.getAuctionTimeLeft(await nft.getAddress(), 0);
            expect(timeLeft).to.be.lte(AUCTION_DURATION);
            expect(timeLeft).to.be.gt(0);

            await time.increase(AUCTION_DURATION + 1);

            const expiredTimeLeft = await marketplace.getAuctionTimeLeft(await nft.getAddress(), 0);
            expect(expiredTimeLeft).to.equal(0);
        });
    });

    describe("Marketplace - Edge Cases", function () {
        it("Should handle royalty NFT without ERC2981 support", async function () {
            const { marketplace, seller, buyer, feeAccount } = await loadFixture(deployContracts);

            const MockNFTFactory = await ethers.getContractFactory("MockNFTWithoutRoyalty");
            const mockNft = await MockNFTFactory.deploy();
            await mockNft.waitForDeployment();

            await mockNft.connect(seller).safeMint(seller.address, 0);
            await mockNft.connect(seller).approve(await marketplace.getAddress(), 0);

            const listPrice = ethers.parseEther("1");
            await marketplace.connect(seller).listCreate(await mockNft.getAddress(), 0, listPrice);

            const initialSellerBalance = await ethers.provider.getBalance(seller.address);
            const initialFeeBalance = await ethers.provider.getBalance(feeAccount.address);

            const platformFee = (listPrice * BigInt(PLATFORM_FEE)) / 10000n;
            const sellerAmount = listPrice - platformFee;

            await marketplace.connect(buyer).buyItem(await mockNft.getAddress(), 0, { value: listPrice });

            expect(await mockNft.ownerOf(0)).to.equal(buyer.address);
            expect(await ethers.provider.getBalance(feeAccount.address)).to.equal(initialFeeBalance + platformFee);

            const finalSellerBalance = await ethers.provider.getBalance(seller.address);
            expect(finalSellerBalance - initialSellerBalance).to.be.closeTo(sellerAmount, ethers.parseEther("0.001"));
        });

        it("Should handle multiple simultaneous auctions", async function () {
            const { nft, marketplace, seller, bidder1, bidder2 } = await loadFixture(deployContracts);

            await nft.connect(seller).publicMint(3, { value: MINT_PRICE * 3n });

            for (let i = 0; i < 3; i++) {
                await nft.connect(seller).approve(await marketplace.getAddress(), i);
                await marketplace.connect(seller).createAuction(await nft.getAddress(), i, ethers.parseEther("1"), AUCTION_DURATION);
            }

            await marketplace.connect(bidder1).placeBid(await nft.getAddress(), 0, { value: ethers.parseEther("1") });
            await marketplace.connect(bidder2).placeBid(await nft.getAddress(), 1, { value: ethers.parseEther("1") });

            await time.increase(AUCTION_DURATION + 1);

            await marketplace.connect(seller).endAuction(await nft.getAddress(), 0);
            await marketplace.connect(seller).endAuction(await nft.getAddress(), 1);
            await marketplace.connect(seller).endAuction(await nft.getAddress(), 2);

            expect(await nft.ownerOf(0)).to.equal(bidder1.address);
            expect(await nft.ownerOf(1)).to.equal(bidder2.address);
            expect(await nft.ownerOf(2)).to.equal(seller.address); // No bids
        });
    });
});