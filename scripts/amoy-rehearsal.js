// Репетиция V3 на Amoy (фаза 2 и дополнения Д1, Д2 ТЗ от 2026-10-06).
//
//   npx hardhat run scripts/amoy-rehearsal.js --network amoy
//
// Читает из .env:
//   V3_AMOY_ADDRESS        - адрес V3 на Amoy (из вывода deploy-v3.js)
//   DEPLOYER_PRIVATE_KEY   - платит газ и раздаёт немного тестовых POL остальным кошелькам
//   AMOY_TEST_ADMIN_KEY    - тестовый администратор (DEFAULT_ADMIN_ROLE при развёртывании)
//   AMOY_TEST_MINTER_KEY   - тестовый ключ выпуска (MINTER_ROLE при развёртывании)
//   AMOY_TEST_MINTER2_KEY  - второй тестовый ключ: репетиция смены ключа выпуска (Д2)
//
// Что проходит, в порядке ТЗ: роли по Р3 администратору; выпуск; повторный выпуск на тот же
// адрес - отказ; burnByHolder; proposeAnnulment и cancelAnnulment; executeAnnulment раньше
// 21 дня - отказ; reissue с сохранением даты; суточный предел (setDailyMintLimit(2), отказ
// на limit+1, возврат к 100); pause - выпуск отклонён; смена ключа выпуска и обратно (Д2).
//
// Каждый шаг печатает «ожидалось / получено»; в конце - таблица и расход газа. Любое
// расхождение - ненулевой код выхода. Записи, созданные здесь, остаются в тестовой сети.

const { ethers, network } = require("hardhat");
require("dotenv").config();

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Не задано ${name} в .env`);
  return v;
}

const rows = [];
let gasSpent = 0n;

function record(step, expected, got, ok) {
  rows.push({ step, expected, got, ok });
  console.log(`${ok ? "ок  " : "СБОЙ"}  ${step}\n      ожидалось: ${expected}\n      получено:  ${got}`);
}

async function send(promise) {
  const tx = await promise;
  const r = await tx.wait();
  gasSpent += r.gasUsed * (r.gasPrice || 0n);
  return r;
}

// Имя пользовательской ошибки из ошибки ethers.
function revertName(e, iface) {
  if (e.revert && e.revert.name) return e.revert.name;
  for (const d of [e.data, e.info?.error?.data, e.error?.data]) {
    if (typeof d === "string" && d.startsWith("0x") && d.length >= 10) {
      try { const p = iface.parseError(d); if (p) return p.name; } catch (_) {}
    }
  }
  return (e.shortMessage || e.message || "").slice(0, 60);
}

async function expectRevert(step, promise, errorName, iface) {
  try {
    await send(promise);
    record(step, `отказ ${errorName}`, "прошло без отказа", false);
  } catch (e) {
    const name = revertName(e, iface);
    record(step, `отказ ${errorName}`, `отказ ${name}`, name === errorName);
  }
}

async function main() {
  const local = network.name === "hardhat" || network.name === "localhost";
  if (!local && network.name !== "amoy") throw new Error("Этот скрипт для --network amoy (или локальной сети для прогона самого скрипта)");
  // На Amoy узел советует 95 gwei при базовой комиссии ~0, а кран даёт 0,1 POL в сутки:
  // при заданном AMOY_GAS_PRICE_GWEI все тестовые кошельки платят ровно эту цену.
  let provider = ethers.provider;
  if (!local && process.env.AMOY_GAS_PRICE_GWEI) {
    const fixed = ethers.parseUnits(process.env.AMOY_GAS_PRICE_GWEI, "gwei");
    class FixedFeeProvider extends ethers.JsonRpcProvider {
      async getFeeData() { return new ethers.FeeData(fixed, null, null); }
    }
    provider = new FixedFeeProvider(process.env.AMOY_RPC_URL || "https://polygon-amoy-bor-rpc.publicnode.com", 80002, { staticNetwork: true });
    console.log("цена газа задана руками:", process.env.AMOY_GAS_PRICE_GWEI, "gwei");
  }
  const [deployer] = await ethers.getSigners();
  const admin = new ethers.Wallet(need("AMOY_TEST_ADMIN_KEY"), provider);
  const minter = new ethers.Wallet(need("AMOY_TEST_MINTER_KEY"), provider);
  const minter2 = new ethers.Wallet(need("AMOY_TEST_MINTER2_KEY"), provider);
  let address;
  if (local && !process.env.V3_LOCAL_ADDRESS) {
    // Локальный прогон самого скрипта: разворачиваем свежий V3 с теми же тестовыми ролями.
    const Factory = await ethers.getContractFactory("EarthlingPassportV3");
    const fresh = await Factory.deploy(admin.address, minter.address, 100);
    await fresh.waitForDeployment();
    address = await fresh.getAddress();
    console.log("локальная сеть: развёрнут свежий V3", address);
  } else {
    address = ethers.getAddress(local ? need("V3_LOCAL_ADDRESS") : need("V3_AMOY_ADDRESS"));
  }
  const holderA = ethers.Wallet.createRandom().connect(provider);
  const holderB = ethers.Wallet.createRandom().connect(provider);
  const holderC = ethers.Wallet.createRandom().connect(provider);

  const c = (await ethers.getContractAt("EarthlingPassportV3", address, deployer)).connect(provider);
  const iface = c.interface;
  const asAdmin = c.connect(admin);
  const asMinter = c.connect(minter);
  const asMinter2 = c.connect(minter2);

  console.log("сеть:            ", network.name);
  console.log("контракт V3:     ", address);
  console.log("deployer:        ", deployer.address, ethers.formatEther(await provider.getBalance(deployer.address)), "POL");
  console.log("тестовый админ:  ", admin.address);
  console.log("ключ выпуска:    ", minter.address);
  console.log("ключ выпуска #2: ", minter2.address);
  console.log("держатели A/B/C: ", holderA.address, holderB.address, holderC.address);

  const [ADMIN_ROLE, MINTER_ROLE, ANNULMENT_ROLE, CANCEL_ROLE, PAUSER_ROLE] = await Promise.all([
    c.DEFAULT_ADMIN_ROLE(), c.MINTER_ROLE(), c.ANNULMENT_ROLE(), c.CANCEL_ROLE(), c.PAUSER_ROLE(),
  ]);
  if (!(await c.hasRole(ADMIN_ROLE, admin.address))) throw new Error("AMOY_TEST_ADMIN_KEY не администратор этого контракта");
  if (!(await c.hasRole(MINTER_ROLE, minter.address))) throw new Error("AMOY_TEST_MINTER_KEY не ключ выпуска этого контракта");

  // --- газ остальным кошелькам (только тестовые POL)
  console.log("\n== газ тестовым кошелькам");
  const topUp = async (to, amount) => {
    if ((await provider.getBalance(to)) < ethers.parseEther(amount)) {
      await send(deployer.sendTransaction({ to, value: ethers.parseEther(amount) }));
    }
  };
  // Суммы под 25 gwei: администратору ~12 вызовов по 50-100k газа, ключу выпуска ~8
  // выпусков по ~200k, второму ключу один выпуск, держателю одно гашение.
  await topUp(admin.address, "0.025");
  await topUp(minter.address, "0.04");
  await topUp(minter2.address, "0.006");
  await topUp(holderA.address, "0.003");
  console.log("   готово");

  // --- Р3: роли администратору
  console.log("\n== роли по Р3 тестовому администратору");
  for (const [name, role] of [["ANNULMENT_ROLE", ANNULMENT_ROLE], ["CANCEL_ROLE", CANCEL_ROLE], ["PAUSER_ROLE", PAUSER_ROLE]]) {
    if (!(await c.hasRole(role, admin.address))) await send(asAdmin.grantRole(role, admin.address));
    record(`grantRole(${name}, admin)`, "hasRole = true", `hasRole = ${await c.hasRole(role, admin.address)}`, await c.hasRole(role, admin.address));
  }
  record("adminCount()", "1", String(await c.adminCount()), (await c.adminCount()) === 1n);

  // Предел на день может быть уже тронут прежними прогонами: убедимся, что хватит на 4 выпуска.
  if ((await c.remainingMintsToday()) < 5n) {
    await send(asAdmin.setDailyMintLimit(100));
  }

  // --- выпуск
  console.log("\n== выпуск и повтор");
  const vh = () => ethers.hexlify(ethers.randomBytes(32)).slice(2);
  const rA = await send(asMinter.mintPassport(holderA.address, "rehearsal-" + vh().slice(0, 16), "Earthling", vh()));
  const tokenA = iface.parseLog(rA.logs.find((l) => { try { return iface.parseLog(l)?.name === "PassportMinted"; } catch { return false; } })).args.tokenId;
  record("mintPassport(A)", "hasPassport(A) = true", `hasPassport(A) = ${await c.hasPassport(holderA.address)}, tokenId ${tokenA}`, await c.hasPassport(holderA.address));
  await expectRevert("mintPassport(A) второй раз", asMinter.mintPassport(holderA.address, "rehearsal-" + vh().slice(0, 16), "Earthling", vh()), "AddressAlreadyHasPassport", iface);

  // --- burnByHolder
  console.log("\n== гашение держателем");
  await send(c.connect(holderA).burnByHolder(tokenA));
  record("burnByHolder(A)", "hasPassport(A) = false", `hasPassport(A) = ${await c.hasPassport(holderA.address)}`, !(await c.hasPassport(holderA.address)));

  // --- аннулирование
  console.log("\n== аннулирование в два шага");
  const rB = await send(asMinter.mintPassport(holderB.address, "rehearsal-" + vh().slice(0, 16), "Earthling", vh()));
  const tokenB = iface.parseLog(rB.logs.find((l) => { try { return iface.parseLog(l)?.name === "PassportMinted"; } catch { return false; } })).args.tokenId;
  await send(asAdmin.proposeAnnulment(tokenB, "репетиция: основание статьи 8"));
  const execAt = await c.annulmentExecutableAt(tokenB);
  const delay = await c.annulmentDelay();
  record("proposeAnnulment(B)", "annulmentExecutableAt = now + 21 дней", `через ${(Number(execAt) - Math.floor(Date.now() / 1000)) / 86400 | 0} дн. (annulmentDelay ${Number(delay) / 86400} дн.)`, delay === 1814400n && execAt > 0n);
  await expectRevert("executeAnnulment(B) раньше срока", asAdmin.executeAnnulment(tokenB), "AnnulmentNotYetExecutable", iface);
  await send(asAdmin.cancelAnnulment(tokenB));
  record("cancelAnnulment(B)", "annulmentExecutableAt = 0, паспорт на месте", `${await c.annulmentExecutableAt(tokenB)}, hasPassport(B) = ${await c.hasPassport(holderB.address)}`, (await c.annulmentExecutableAt(tokenB)) === 0n && (await c.hasPassport(holderB.address)));

  // --- перевыпуск
  console.log("\n== перевыпуск с сохранением даты");
  const before = await c.getPassport(tokenB);
  const rR = await send(asMinter.reissue(tokenB, holderC.address));
  const newId = iface.parseLog(rR.logs.find((l) => { try { return iface.parseLog(l)?.name === "PassportReissued"; } catch { return false; } })).args.newTokenId;
  const after = await c.getPassport(newId);
  record("reissue(B -> C)", `mintedAt сохранён (${before.mintedAt}), B без паспорта, C с паспортом`,
    `mintedAt ${after.mintedAt}, hasPassport(B) = ${await c.hasPassport(holderB.address)}, hasPassport(C) = ${await c.hasPassport(holderC.address)}`,
    after.mintedAt === before.mintedAt && !(await c.hasPassport(holderB.address)) && (await c.hasPassport(holderC.address)));

  // --- суточный предел (Д1 на уровне цепи)
  console.log("\n== суточный предел");
  const usedToday = await c.mintedOnDay(BigInt(Math.floor(Date.now() / 1000 / 86400)));
  await send(asAdmin.setDailyMintLimit(2));
  record("setDailyMintLimit(2)", "dailyMintLimit = 2", `dailyMintLimit = ${await c.dailyMintLimit()}, сегодня уже выпущено ${usedToday}`, (await c.dailyMintLimit()) === 2n);
  await expectRevert("mintPassport при исчерпанном пределе", asMinter.mintPassport(ethers.Wallet.createRandom().address, "rehearsal-" + vh().slice(0, 16), "Earthling", vh()), "DailyMintLimitReached", iface);
  // Сухой прогон - то, что делает служба KYC перед отправкой: тот же отказ, без газа.
  try {
    await asMinter.mintPassport.staticCall(ethers.Wallet.createRandom().address, "rehearsal-dry", "Earthling", vh());
    record("staticCall при пределе (как в KYC)", "отказ DailyMintLimitReached без транзакции", "прошло", false);
  } catch (e) {
    const name = revertName(e, iface);
    record("staticCall при пределе (как в KYC)", "отказ DailyMintLimitReached без транзакции", `отказ ${name}`, name === "DailyMintLimitReached");
  }
  await send(asAdmin.setDailyMintLimit(100));
  record("setDailyMintLimit(100)", "dailyMintLimit = 100", `dailyMintLimit = ${await c.dailyMintLimit()}`, (await c.dailyMintLimit()) === 100n);

  // --- пауза
  console.log("\n== пауза");
  await send(asAdmin.pause());
  await expectRevert("mintPassport при паузе", asMinter.mintPassport(ethers.Wallet.createRandom().address, "rehearsal-" + vh().slice(0, 16), "Earthling", vh()), "EnforcedPause", iface);
  await send(asAdmin.unpause());
  record("unpause()", "paused = false", `paused = ${await c.paused()}`, !(await c.paused()));

  // --- Д2: смена ключа выпуска и обратно
  console.log("\n== смена ключа выпуска (Д2)");
  await send(asAdmin.grantRole(MINTER_ROLE, minter2.address));
  await send(asAdmin.revokeRole(MINTER_ROLE, minter.address));
  record("grantRole(MINTER, #2) + revokeRole(MINTER, #1)", "#1 false, #2 true",
    `#1 ${await c.hasRole(MINTER_ROLE, minter.address)}, #2 ${await c.hasRole(MINTER_ROLE, minter2.address)}`,
    !(await c.hasRole(MINTER_ROLE, minter.address)) && (await c.hasRole(MINTER_ROLE, minter2.address)));
  await expectRevert("mintPassport старым ключом", asMinter.mintPassport(ethers.Wallet.createRandom().address, "rehearsal-" + vh().slice(0, 16), "Earthling", vh()), "AccessControlUnauthorizedAccount", iface);
  const holderD = ethers.Wallet.createRandom().address;
  await send(asMinter2.mintPassport(holderD, "rehearsal-" + vh().slice(0, 16), "Earthling", vh()));
  record("mintPassport новым ключом", "hasPassport(D) = true", `hasPassport(D) = ${await c.hasPassport(holderD)}`, await c.hasPassport(holderD));
  // обратно, чтобы .env.local KYC с AMOY_TEST_MINTER_KEY оставался рабочим
  await send(asAdmin.grantRole(MINTER_ROLE, minter.address));
  await send(asAdmin.revokeRole(MINTER_ROLE, minter2.address));
  record("возврат ключа выпуска #1", "#1 true, #2 false",
    `#1 ${await c.hasRole(MINTER_ROLE, minter.address)}, #2 ${await c.hasRole(MINTER_ROLE, minter2.address)}`,
    (await c.hasRole(MINTER_ROLE, minter.address)) && !(await c.hasRole(MINTER_ROLE, minter2.address)));

  // --- итог
  console.log("\n" + "=".repeat(78) + "\nИТОГ\n" + "=".repeat(78));
  console.log("| шаг | ожидалось | получено | итог |\n|---|---|---|---|");
  for (const r of rows) console.log(`| ${r.step} | ${r.expected} | ${r.got} | ${r.ok ? "ок" : "СБОЙ"} |`);
  console.log(`\nвсего выдано за историю: ${await c.totalMinted()}, действующих: ${await c.totalSupply()}`);
  console.log(`газ репетиции: ${ethers.formatEther(gasSpent)} POL (Amoy, тестовые)`);
  const failed = rows.filter((r) => !r.ok);
  if (failed.length) throw new Error(`${failed.length} шаг(ов) не сошлись`);
  console.log("\nРепетиция завершена без единого отклонения от ожидаемого.");
}

main().then(() => process.exit(0)).catch((e) => { console.error("\n" + (e.message || e)); process.exit(1); });
