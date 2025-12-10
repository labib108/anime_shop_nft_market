import * as dotenv from "dotenv";
dotenv.config();

import hardhatToolboxMochaEthersPlugin from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import hardhatEthers from "@nomicfoundation/hardhat-ethers";
import { defineConfig } from "hardhat/config";

console.log("LOADING HARDHAT CONFIG");
// console.log("hardhatEthers plugin:", hardhatEthers);
export default defineConfig({
  plugins: [hardhatEthers, hardhatToolboxMochaEthersPlugin],
  solidity: {
    profiles: {
      default: {
        version: "0.8.28",
      },
      production: {
        version: "0.8.28",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
        },
      },
    },
  },
  networks: {
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
    },
    hardhatOp: {
      type: "edr-simulated",
      chainType: "op",
    },
    ...(process.env.SEPOLIA_RPC_URL ? {
      sepolia: {
        type: "http",
        url: process.env.SEPOLIA_RPC_URL,
        accounts: process.env.SEPOLIA_PRIVATE_KEY ? [process.env.SEPOLIA_PRIVATE_KEY] : [],
      },
    } : {}),
  },
});
