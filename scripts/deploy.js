const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();

  console.log("=== EarthlingPassportV2 Deployment ===");
  console.log("Deployer:", deployer.address);
  
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Balance:", hre.ethers.formatEther(balance), "POL");
  
  if (balance === 0n) {
    throw new Error("Deployer has no POL for gas!");
  }

  console.log("\nDeploying EarthlingPassportV2...");
  
  const EarthlingPassportV2 = await hre.ethers.getContractFactory("EarthlingPassportV2");
  const passport = await EarthlingPassportV2.deploy();
  
  await passport.waitForDeployment();
  
  const address = await passport.getAddress();
  
  console.log("\n✅ EarthlingPassportV2 deployed!");
  console.log("Contract address:", address);
  console.log("Transaction hash:", passport.deploymentTransaction().hash);
  console.log("\nPolygonscan: https://polygonscan.com/address/" + address);
  
  // Verify deployment
  const name = await passport.name();
  const symbol = await passport.symbol();
  const owner = await passport.owner();
  
  console.log("\n--- Verification ---");
  console.log("Name:", name);
  console.log("Symbol:", symbol);
  console.log("Owner:", owner);
  console.log("\nUpdate .env with:");
  console.log("CONTRACT_ADDRESS=" + address);
  console.log("POLYGON_CONTRACT_ADDRESS=" + address);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Deploy failed:", error);
    process.exit(1);
  });
