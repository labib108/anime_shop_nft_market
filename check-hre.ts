import { ethers as ethersLib } from "ethers";
import hardhat from "hardhat";

console.log("HRE keys:", Object.keys(hardhat));

// Checking if hardhat.ethers exists (it likely doesn't)
if ((hardhat as any).ethers) {
    console.log("hardhat.ethers is present natively");
} else {
    console.log("hardhat.ethers is MISSING - Using fallback");
}

// Alternative: Initialize ethers manually
(async () => {
    console.log("\n--- Setting up Alternative Ethers ---");
    try {
        // 1. Connect to the network to get the provider
        // In this Hardhat version, we might need to call connect()
        const network = hardhat.network as any;
        const connection = network.connect ? await network.connect() : network;

        if (!connection.provider) {
            throw new Error("Could not find provider on network connection");
        }

        console.log("Provider found.");

        // 2. Wrap the EIP-1193 provider with Ethers v6 BrowserProvider
        const provider = new ethersLib.BrowserProvider(connection.provider);

        // 3. Construct the ethers object
        const ethers = {
            ...ethersLib,
            provider,
            getSigners: async () => await provider.listAccounts(),
            getContractFactory: async (name: string, runner?: any) => {
                const artifact = await hardhat.artifacts.readArtifact(name);
                return new ethersLib.ContractFactory(artifact.abi, artifact.bytecode, runner || await provider.getSigner(0));
            }
        };

        console.log("Alternative ethers ready!");

        // Test usage
        const blockNumber = await ethers.provider.getBlockNumber();
        console.log("Current Block Number:", blockNumber);

        const [signer] = await ethers.getSigners();
        if (signer) {
            console.log("Signer address:", signer.address);
            const balance = await ethers.provider.getBalance(signer.address);
            console.log("Signer balance:", ethersLib.formatEther(balance));
        }

    } catch (e) {
        console.error("Failed to setup alternative ethers:", e);
    }
})();
