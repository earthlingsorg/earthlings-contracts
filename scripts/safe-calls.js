// Данные вызовов для Safe Transaction Builder - роли и действия администратора V3.
//
//   V3_ADDRESS=0x... npx hardhat run scripts/safe-calls.js --network polygon
//
// Читает V3_ADDRESS (адрес развёрнутого V3), V3_ADMIN_ADDRESS (Safe), V3_MINTER_ADDRESS.
// Значения ролей ЧИТАЮТСЯ ИЗ КОНТРАКТА, не набираются руками. Печатает для каждого вызова:
// адрес контракта, имя функции, аргументы для полей Transaction Builder и готовый
// calldata (hex) на случай ввода «Custom data». Ничего не отправляет.
//
// Разделы: фаза 4 (три grantRole по Р3), репетиция на боевом Safe (setDailyMintLimit(100)
// при уже равном 100 - безвредно, только событие), плохой день (pause, смена ключа выпуска).

const { ethers, network } = require("hardhat");
require("dotenv").config();

async function main() {
  const address = ethers.getAddress(process.env.V3_ADDRESS || (network.name === "amoy" ? process.env.V3_AMOY_ADDRESS : "") || "");
  const safe = ethers.getAddress(process.env.V3_ADMIN_ADDRESS);
  const minter = ethers.getAddress(process.env.V3_MINTER_ADDRESS);
  const c = await ethers.getContractAt("EarthlingPassportV3", address);
  const iface = c.interface;

  const roles = {
    MINTER_ROLE: await c.MINTER_ROLE(),
    ANNULMENT_ROLE: await c.ANNULMENT_ROLE(),
    CANCEL_ROLE: await c.CANCEL_ROLE(),
    PAUSER_ROLE: await c.PAUSER_ROLE(),
  };
  const limit = await c.dailyMintLimit();

  const print = (title, fn, args) => {
    console.log(`\n--- ${title}`);
    console.log(`  To (контракт):   ${address}`);
    console.log(`  Function:        ${fn}`);
    args.forEach(([name, value]) => console.log(`  ${(name + ":").padEnd(17)}${value}`));
    console.log(`  Custom data:     ${iface.encodeFunctionData(fn, args.map(([, v]) => v))}`);
  };

  console.log("сеть:    ", network.name);
  console.log("контракт:", address);
  console.log("Safe:    ", safe);
  console.log("ключ выпуска:", minter);
  console.log("\nзначения ролей из контракта:");
  for (const [k, v] of Object.entries(roles)) console.log(`  ${k.padEnd(15)} ${v}`);

  console.log("\n" + "=".repeat(78) + "\nФАЗА 4, ШАГ 3: три вызова grantRole(bytes32,address) одной пачкой в Transaction Builder\n" + "=".repeat(78));
  for (const name of ["ANNULMENT_ROLE", "CANCEL_ROLE", "PAUSER_ROLE"]) {
    print(`grantRole ${name} -> Safe`, "grantRole", [["role (bytes32)", roles[name]], ["account (address)", safe]]);
  }

  console.log("\n" + "=".repeat(78) + "\nРЕПЕТИЦИЯ НА БОЕВОМ SAFE: setDailyMintLimit при том же пределе - ничего не меняет\n" + "=".repeat(78));
  print(`setDailyMintLimit(${limit}) (сейчас в контракте ${limit})`, "setDailyMintLimit", [["newLimit (uint256)", limit.toString()]]);
  console.log("  ожидаемое событие: DailyMintLimitChanged(" + limit + ", " + limit + ")");

  console.log("\n" + "=".repeat(78) + "\nПЛОХОЙ ДЕНЬ (утечка ключа выпуска): пауза, затем смена ключа\n" + "=".repeat(78));
  print("1. pause() - остановить выпуск", "pause", []);
  print("2. revokeRole MINTER_ROLE у старого ключа", "revokeRole", [["role (bytes32)", roles.MINTER_ROLE], ["account (address)", minter]]);
  console.log("\n--- 3. grantRole MINTER_ROLE новому ключу: адрес нового ключа создаётся на сервере (часть А файла команд)");
  console.log(`  To (контракт):   ${address}\n  Function:        grantRole\n  role (bytes32):  ${roles.MINTER_ROLE}\n  account:         <НОВЫЙ_АДРЕС>`);
  print("4. unpause() - после того как .env сервера переведён на новый ключ", "unpause", []);
}

main().then(() => process.exit(0)).catch((e) => { console.error("\n" + (e.message || e)); process.exit(1); });
