// Приёмка развёрнутого EarthlingPassportV3 - только чтение, ничего не меняет.
//
//   V3_ADDRESS=0x... npx hardhat run scripts/check-v3.js --network polygon
//   V3_ADDRESS=0x... npx hardhat run scripts/check-v3.js --network amoy
//
// Читает из .env (или окружения): V3_ADDRESS (или V3_AMOY_ADDRESS для amoy), V3_ADMIN_ADDRESS,
// V3_MINTER_ADDRESS, по желанию DEPLOYER_ADDRESS и V3_EXPECTED_LIMIT (по умолчанию 100).
//
// Печатает матрицу ролей из раздела «Приёмка» ТЗ, adminCount, annulmentDelay, dailyMintLimit,
// totalSupply, totalMinted, paused и, если администратор - контракт Safe, его порог и
// подписантов (getThreshold, getOwners). Любое расхождение с ожидаемым - ненулевой код.

const { ethers, network } = require("hardhat");
require("dotenv").config();

const SAFE_ABI = [
  "function getThreshold() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function VERSION() view returns (string)",
];

async function main() {
  const address = ethers.getAddress(process.env.V3_ADDRESS || (network.name === "amoy" ? process.env.V3_AMOY_ADDRESS : "") || "");
  const admin = ethers.getAddress(process.env.V3_ADMIN_ADDRESS);
  const minter = ethers.getAddress(process.env.V3_MINTER_ADDRESS);
  const deployer = process.env.DEPLOYER_ADDRESS ? ethers.getAddress(process.env.DEPLOYER_ADDRESS) : null;
  const expectedLimit = BigInt(process.env.V3_EXPECTED_LIMIT || "100");

  const c = await ethers.getContractAt("EarthlingPassportV3", address);
  const roles = {
    DEFAULT_ADMIN_ROLE: await c.DEFAULT_ADMIN_ROLE(),
    MINTER_ROLE: await c.MINTER_ROLE(),
    ANNULMENT_ROLE: await c.ANNULMENT_ROLE(),
    CANCEL_ROLE: await c.CANCEL_ROLE(),
    PAUSER_ROLE: await c.PAUSER_ROLE(),
  };

  console.log("сеть:      ", network.name);
  console.log("контракт:  ", address);
  console.log("имя/символ:", await c.name(), "/", await c.symbol());
  console.log("");

  const who = [["Safe (admin)", admin], ["ключ выпуска", minter]];
  if (deployer) who.push(["ключ развёртывания", deployer]);
  const expected = {
    "Safe (admin)": { DEFAULT_ADMIN_ROLE: true, MINTER_ROLE: false, ANNULMENT_ROLE: true, CANCEL_ROLE: true, PAUSER_ROLE: true },
    "ключ выпуска": { DEFAULT_ADMIN_ROLE: false, MINTER_ROLE: true, ANNULMENT_ROLE: false, CANCEL_ROLE: false, PAUSER_ROLE: false },
    "ключ развёртывания": { DEFAULT_ADMIN_ROLE: false, MINTER_ROLE: false, ANNULMENT_ROLE: false, CANCEL_ROLE: false, PAUSER_ROLE: false },
  };
  let bad = 0;
  console.log("| кто | роль | ожидалось | в цепи | итог |\n|---|---|---|---|---|");
  for (const [label, addr] of who) {
    for (const [name, id] of Object.entries(roles)) {
      const has = await c.hasRole(id, addr);
      const exp = expected[label][name];
      const ok = has === exp;
      if (!ok) bad++;
      console.log(`| ${label} ${addr} | ${name} | ${exp} | ${has} | ${ok ? "ок" : "СБОЙ"} |`);
    }
  }

  const checks = [
    ["adminCount()", await c.adminCount(), 1n],
    ["annulmentDelay()", await c.annulmentDelay(), 1814400n],
    ["dailyMintLimit()", await c.dailyMintLimit(), expectedLimit],
    ["totalSupply()", await c.totalSupply(), network.name === "polygon" ? 0n : null],
    ["totalMinted()", await c.totalMinted(), network.name === "polygon" ? 0n : null],
    ["paused()", await c.paused(), false],
    ["isDeclarationAdopted()", await c.isDeclarationAdopted(), false],
  ];
  console.log("\n| показатель | ожидалось | в цепи | итог |\n|---|---|---|---|");
  for (const [name, got, exp] of checks) {
    const ok = exp === null ? true : got === exp;
    if (!ok) bad++;
    console.log(`| ${name} | ${exp === null ? "(любое)" : exp} | ${got} | ${ok ? "ок" : "СБОЙ"} |`);
  }

  // Администратор - контракт? Тогда это Safe: порог и подписанты.
  const code = await ethers.provider.getCode(admin);
  if (code && code !== "0x") {
    try {
      const safe = new ethers.Contract(admin, SAFE_ABI, ethers.provider);
      const [threshold, owners] = await Promise.all([safe.getThreshold(), safe.getOwners()]);
      let version = "?";
      try { version = await safe.VERSION(); } catch (_) {}
      console.log(`\nSafe ${admin}: версия ${version}, порог ${threshold} из ${owners.length}`);
      for (const o of owners) console.log("  подписант:", o);
    } catch (e) {
      console.log(`\nадминистратор ${admin} - контракт, но не отвечает как Safe: ${e.shortMessage || e.message}`);
      bad++;
    }
  } else {
    console.log(`\nадминистратор ${admin} - обычный кошелёк (не контракт). Для Polygon это СБОЙ: нужен Safe.`);
    if (network.name === "polygon") bad++;
  }

  // Роли выданы ещё кому-то? Считаем по событиям RoleGranted с развёртывания.
  try {
    const granted = await c.queryFilter(c.filters.RoleGranted(), 0, "latest");
    const revoked = await c.queryFilter(c.filters.RoleRevoked(), 0, "latest");
    const holders = new Map();
    for (const ev of granted) holders.set(ev.args.role + ev.args.account, ev.args);
    for (const ev of revoked) holders.delete(ev.args.role + ev.args.account);
    const roleName = (id) => Object.entries(roles).find(([, v]) => v === id)?.[0] || id;
    console.log("\nвсе действующие держатели ролей по событиям:");
    for (const a of holders.values()) {
      const known = [admin, minter, deployer].filter(Boolean).map((x) => x.toLowerCase()).includes(a.account.toLowerCase());
      console.log(`  ${roleName(a.role).padEnd(19)} ${a.account}${known ? "" : "   <- НЕИЗВЕСТНЫЙ АДРЕС"}`);
      if (!known) bad++;
    }
  } catch (e) {
    console.log("\nсобытия ролей не прочитаны (узел ограничивает диапазон):", e.shortMessage || e.message);
  }

  if (bad) throw new Error(`${bad} расхождений с ожидаемым`);
  console.log("\nВсе проверки приёмки сошлись.");
}

main().then(() => process.exit(0)).catch((e) => { console.error("\n" + (e.message || e)); process.exit(1); });
