
import * as hre from "hardhat"; 

const MAX_SUPPLY = 100;
const BASE_TOKEN_URI = "https://your-ipfs-gateway.com/metadata/"; 
const MINT_PRICE = hre.ethers.parseEther("0.01"); // Use hre.ethers for constants too

async function main() {
  console.log("Starting deployment...");

  // Get the first signer, which will be the deployer (and automatically the contract owner)
  // This account is typically used as the Treasury address for local testing.
  const [deployer] = await hre.ethers.getSigners();
  const TREASURY_ADDRESS = deployer.address;

  // 2. Get the Contract Factory (using hre.ethers)
  const AnimeShopFactory = await hre.ethers.getContractFactory("AnimeShop");

  // 3. Deploy the contract, passing all constructor arguments
  const animeShop = await AnimeShopFactory.deploy(
    MAX_SUPPLY,
    BASE_TOKEN_URI,
    TREASURY_ADDRESS
    // You can also pass a deployment object for initial value or gas options:
    // { value: hre.ethers.parseEther("1.0") }
  );

  // 4. Wait for the contract to be deployed and confirmed
  await animeShop.waitForDeployment();
  
  // 5. Get and print the final contract address
  const contractAddress = await animeShop.getAddress();

  console.log(`\n✅ AnimeShop contract deployed to: ${contractAddress}`);
  console.log(`\nDeployment Parameters Used:`);
  console.log(`  - Deployer/Owner: ${deployer.address}`);
  console.log(`  - Max Supply: ${MAX_SUPPLY}`);
  console.log(`  - Mint Price: ${hre.ethers.formatEther(MINT_PRICE)} ETH`);
  console.log(`  - Treasury Address: ${TREASURY_ADDRESS}`);
}

// Execute the main function and handle any errors
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});