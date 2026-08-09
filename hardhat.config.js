require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-verify");
require("dotenv").config();

// The settings below are the ones the deployed contract was built with.
// Together with @openzeppelin/contracts pinned to 5.1.0 in package.json they
// reproduce the runtime bytecode of 0x20e7962878429B803E35F83ba34eD291afEC2Be4
// on Polygon byte for byte, metadata hash included. Do not change them without
// re-checking that match.
/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200
      }
    }
  },
  networks: {
    polygon: {
      url: process.env.POLYGON_RPC_URL || "https://polygon-bor-rpc.publicnode.com",
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
      chainId: 137,
      gasPrice: "auto"
    },
    amoy: {
      url: process.env.AMOY_RPC_URL || "https://rpc-amoy.polygon.technology",
      accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
      chainId: 80002,
      gasPrice: "auto"
    },
    hardhat: {
      chainId: 31337
    }
  },
  paths: {
    sources: "./contracts",
    artifacts: "./artifacts"
  },
  etherscan: {
    // Free key from etherscan.io; Polygon is served through the same key.
    apiKey: process.env.ETHERSCAN_API_KEY || ""
  }
};
