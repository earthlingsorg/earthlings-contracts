// Tests for EarthlingPassportV3.
// Plain node:assert and mocha, so nothing extra has to be installed.
//
// The suite is organised around the promises the corpus makes about the
// passport, so a failure here means a document became untrue.

const assert = require("node:assert/strict");
const { ethers, network } = require("hardhat");

const DAY = 24 * 60 * 60;
const TWENTY_ONE_DAYS = 21 * DAY;

async function expectRevert(promise, expectedFragment) {
  try {
    await promise;
  } catch (e) {
    const text = `${e.shortMessage || ""} ${e.message || ""}`;
    assert.ok(
      text.includes(expectedFragment),
      `expected revert containing "${expectedFragment}", got: ${text.slice(0, 300)}`
    );
    return;
  }
  assert.fail(`expected revert containing "${expectedFragment}", but the call succeeded`);
}

async function advance(seconds) {
  await network.provider.send("evm_increaseTime", [seconds]);
  await network.provider.send("evm_mine");
}

describe("EarthlingPassportV3", function () {
  let contract, admin, minter, annuller, canceller, pauser, alice, bob, carol;

  const LIMIT = 5;

  beforeEach(async function () {
    [admin, minter, annuller, canceller, pauser, alice, bob, carol] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("EarthlingPassportV3");
    contract = await Factory.deploy(admin.address, minter.address, LIMIT);
    await contract.waitForDeployment();
  });

  async function grantOperationalRoles() {
    await contract.connect(admin).grantRole(await contract.ANNULMENT_ROLE(), annuller.address);
    await contract.connect(admin).grantRole(await contract.CANCEL_ROLE(), canceller.address);
    await contract.connect(admin).grantRole(await contract.PAUSER_ROLE(), pauser.address);
  }

  function mint(to, id) {
    return contract.connect(minter).mintPassport(to.address, id, `pseudo-${id}`, `hash-${id}`);
  }

  describe("deployment", function () {
    it("assigns only administration and issuance, nothing else", async function () {
      assert.ok(await contract.hasRole(await contract.DEFAULT_ADMIN_ROLE(), admin.address));
      assert.ok(await contract.hasRole(await contract.MINTER_ROLE(), minter.address));

      // Nobody can annul or pause until elected bodies exist.
      for (const role of ["ANNULMENT_ROLE", "CANCEL_ROLE", "PAUSER_ROLE"]) {
        const id = await contract[role]();
        for (const who of [admin, minter, alice]) {
          assert.equal(await contract.hasRole(id, who.address), false, `${role} must start unassigned`);
        }
      }
      assert.equal(await contract.adminCount(), 1n);
    });

    it("starts with the Charter period as the annulment delay", async function () {
      assert.equal(await contract.MIN_ANNULMENT_DELAY(), BigInt(TWENTY_ONE_DAYS));
      assert.equal(await contract.annulmentDelay(), BigInt(TWENTY_ONE_DAYS));
    });

    it("refuses a zero address or a zero mint limit", async function () {
      const Factory = await ethers.getContractFactory("EarthlingPassportV3");
      await expectRevert(Factory.deploy(ethers.ZeroAddress, minter.address, 1), "ZeroAddress");
      await expectRevert(Factory.deploy(admin.address, ethers.ZeroAddress, 1), "ZeroAddress");
      await expectRevert(Factory.deploy(admin.address, minter.address, 0), "LimitMustBePositive");
    });
  });

  describe("no unilateral destruction", function () {
    it("has no owner burn in the ABI at all", function () {
      const names = contract.interface.fragments
        .filter((f) => f.type === "function")
        .map((f) => f.name);
      assert.ok(!names.includes("burn"), "burn(uint256) must not exist in V3");
      assert.ok(names.includes("burnByHolder"), "burnByHolder must exist");
      assert.ok(!names.includes("owner"), "there must be no single owner");
      assert.ok(!names.includes("renounceOwnership"), "renounceOwnership must not exist");
    });

    it("gives no role a way to destroy a passport immediately", async function () {
      await grantOperationalRoles();
      await mint(alice, "e-1");

      // The only immediate paths are the holder's own, and annulment needs time.
      await contract.connect(annuller).proposeAnnulment(1, "duplicate issuance");
      await expectRevert(contract.connect(annuller).executeAnnulment(1), "AnnulmentNotYetExecutable");
      assert.equal(await contract.hasPassport(alice.address), true);
    });
  });

  describe("issuance", function () {
    it("keeps the V2 signature and fills the passport", async function () {
      await mint(alice, "e-1");
      assert.equal(await contract.hasPassport(alice.address), true);
      assert.equal(await contract.totalSupply(), 1n);
      assert.equal(await contract.totalMinted(), 1n);
      assert.equal(await contract.tokenOfOwner(alice.address), 1n);
      assert.equal(await contract.getTokenByEarthlingId("e-1"), 1n);

      const p = await contract.getPassport(1);
      assert.equal(p[0], "e-1");
      assert.equal(p[1], "pseudo-e-1");
      assert.equal(p[2], "hash-e-1");
      assert.ok(p[3] > 0n);
      assert.equal(p[4], alice.address);
    });

    it("is refused to everyone without the minter role", async function () {
      await expectRevert(
        contract.connect(admin).mintPassport(alice.address, "e-1", "p", "h"),
        "AccessControlUnauthorizedAccount"
      );
      await expectRevert(
        contract.connect(alice).mintPassport(alice.address, "e-1", "p", "h"),
        "AccessControlUnauthorizedAccount"
      );
    });

    it("refuses a second passport for one wallet and a reused earthlingId", async function () {
      await mint(alice, "e-1");
      await expectRevert(mint(alice, "e-2"), "AddressAlreadyHasPassport");
      await expectRevert(mint(bob, "e-1"), "EarthlingIdAlreadyUsed");
    });

    it("refuses an empty earthlingId and the zero address", async function () {
      await expectRevert(
        contract.connect(minter).mintPassport(alice.address, "", "p", "h"),
        "EarthlingIdRequired"
      );
      await expectRevert(
        contract.connect(minter).mintPassport(ethers.ZeroAddress, "e-1", "p", "h"),
        "ZeroAddress"
      );
    });
  });

  describe("daily mint cap", function () {
    // Signers 0..7 are taken by the named roles above, so 8 onwards are free.
    async function fillTheDay() {
      const spare = (await ethers.getSigners()).slice(8, 8 + LIMIT);
      assert.equal(spare.length, LIMIT, "not enough spare signers for this test");
      for (let i = 0; i < spare.length; i++) {
        await mint(spare[i], `cap-${i}`);
      }
    }

    it("bounds how many passports one key can create in a day", async function () {
      await fillTheDay();
      assert.equal(await contract.remainingMintsToday(), 0n);
      await expectRevert(mint(carol, "cap-over"), "DailyMintLimitReached");
    });

    it("resets on the next day", async function () {
      await fillTheDay();
      await advance(DAY);
      assert.equal(await contract.remainingMintsToday(), BigInt(LIMIT));
      await mint(carol, "next-day");
      assert.equal(await contract.hasPassport(carol.address), true);
    });

    it("can be raised only by administration", async function () {
      await expectRevert(contract.connect(minter).setDailyMintLimit(100), "AccessControlUnauthorizedAccount");
      await contract.connect(admin).setDailyMintLimit(100);
      assert.equal(await contract.dailyMintLimit(), 100n);
      await expectRevert(contract.connect(admin).setDailyMintLimit(0), "LimitMustBePositive");
    });
  });

  describe("the holder's own exit", function () {
    it("always works and cannot be performed by anyone else", async function () {
      await mint(alice, "e-1");
      await expectRevert(contract.connect(bob).burnByHolder(1), "NotTheHolder");
      await contract.connect(alice).burnByHolder(1);

      assert.equal(await contract.hasPassport(alice.address), false);
      assert.equal(await contract.totalSupply(), 0n);
      assert.equal(await contract.tokenOfOwner(alice.address), 0n);
      // totalMinted counts history and does not go down.
      assert.equal(await contract.totalMinted(), 1n);
    });

    it("is not blocked while issuance is paused", async function () {
      await grantOperationalRoles();
      await mint(alice, "e-1");
      await contract.connect(pauser).pause();

      await expectRevert(mint(bob, "e-2"), "EnforcedPause");
      await contract.connect(alice).burnByHolder(1); // must still go through
      assert.equal(await contract.hasPassport(alice.address), false);
    });

    it("cancels a pending annulment, because the token is gone", async function () {
      await grantOperationalRoles();
      await mint(alice, "e-1");
      await contract.connect(annuller).proposeAnnulment(1, "reason");
      await contract.connect(alice).burnByHolder(1);
      assert.equal(await contract.annulmentExecutableAt(1), 0n);
    });

    it("frees the earthlingId and lets the person verify again", async function () {
      await mint(alice, "e-1");
      await contract.connect(alice).burnByHolder(1);
      await mint(alice, "e-1"); // same person, same id, new token
      assert.equal(await contract.getTokenByEarthlingId("e-1"), 2n);
    });
  });

  describe("annulment of an invalid issuance", function () {
    beforeEach(async function () {
      await grantOperationalRoles();
      await mint(alice, "e-1");
    });

    it("is refused to everyone without the role, administration included", async function () {
      await expectRevert(contract.connect(admin).proposeAnnulment(1, "r"), "AccessControlUnauthorizedAccount");
      await expectRevert(contract.connect(minter).proposeAnnulment(1, "r"), "AccessControlUnauthorizedAccount");
      await expectRevert(contract.connect(alice).proposeAnnulment(1, "r"), "AccessControlUnauthorizedAccount");
    });

    it("publishes the ground and the date it becomes executable", async function () {
      const tx = await contract.connect(annuller).proposeAnnulment(1, "two passports for one person");
      const receipt = await tx.wait();
      const parsed = receipt.logs
        .map((l) => { try { return contract.interface.parseLog(l); } catch { return null; } })
        .filter(Boolean)
        .find((l) => l.name === "AnnulmentProposed");

      assert.ok(parsed, "AnnulmentProposed must be emitted");
      assert.equal(parsed.args[2], "two passports for one person");

      const executableAt = await contract.annulmentExecutableAt(1);
      const now = BigInt((await ethers.provider.getBlock("latest")).timestamp);
      assert.ok(executableAt - now >= BigInt(TWENTY_ONE_DAYS) - 5n);
    });

    it("cannot run before the objection period is over", async function () {
      await contract.connect(annuller).proposeAnnulment(1, "r");
      await advance(TWENTY_ONE_DAYS - 60);
      await expectRevert(contract.connect(annuller).executeAnnulment(1), "AnnulmentNotYetExecutable");
      assert.equal(await contract.hasPassport(alice.address), true);
    });

    it("runs once the period has passed", async function () {
      await contract.connect(annuller).proposeAnnulment(1, "r");
      await advance(TWENTY_ONE_DAYS + 1);
      await contract.connect(annuller).executeAnnulment(1);

      assert.equal(await contract.hasPassport(alice.address), false);
      assert.equal(await contract.totalSupply(), 0n);
      // The ground stays in the log; the record itself is cleared.
      assert.equal(await contract.annulmentExecutableAt(1), 0n);
    });

    it("refuses execution with nothing proposed and a second proposal", async function () {
      await expectRevert(contract.connect(annuller).executeAnnulment(1), "NoAnnulmentProposed");
      await contract.connect(annuller).proposeAnnulment(1, "r");
      await expectRevert(contract.connect(annuller).proposeAnnulment(1, "again"), "AnnulmentAlreadyProposed");
    });

    it("can be cancelled by a role that cannot annul, which is the point", async function () {
      await contract.connect(annuller).proposeAnnulment(1, "r");

      // canceller holds CANCEL_ROLE only
      assert.equal(await contract.hasRole(await contract.ANNULMENT_ROLE(), canceller.address), false);
      await contract.connect(canceller).cancelAnnulment(1);

      assert.equal(await contract.annulmentExecutableAt(1), 0n);
      await advance(TWENTY_ONE_DAYS + 1);
      await expectRevert(contract.connect(annuller).executeAnnulment(1), "NoAnnulmentProposed");
      assert.equal(await contract.hasPassport(alice.address), true);
    });

    it("is refused to an outsider trying to cancel", async function () {
      await contract.connect(annuller).proposeAnnulment(1, "r");
      await expectRevert(contract.connect(bob).cancelAnnulment(1), "AccessControlUnauthorizedAccount");
    });
  });

  describe("annulment delay", function () {
    it("can be raised and never lowered below the Charter period", async function () {
      await expectRevert(contract.connect(admin).setAnnulmentDelay(TWENTY_ONE_DAYS - 1), "DelayBelowMinimum");
      await contract.connect(admin).setAnnulmentDelay(30 * DAY);
      assert.equal(await contract.annulmentDelay(), BigInt(30 * DAY));
      await expectRevert(contract.connect(minter).setAnnulmentDelay(60 * DAY), "AccessControlUnauthorizedAccount");
    });
  });

  describe("technical reissue", function () {
    beforeEach(async function () {
      await mint(alice, "e-1");
    });

    it("carries the earthlingId, the hash and the original date to the new token", async function () {
      const before = await contract.getPassport(1);
      await advance(10 * DAY);

      await contract.connect(minter).reissue(1, bob.address);

      const after = await contract.getPassport(2);
      assert.equal(after[0], before[0], "earthlingId must carry over");
      assert.equal(after[2], before[2], "verificationHash must carry over");
      assert.equal(after[3], before[3], "membership is not interrupted, so the date must not reset");
      assert.equal(after[4], bob.address);

      assert.equal(await contract.hasPassport(alice.address), false);
      assert.equal(await contract.hasPassport(bob.address), true);
      assert.equal(await contract.totalSupply(), 1n);
      assert.equal(await contract.getTokenByEarthlingId("e-1"), 2n);
    });

    it("is refused to everyone without the minter role", async function () {
      await expectRevert(contract.connect(admin).reissue(1, bob.address), "AccessControlUnauthorizedAccount");
      await expectRevert(contract.connect(alice).reissue(1, bob.address), "AccessControlUnauthorizedAccount");
    });

    // The Charter names two grounds: loss of wallet access, which moves the
    // passport, and contract migration, which does not.
    it("works to the same address, for the migration case", async function () {
      const before = await contract.getPassport(1);
      await contract.connect(minter).reissue(1, alice.address);

      const after = await contract.getPassport(2);
      assert.equal(after[4], alice.address);
      assert.equal(after[0], before[0]);
      assert.equal(after[3], before[3], "the date must survive a migration too");
      assert.equal(await contract.hasPassport(alice.address), true);
      assert.equal(await contract.tokenOfOwner(alice.address), 2n);
      assert.equal(await contract.totalSupply(), 1n);
    });

    it("refuses a target that already holds a passport", async function () {
      await mint(bob, "e-2");
      await expectRevert(contract.connect(minter).reissue(1, bob.address), "AddressAlreadyHasPassport");
    });

    it("drops a pending annulment together with the old token", async function () {
      await grantOperationalRoles();
      await contract.connect(annuller).proposeAnnulment(1, "r");
      await contract.connect(minter).reissue(1, bob.address);
      assert.equal(await contract.annulmentExecutableAt(1), 0n);
      assert.equal(await contract.annulmentExecutableAt(2), 0n);
    });

    it("counts against the daily cap, like any creation of a passport", async function () {
      await contract.connect(admin).setDailyMintLimit(2);
      await advance(DAY);
      await mint(bob, "e-2");            // 1 of 2
      await contract.connect(minter).reissue(1, carol.address); // 2 of 2
      assert.equal(await contract.remainingMintsToday(), 0n);
      await expectRevert(mint(annuller, "e-3"), "DailyMintLimitReached");
    });
  });

  describe("adoption of the text", function () {
    const HASH = "0x" + "ab".repeat(32);
    const OTHER = "0x" + "cd".repeat(32);

    it("is not recorded at deployment, so nobody can sign yet", async function () {
      assert.equal(await contract.declarationHash(), "0x" + "00".repeat(32));
      assert.equal(await contract.isDeclarationAdopted(), false);
      await mint(alice, "e-1");
      await expectRevert(contract.connect(alice).signDeclaration(HASH), "DeclarationNotAdopted");
    });

    it("is recorded by administration and only once, ever", async function () {
      await expectRevert(contract.connect(minter).setAdoptedDeclaration(HASH), "AccessControlUnauthorizedAccount");
      await expectRevert(contract.connect(admin).setAdoptedDeclaration("0x" + "00".repeat(32)), "EmptyDeclarationHash");

      await contract.connect(admin).setAdoptedDeclaration(HASH);
      assert.equal(await contract.declarationHash(), HASH);
      assert.ok((await contract.adoptedAt()) > 0n);
      assert.equal(await contract.isDeclarationAdopted(), true);

      // Подменить принятый текст нельзя никому и никогда: иначе все собранные
      // подписи стали бы подписями неизвестно чего.
      await expectRevert(contract.connect(admin).setAdoptedDeclaration(OTHER), "DeclarationAlreadyAdopted");
      await expectRevert(contract.connect(admin).setAdoptedDeclaration(HASH), "DeclarationAlreadyAdopted");
    });
  });

  describe("signing the Declaration", function () {
    const HASH = "0x" + "ab".repeat(32);
    const OTHER = "0x" + "cd".repeat(32);

    beforeEach(async function () {
      await mint(alice, "e-1");
      await contract.connect(admin).setAdoptedDeclaration(HASH);
    });

    it("is the holder's own act and nobody else's", async function () {
      // ни администратор, ни служба выпуска не могут подписать за человека
      await expectRevert(contract.connect(admin).signDeclaration(HASH), "NoPassport");
      await expectRevert(contract.connect(minter).signDeclaration(HASH), "NoPassport");
      await expectRevert(contract.connect(bob).signDeclaration(HASH), "NoPassport");

      const names = contract.interface.fragments.filter((f) => f.type === "function").map((f) => f.name);
      assert.ok(!names.some((n) => /signFor|signOnBehalf|adminSign/i.test(n)),
        "не должно быть никакой функции подписания за другого");
    });

    it("turns a passport holder into an earthling", async function () {
      assert.equal(await contract.isEarthling(alice.address), false, "до подписания не earthling");
      assert.equal(await contract.earthlingCount(), 0n);

      await contract.connect(alice).signDeclaration(HASH);

      assert.equal(await contract.isEarthling(alice.address), true);
      assert.equal(await contract.earthlingCount(), 1n);
      assert.ok((await contract.signedAt(1)) > 0n);
      // паспорт есть у всех подтверждённых, earthling - только подписавший
      assert.equal(await contract.totalSupply(), 1n);
    });

    it("refuses a signature given for a different text", async function () {
      await expectRevert(contract.connect(alice).signDeclaration(OTHER), "DeclarationHashMismatch");
      assert.equal(await contract.isEarthling(alice.address), false);
    });

    it("cannot be given twice", async function () {
      await contract.connect(alice).signDeclaration(HASH);
      await expectRevert(contract.connect(alice).signDeclaration(HASH), "AlreadySigned");
      assert.equal(await contract.earthlingCount(), 1n);
    });

    it("names the text in the event, not just the fact of signing", async function () {
      const tx = await contract.connect(alice).signDeclaration(HASH);
      const receipt = await tx.wait();
      const ev = receipt.logs
        .map((l) => { try { return contract.interface.parseLog(l); } catch { return null; } })
        .filter(Boolean).find((l) => l.name === "DeclarationSigned");
      assert.ok(ev, "DeclarationSigned должно быть");
      assert.equal(ev.args[1], alice.address);
      assert.equal(ev.args[2], HASH, "в подписи должен стоять хеш подписанного текста");
    });

    it("is lost when the person leaves", async function () {
      await contract.connect(alice).signDeclaration(HASH);
      await contract.connect(alice).burnByHolder(1);
      assert.equal(await contract.isEarthling(alice.address), false);
      assert.equal(await contract.earthlingCount(), 0n);
    });

    it("is lost when the issuance is annulled", async function () {
      await grantOperationalRoles();
      await contract.connect(alice).signDeclaration(HASH);
      await contract.connect(annuller).proposeAnnulment(1, "две выдачи на одного человека");
      await advance(TWENTY_ONE_DAYS + 1);
      await contract.connect(annuller).executeAnnulment(1);
      assert.equal(await contract.isEarthling(alice.address), false);
      assert.equal(await contract.earthlingCount(), 0n);
    });

    it("survives a technical reissue, because a lost wallet is not a change of mind", async function () {
      await contract.connect(alice).signDeclaration(HASH);
      const signedBefore = await contract.signedAt(1);

      await advance(30 * DAY);
      await contract.connect(minter).reissue(1, bob.address);

      const newToken = await contract.tokenOfOwner(bob.address);
      assert.equal(await contract.isEarthling(bob.address), true, "остаётся earthling после перевыпуска");
      assert.equal(await contract.signedAt(newToken), signedBefore, "дата подписания не сбрасывается");
      assert.equal(await contract.earthlingCount(), 1n, "счёт не удваивается и не теряется");
      assert.equal(await contract.isEarthling(alice.address), false);
    });

    it("does not double the count when an unsigned passport is reissued", async function () {
      await advance(DAY);
      await contract.connect(minter).reissue(1, bob.address);
      assert.equal(await contract.earthlingCount(), 0n);
      assert.equal(await contract.isEarthling(bob.address), false);
    });
  });

  describe("soulbound", function () {
    it("blocks every transfer", async function () {
      await mint(alice, "e-1");
      await expectRevert(
        contract.connect(alice).transferFrom(alice.address, bob.address, 1),
        "SoulboundTransfersDisabled"
      );
      await expectRevert(
        contract.connect(alice)["safeTransferFrom(address,address,uint256)"](alice.address, bob.address, 1),
        "SoulboundTransfersDisabled"
      );
    });
  });

  describe("pausing", function () {
    it("is available only to the pauser role", async function () {
      await grantOperationalRoles();
      await expectRevert(contract.connect(admin).pause(), "AccessControlUnauthorizedAccount");
      await contract.connect(pauser).pause();
      await contract.connect(pauser).unpause();
      await mint(alice, "e-1");
      assert.equal(await contract.hasPassport(alice.address), true);
    });

    it("stops reissue as well as issuance", async function () {
      await grantOperationalRoles();
      await mint(alice, "e-1");
      await contract.connect(pauser).pause();
      await expectRevert(contract.connect(minter).reissue(1, bob.address), "EnforcedPause");
    });
  });

  describe("administration cannot be lost", function () {
    it("refuses to remove the last administrator", async function () {
      const role = await contract.DEFAULT_ADMIN_ROLE();
      await expectRevert(contract.connect(admin).revokeRole(role, admin.address), "CannotRemoveLastAdmin");
      await expectRevert(contract.connect(admin).renounceRole(role, admin.address), "CannotRemoveLastAdmin");
    });

    it("allows handover once a second administrator exists", async function () {
      const role = await contract.DEFAULT_ADMIN_ROLE();
      await contract.connect(admin).grantRole(role, bob.address);
      assert.equal(await contract.adminCount(), 2n);

      await contract.connect(bob).revokeRole(role, admin.address);
      assert.equal(await contract.adminCount(), 1n);
      assert.equal(await contract.hasRole(role, admin.address), false);
      assert.equal(await contract.hasRole(role, bob.address), true);
    });

    it("can revoke the minter key instantly", async function () {
      const role = await contract.MINTER_ROLE();
      await contract.connect(admin).revokeRole(role, minter.address);
      await expectRevert(mint(alice, "e-1"), "AccessControlUnauthorizedAccount");
    });
  });

  describe("metadata and interfaces", function () {
    it("serves on-chain json until a base uri is set", async function () {
      await mint(alice, "e-1");
      const uri = await contract.tokenURI(1);
      assert.ok(uri.startsWith("data:application/json;utf8,"));
      assert.ok(uri.includes("e-1"));

      await contract.connect(admin).setBaseURI("https://earth-lings.org/p/");
      assert.equal(await contract.tokenURI(1), "https://earth-lings.org/p/1");
    });

    it("reverts on a token that does not exist", async function () {
      await expectRevert(contract.tokenURI(999), "TokenDoesNotExist");
      await expectRevert(contract.getPassport(999), "TokenDoesNotExist");
      await expectRevert(contract.getTokenByEarthlingId("nope"), "TokenDoesNotExist");
    });

    it("declares ERC-721 and AccessControl", async function () {
      assert.ok(await contract.supportsInterface("0x80ac58cd"), "ERC-721");
      assert.ok(await contract.supportsInterface("0x7965db0b"), "AccessControl");
      assert.ok(await contract.supportsInterface("0x01ffc9a7"), "ERC-165");
    });
  });
});
