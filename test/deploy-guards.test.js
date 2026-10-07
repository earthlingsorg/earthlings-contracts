// Д9: отказ развёртывания в основной сети, если администратор - не контракт.
const assert = require("node:assert/strict");
const { ethers } = require("hardhat");
const { assertAdminIsContractOnMainnet } = require("../scripts/lib/guards");

describe("deploy guard: admin must be a contract outside test chains (Д9, Д11)", function () {
  const SAFE_LIKE = "0x590782bA3CC906DE0547aa55fF47E8ac62953CdF";
  const HOT_WALLET = "0xeEa37FbFA83ac937AA29C65A02b96711a747117e";
  const fake = (chainId, codeByAddress = {}) => ({
    getNetwork: async () => ({ chainId: BigInt(chainId) }),
    getCode: async (a) => codeByAddress[a] ?? "0x",
  });
  const refuses = async (p, admin, label) => {
    try { await assertAdminIsContractOnMainnet(p, admin, label); } catch (e) { return e; }
    return null;
  };

  it("refuses on chainId 137 when getCode is 0x (hot wallet as admin)", async () => {
    const err = await refuses(fake(137), HOT_WALLET, "polygon");
    assert.notEqual(err, null, "должно бросить");
    assert.match(err.message, /не контракт/);
    assert.ok(err.message.includes(HOT_WALLET));
    assert.ok(err.message.includes("chainId=137"));
  });

  it("Д11: a network NAMED amoy but served by chainId 137 is refused", async () => {
    const err = await refuses(fake(137), HOT_WALLET, "amoy");
    assert.notEqual(err, null, "имя сети не должно открывать защиту");
    assert.ok(err.message.includes("amoy"));
  });

  it("Д11: unknown chains are protected by default", async () => {
    for (const id of [1, 56, 8453, 424242]) {
      assert.notEqual(await refuses(fake(id), HOT_WALLET, "misconfigured"), null, "chainId " + id);
    }
  });

  it("passes on chainId 137 when the admin has code (Safe)", async () => {
    const r = await assertAdminIsContractOnMainnet(fake(137, { [SAFE_LIKE]: "0x6080604052" }), SAFE_LIKE, "polygon");
    assert.deepEqual(r, { chainId: 137n, checked: true, isContract: true });
  });

  it("skips only the known test chains: 31337, 1337, 80002", async () => {
    for (const id of [31337, 1337, 80002]) {
      const r = await assertAdminIsContractOnMainnet(fake(id), HOT_WALLET, "test");
      assert.equal(r.checked, false, "chainId " + id);
    }
  });

  it("works against a real provider: hardhat chain is skipped, and the code check itself works", async () => {
    const [deployer] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("EarthlingPassportV3");
    const c = await Factory.deploy(deployer.address, ethers.Wallet.createRandom().address, 100);
    await c.waitForDeployment();
    const deployed = await c.getAddress();
    // настоящий провайдер hardhat (31337) - тестовая цепь, пропуск
    const skipped = await assertAdminIsContractOnMainnet(ethers.provider, deployed, "hardhat");
    assert.equal(skipped.checked, false);
    assert.equal(skipped.chainId, 31337n);
    // тот же getCode, но цепь выдаём за основную: контракт проходит, кошелёк - нет
    const asMainnet = { getNetwork: async () => ({ chainId: 137n }), getCode: (a) => ethers.provider.getCode(a) };
    const ok = await assertAdminIsContractOnMainnet(asMainnet, deployed, "polygon");
    assert.equal(ok.isContract, true);
    assert.notEqual(await refuses(asMainnet, ethers.Wallet.createRandom().address, "polygon"), null);
  });
});
