// Д9: отказ развёртывания в основной сети, если администратор - не контракт.
const assert = require("node:assert/strict");
const { ethers } = require("hardhat");
const { assertAdminIsContractOnMainnet } = require("../scripts/lib/guards");

describe("deploy guard: admin must be a contract on mainnet (Д9)", function () {
  const SAFE_LIKE = "0x590782bA3CC906DE0547aa55fF47E8ac62953CdF";
  const HOT_WALLET = "0xeEa37FbFA83ac937AA29C65A02b96711a747117e";
  const fakeProvider = (codeByAddress) => ({ getCode: async (a) => codeByAddress[a] ?? "0x" });

  it("refuses on polygon when getCode is 0x (hot wallet as admin)", async () => {
    let err = null;
    try {
      await assertAdminIsContractOnMainnet(fakeProvider({}), HOT_WALLET, "polygon");
    } catch (e) { err = e; }
    assert.notEqual(err, null, "должно бросить");
    assert.match(err.message, /не контракт/);
    assert.ok(err.message.includes(HOT_WALLET));
  });

  it("passes on polygon when the admin has code (Safe)", async () => {
    const r = await assertAdminIsContractOnMainnet(fakeProvider({ [SAFE_LIKE]: "0x6080604052" }), SAFE_LIKE, "polygon");
    assert.deepEqual(r, { checked: true, isContract: true });
  });

  it("does not check on amoy or hardhat (test admin is a plain wallet there)", async () => {
    for (const net of ["amoy", "hardhat", "localhost"]) {
      const r = await assertAdminIsContractOnMainnet(fakeProvider({}), HOT_WALLET, net);
      assert.equal(r.checked, false, net);
    }
  });

  it("treats the mainnet alias the same way", async () => {
    let err = null;
    try { await assertAdminIsContractOnMainnet(fakeProvider({}), HOT_WALLET, "mainnet"); } catch (e) { err = e; }
    assert.notEqual(err, null);
  });

  it("works against a real provider: deployed contract passes, fresh wallet fails", async () => {
    const [deployer] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("EarthlingPassportV3");
    const c = await Factory.deploy(deployer.address, ethers.Wallet.createRandom().address, 100);
    await c.waitForDeployment();
    const deployed = await c.getAddress();
    const ok = await assertAdminIsContractOnMainnet(ethers.provider, deployed, "polygon");
    assert.equal(ok.isContract, true);
    let err = null;
    try { await assertAdminIsContractOnMainnet(ethers.provider, ethers.Wallet.createRandom().address, "polygon"); } catch (e) { err = e; }
    assert.notEqual(err, null);
  });
});
