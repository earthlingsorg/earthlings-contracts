// Выгрузка ABI EarthlingPassportV3 для служб KYC.
//
//   npx hardhat compile && node scripts/export-kyc-abi.js [путь к файлу]
//
// По умолчанию пишет в ../earthlings-kyc/app/config/passport-v3.abi.js (соседний
// репозиторий). Берёт из артефакта функции и события, которыми пользуется KYC, и
// ВСЕ ошибки контракта: по именам ошибок служба отличает повторяемый отказ
// (DailyMintLimitReached, EnforcedPause) от окончательного (AddressAlreadyHasPassport).
// Файл в KYC не редактируется руками - только перегенерируется этим скриптом.

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const artifactPath = path.join(__dirname, "..", "artifacts", "contracts", "EarthlingPassportV3.sol", "EarthlingPassportV3.json");
const out = process.argv[2] || path.join(__dirname, "..", "..", "earthlings-kyc", "app", "config", "passport-v3.abi.js");

const FUNCTIONS = [
  "mintPassport", "reissue", "burnByHolder",
  "balanceOf", "hasPassport", "totalSupply", "totalMinted", "ownerOf", "tokenURI",
  "getTokenByEarthlingId", "getPassport", "tokenOfOwner", "isEarthling", "earthlingCount",
  "remainingMintsToday", "dailyMintLimit", "mintedOnDay", "paused", "hasRole", "adminCount", "annulmentDelay",
  "DEFAULT_ADMIN_ROLE", "MINTER_ROLE", "ANNULMENT_ROLE", "CANCEL_ROLE", "PAUSER_ROLE",
  "pause", "unpause", "setBaseURI", "setDailyMintLimit",
];
const EVENTS = [
  "PassportMinted", "PassportBurned", "PassportBurnedByHolder", "PassportReissued",
  "AnnulmentProposed", "AnnulmentCancelled", "AnnulmentExecuted", "DailyMintLimitChanged",
  "Paused", "Unpaused",
];

const art = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
const pick = art.abi.filter((x) =>
  (x.type === "function" && FUNCTIONS.includes(x.name)) ||
  (x.type === "event" && EVENTS.includes(x.name)) ||
  x.type === "error"
);
const missing = FUNCTIONS.filter((n) => !pick.some((x) => x.type === "function" && x.name === n))
  .concat(EVENTS.filter((n) => !pick.some((x) => x.type === "event" && x.name === n)));
if (missing.length) {
  console.error("в артефакте нет:", missing.join(", "));
  process.exit(1);
}

let commit = "unknown";
try { commit = execSync("git rev-parse --short HEAD", { cwd: path.join(__dirname, "..") }).toString().trim(); } catch (_) {}

const header = `/**
 * ABI контракта EarthlingPassportV3 - та часть, которой пользуются службы KYC.
 *
 * Источник: earthlings-contracts/artifacts/contracts/EarthlingPassportV3.sol/EarthlingPassportV3.json,
 * коммит earthlings-contracts ${commit} (solc 0.8.20, OpenZeppelin 5.1.0). Выбраны функции и
 * события, нужные выпуску и проверкам, и ВСЕ ошибки контракта: по ним служба отличает
 * повторяемый отказ (DailyMintLimitReached, EnforcedPause) от окончательного
 * (AddressAlreadyHasPassport, EarthlingIdAlreadyUsed).
 *
 * Чего в V3 нет по сравнению с V2 и чего здесь поэтому нет: burn(uint256), owner(),
 * transferOwnership(), renounceOwnership(). Гасить паспорт может только держатель
 * (burnByHolder) либо аннулирование в два шага с задержкой не меньше 21 дня.
 *
 * Файл сгенерирован, руками не править. Перегенерация из earthlings-contracts:
 *   npx hardhat compile && node scripts/export-kyc-abi.js
 */
module.exports = `;

fs.writeFileSync(out, header + JSON.stringify(pick, null, 2) + ";\n");
console.log(`записано ${out}: функций ${pick.filter((x) => x.type === "function").length}, событий ${pick.filter((x) => x.type === "event").length}, ошибок ${pick.filter((x) => x.type === "error").length}`);
