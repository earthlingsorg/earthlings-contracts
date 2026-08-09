// Развёртывание EarthlingPassportV3.
//
//   npx hardhat run scripts/deploy-v3.js --network amoy      (тестовая сеть)
//   npx hardhat run scripts/deploy-v3.js --network polygon   (основная)
//
// Читает из .env:
//   DEPLOYER_PRIVATE_KEY  - ключ, с которого идёт развёртывание, нужен только для этого
//   V3_ADMIN_ADDRESS      - получит право выдавать и отзывать роли; должен быть мультиподписью
//   V3_MINTER_ADDRESS     - ключ службы подтверждения личности, только выпуск
//   V3_DAILY_MINT_LIMIT   - суточный предел выпуска, по умолчанию 50
//
// Скрипт намеренно отказывается разворачивать контракт, если администрирование
// и выпуск оказались одним адресом: тогда разделение ролей теряет смысл на
// первом же шаге, а именно ради него V3 и делался.

const { ethers, network } = require("hardhat");

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Не задано ${name} в .env`);
  return v;
}

async function main() {
  const admin = ethers.getAddress(need("V3_ADMIN_ADDRESS"));
  const minter = ethers.getAddress(need("V3_MINTER_ADDRESS"));
  const limit = BigInt(process.env.V3_DAILY_MINT_LIMIT || "50");

  if (admin.toLowerCase() === minter.toLowerCase()) {
    throw new Error(
      "Администрирование и выпуск заданы одним адресом. Так делать нельзя: " +
      "смысл V3 в том, что ключ, выдающий паспорта, не может менять роли."
    );
  }
  if (limit <= 0n) throw new Error("V3_DAILY_MINT_LIMIT должен быть больше нуля");

  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);

  console.log("сеть:                  ", network.name);
  console.log("разворачивает:         ", deployer.address);
  console.log("баланс:                ", ethers.formatEther(balance));
  console.log("администрирование:     ", admin);
  console.log("ключ выпуска:          ", minter);
  console.log("суточный предел выпуска:", limit.toString());

  if (balance === 0n) throw new Error("На счету разворачивающего нет средств на газ");

  const Factory = await ethers.getContractFactory("EarthlingPassportV3");
  const c = await Factory.deploy(admin, minter, limit);
  console.log("\nтранзакция отправлена:", c.deploymentTransaction().hash);
  await c.waitForDeployment();

  const address = await c.getAddress();
  console.log("контракт развёрнут:   ", address);

  // Проверяем то, что должно быть верно сразу после развёртывания.
  const checks = [
    ["администрирование у заданного адреса", await c.hasRole(await c.DEFAULT_ADMIN_ROLE(), admin)],
    ["выпуск у заданного адреса", await c.hasRole(await c.MINTER_ROLE(), minter)],
    ["разворачивающий не получил администрирование", !(await c.hasRole(await c.DEFAULT_ADMIN_ROLE(), deployer.address))],
    ["роль аннулирования никому не выдана", !(await c.hasRole(await c.ANNULMENT_ROLE(), admin)) && !(await c.hasRole(await c.ANNULMENT_ROLE(), minter))],
    ["срок на возражения не ниже 21 дня", (await c.annulmentDelay()) >= (await c.MIN_ANNULMENT_DELAY())],
    ["паспортов пока ноль", (await c.totalSupply()) === 0n],
  ];
  console.log("\nпроверки после развёртывания:");
  let allOk = true;
  for (const [what, pass] of checks) {
    console.log("  " + (pass ? "ок  " : "СБОЙ") + "  " + what);
    if (!pass) allOk = false;
  }
  if (!allOk) throw new Error("Развёрнутый контракт не прошёл проверки. Не используйте этот адрес.");

  console.log("\nчто делать дальше:");
  console.log("  1. Верифицировать исходник:");
  console.log(`     npx hardhat verify --network ${network.name} ${address} ${admin} ${minter} ${limit}`);
  console.log("  2. Прописать адрес в окружении служб: SBT_CONTRACT_ADDRESS и POLYGON_CONTRACT_ADDRESS");
  console.log("  3. Заменить блок ABI в earthlings-kyc/app/services/minting-service.js");
  console.log("  4. Перенастроить стратегию голосований в Snapshot на новый адрес");
  console.log("  5. Обновить адрес в ru32, SBT-паспорте и README_DAO.md");
  console.log("  6. Роли ANNULMENT_ROLE, CANCEL_ROLE и PAUSER_ROLE выдать после выборов");
}

main().then(() => process.exit(0)).catch((e) => { console.error("\n" + e.message); process.exit(1); });
