// Защиты развёртывания, вынесены из deploy-v3.js, чтобы их можно было проверить тестами.
//
// Д9 (оркестратор, 2026-10-07): в основной сети администратор V3 обязан быть контрактом
// (Safe). Забытая подмена V3_ADMIN_ADDRESS после репетиции на Amoy отправила бы контракт
// в Polygon с горячим кошельком в DEFAULT_ADMIN_ROLE, и это необратимо: адрес
// администратора задаётся в конструкторе, а сменить его может только он сам.
//
// Д11: сеть определяется по chainId от узла, а не по имени в hardhat.config.js. Имя сети
// ничего не гарантирует: адрес узла берётся из .env и уже менялся; если в AMOY_RPC_URL
// окажется узел основной сети, network.name останется «amoy». Поэтому проверка закрыта по
// умолчанию: пропускаются только известные тестовые цепи, любая другая - в том числе
// неизвестная или ошибочно настроенная - требует контракт в администраторах.

/** Цепи, где администратор может быть обычным кошельком: hardhat, ganache, Polygon Amoy. */
const TEST_CHAIN_IDS = new Set([31337n, 1337n, 80002n]);

/**
 * Бросает, если цепь не из списка тестовых, а по адресу администратора нет кода.
 * @param {{getCode: (a: string) => Promise<string>, getNetwork: () => Promise<{chainId: bigint|number}>}} provider
 * @param {string} admin
 * @param {string} [networkLabel] - имя сети для сообщения, на решение не влияет
 * @returns {Promise<{chainId: bigint, checked: boolean, isContract: boolean}>}
 */
async function assertAdminIsContractOnMainnet(provider, admin, networkLabel = "") {
  const net = await provider.getNetwork();
  const chainId = BigInt(net.chainId);
  if (TEST_CHAIN_IDS.has(chainId)) {
    return { chainId, checked: false, isContract: false };
  }
  const code = await provider.getCode(admin);
  const isContract = typeof code === "string" && code !== "0x" && code.length > 2;
  if (!isContract) {
    throw new Error(
      `Администратор ${admin} в цепи chainId=${chainId}${networkLabel ? ` (сеть «${networkLabel}» в конфигурации)` : ""} - не контракт (getCode = 0x). ` +
      "Вне тестовых цепей DEFAULT_ADMIN_ROLE обязан быть Safe: подставьте адрес Safe в V3_ADMIN_ADDRESS. " +
      "Развёртывание отменено, ничего не отправлено."
    );
  }
  return { chainId, checked: true, isContract: true };
}

module.exports = { assertAdminIsContractOnMainnet, TEST_CHAIN_IDS };
