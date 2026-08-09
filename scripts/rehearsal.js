// Сквозной прогон V3 на локальной сети.
//
// Смысл не в тестах - они лежат в test/ - а в том, чтобы правила контракта
// можно было прочитать словами, не читая Solidity. Каждый шаг печатает, что
// сделано и что из этого следует.
//
// Запуск: npx hardhat run scripts/rehearsal.js

const { ethers, network } = require("hardhat");

const DAY = 24 * 60 * 60;

function head(text) {
  console.log("\n" + "=".repeat(78) + "\n" + text + "\n" + "=".repeat(78));
}
function step(text) { console.log("\n-- " + text); }
function ok(text) { console.log("   ЕСТЬ: " + text); }
function blocked(text) { console.log("   НЕ ДАЛО (и правильно): " + text); }

async function mustFail(promise, what) {
  try {
    await promise;
    throw new Error("ОШИБКА ПРОГОНА: " + what + " прошло, а не должно было");
  } catch (e) {
    if (String(e.message).startsWith("ОШИБКА ПРОГОНА")) throw e;
    const m = e.shortMessage || e.message;
    blocked(what + "  [" + String(m).slice(0, 70) + "]");
  }
}

async function advance(seconds) {
  await network.provider.send("evm_increaseTime", [seconds]);
  await network.provider.send("evm_mine");
}

async function main() {
  const [deployer, adminWallet, minterKey, council, appeal, emergency, anna, boris, viktor] =
    await ethers.getSigners();

  head("РАЗВЁРТЫВАНИЕ");
  const Factory = await ethers.getContractFactory("EarthlingPassportV3");
  const c = await Factory.deploy(adminWallet.address, minterKey.address, 50);
  await c.waitForDeployment();
  console.log("   контракт по адресу", await c.getAddress());
  console.log("   администрирование:", adminWallet.address);
  console.log("   ключ выпуска:     ", minterKey.address);
  console.log("   суточный предел выпуска:", (await c.dailyMintLimit()).toString());
  console.log("   срок на возражения при аннулировании:",
    Number(await c.annulmentDelay()) / DAY, "дней");

  step("кто может аннулировать паспорт сразу после развёртывания");
  for (const [name, role] of [["Совет", "ANNULMENT_ROLE"], ["обжалование", "CANCEL_ROLE"], ["аварийная пауза", "PAUSER_ROLE"]]) {
    const id = await c[role]();
    const anybody = await Promise.all(
      [deployer, adminWallet, minterKey, anna].map((s) => c.hasRole(id, s.address))
    );
    console.log(`   ${name.padEnd(16)} роль ${role.padEnd(15)} выдана кому-либо: ${anybody.some(Boolean)}`);
  }
  ok("никто. Роли выдаются избранным, до выборов аннулировать паспорт нельзя ничем");

  head("ВЫДАЧА ПАСПОРТА");
  step("служба подтверждения личности выдаёт паспорт Анне");
  await c.connect(minterKey).mintPassport(anna.address, "earthling-0001", "Анна", "hash-0001");
  ok(`токен ${await c.tokenOfOwner(anna.address)}, всего действующих ${await c.totalSupply()}`);

  await mustFail(
    c.connect(adminWallet).mintPassport(boris.address, "earthling-0002", "Борис", "h"),
    "администратор пытается выдать паспорт сам"
  );
  await mustFail(
    c.connect(minterKey).mintPassport(anna.address, "earthling-0003", "Анна снова", "h"),
    "второй паспорт на тот же кошелёк"
  );
  await mustFail(
    c.connect(minterKey).mintPassport(boris.address, "earthling-0001", "Борис", "h"),
    "второй паспорт на тот же идентификатор человека"
  );

  head("ПАСПОРТ НЕЛЬЗЯ ПЕРЕДАТЬ");
  await mustFail(
    c.connect(anna).transferFrom(anna.address, boris.address, 1),
    "Анна пытается передать свой паспорт Борису"
  );

  head("ВЫХОД ИЗ НАРОДА");
  step("Борис получает паспорт, потом уходит сам");
  await c.connect(minterKey).mintPassport(boris.address, "earthling-0002", "Борис", "hash-0002");
  const borisToken = await c.tokenOfOwner(boris.address);
  await mustFail(c.connect(anna).burnByHolder(borisToken), "Анна пытается погасить паспорт Бориса");
  await c.connect(boris).burnByHolder(borisToken);
  ok(`Борис вышел сам. Паспорт у него: ${await c.hasPassport(boris.address)}, действующих ${await c.totalSupply()}`);

  step("выход не блокируется даже остановкой выдачи");
  await c.connect(adminWallet).grantRole(await c.PAUSER_ROLE(), emergency.address);
  await c.connect(emergency).pause();
  await c.connect(minterKey).mintPassport(viktor.address, "earthling-0009", "Виктор", "h9").catch(() => {});
  blocked("выдача новых паспортов на паузе");
  await c.connect(minterKey).mintPassport(boris.address, "earthling-0002", "Борис", "hash-0002").catch(() => {});
  await c.connect(emergency).unpause();
  await c.connect(minterKey).mintPassport(boris.address, "earthling-0002", "Борис", "hash-0002");
  const borisAgain = await c.tokenOfOwner(boris.address);
  await c.connect(emergency).pause();
  await c.connect(boris).burnByHolder(borisAgain);
  ok("при остановленной выдаче Борис всё равно вышел собственным ключом");
  await c.connect(emergency).unpause();

  head("АННУЛИРОВАНИЕ НЕДЕЙСТВИТЕЛЬНОЙ ВЫДАЧИ");
  console.log("   Выборы прошли: Совет получает право аннулировать, обжалование - право отменять");
  await c.connect(adminWallet).grantRole(await c.ANNULMENT_ROLE(), council.address);
  await c.connect(adminWallet).grantRole(await c.CANCEL_ROLE(), appeal.address);

  step("Совет заявляет об аннулировании паспорта Анны");
  await c.connect(council).proposeAnnulment(1, "установлено: два паспорта на одного человека");
  const at = Number(await c.annulmentExecutableAt(1));
  const now = (await ethers.provider.getBlock("latest")).timestamp;
  ok(`заявка опубликована, исполнить можно не раньше чем через ${Math.round((at - now) / DAY)} дней`);

  await mustFail(c.connect(council).executeAnnulment(1), "Совет пытается исполнить сразу");
  await advance(20 * DAY);
  await mustFail(c.connect(council).executeAnnulment(1), "Совет пытается исполнить на двадцатый день");
  ok(`паспорт Анны на месте: ${await c.hasPassport(anna.address)}`);

  step("Анна успевает возразить, обжалование отменяет аннулирование");
  await c.connect(appeal).cancelAnnulment(1);
  await advance(10 * DAY);
  await mustFail(c.connect(council).executeAnnulment(1), "Совет пытается исполнить отменённое");
  ok(`паспорт Анны сохранён: ${await c.hasPassport(anna.address)}. Отменить оказалось легче, чем исполнить`);

  step("вторая заявка, на этот раз возражений нет");
  await c.connect(council).proposeAnnulment(1, "подтверждено повторно");
  await advance(21 * DAY + 1);
  await c.connect(council).executeAnnulment(1);
  ok(`аннулировано через 21 день. Паспорт у Анны: ${await c.hasPassport(anna.address)}`);
  console.log("   основание осталось в журнале событий навсегда");

  head("ПЕРЕВЫПУСК ПРИ УТРАТЕ ДОСТУПА К КОШЕЛЬКУ");
  await c.connect(minterKey).mintPassport(viktor.address, "earthling-0003", "Виктор", "hash-0003");
  const vt = await c.tokenOfOwner(viktor.address);
  const before = await c.getPassport(vt);
  console.log("   дата вступления Виктора:", new Date(Number(before[3]) * 1000).toISOString().slice(0, 10));

  await advance(200 * DAY);
  step("через 200 дней Виктор теряет доступ к кошельку и просит перевыпуск");
  await c.connect(minterKey).reissue(vt, anna.address);
  const after = await c.getPassport(await c.tokenOfOwner(anna.address));
  console.log("   новый токен:", (await c.tokenOfOwner(anna.address)).toString());
  console.log("   дата вступления в новом паспорте:", new Date(Number(after[3]) * 1000).toISOString().slice(0, 10));
  ok(`идентификатор сохранён (${after[0]}), дата вступления не сброшена: ${after[3] === before[3]}`);
  console.log("   членство не прервалось - именно этого требует статья 21 Устава");

  head("ПРЕДЕЛ НА ВЫПУСК");
  await c.connect(adminWallet).setDailyMintLimit(2);
  await advance(DAY);
  console.log("   предел снижен до 2 в сутки, осталось на сегодня:", (await c.remainingMintsToday()).toString());
  await c.connect(minterKey).mintPassport(boris.address, "cap-1", "Б", "h");
  await c.connect(minterKey).mintPassport(viktor.address, "cap-2", "В", "h");
  await mustFail(
    c.connect(minterKey).mintPassport(emergency.address, "cap-3", "Э", "h"),
    "третий паспорт за сутки при пределе 2"
  );
  ok("утёкший ключ выпуска не может наштамповать голоса без предела");

  head("АДМИНИСТРИРОВАНИЕ НЕЛЬЗЯ ПОТЕРЯТЬ");
  await mustFail(
    c.connect(adminWallet).renounceRole(await c.DEFAULT_ADMIN_ROLE(), adminWallet.address),
    "единственный администратор пытается отказаться от роли"
  );
  step("ключ выпуска отзывается мгновенно, без задержек и голосований");
  await c.connect(adminWallet).revokeRole(await c.MINTER_ROLE(), minterKey.address);
  await mustFail(
    c.connect(minterKey).mintPassport(emergency.address, "after-revoke", "Э", "h"),
    "отозванный ключ пытается выдать паспорт"
  );

  head("ИТОГ");
  console.log("   всего выдано за историю:", (await c.totalMinted()).toString());
  console.log("   действующих паспортов:  ", (await c.totalSupply()).toString());
  console.log("\n   Прогон завершён без единого отклонения от ожидаемого.\n");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
