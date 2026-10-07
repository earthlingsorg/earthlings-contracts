// Защиты развёртывания, вынесены из deploy-v3.js, чтобы их можно было проверить тестами.
//
// Д9 (оркестратор, 2026-10-07): в основной сети администратор V3 обязан быть контрактом
// (Safe). Забытая подмена V3_ADMIN_ADDRESS после репетиции на Amoy отправила бы контракт
// в Polygon с горячим кошельком в DEFAULT_ADMIN_ROLE, и это необратимо: адрес
// администратора задаётся в конструкторе, а сменить его может только он сам.

const MAINNETS = new Set(["polygon", "mainnet"]);

/**
 * Бросает, если сеть основная, а по адресу администратора нет кода.
 * @param {{getCode: (a: string) => Promise<string>}} provider
 * @param {string} admin
 * @param {string} networkName
 * @returns {Promise<{checked: boolean, isContract: boolean}>}
 */
async function assertAdminIsContractOnMainnet(provider, admin, networkName) {
  if (!MAINNETS.has(String(networkName).toLowerCase())) {
    return { checked: false, isContract: false };
  }
  const code = await provider.getCode(admin);
  const isContract = typeof code === "string" && code !== "0x" && code.length > 2;
  if (!isContract) {
    throw new Error(
      `Администратор ${admin} в сети ${networkName} - не контракт (getCode = 0x). ` +
      "В основной сети DEFAULT_ADMIN_ROLE обязан быть Safe: подставьте адрес Safe в V3_ADMIN_ADDRESS. " +
      "Развёртывание отменено, ничего не отправлено."
    );
  }
  return { checked: true, isContract: true };
}

module.exports = { assertAdminIsContractOnMainnet, MAINNETS };
