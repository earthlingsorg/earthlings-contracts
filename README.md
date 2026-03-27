# Earthlings — Smart Contracts & Architecture

Soulbound Token (SBT) passport system for the Earthlings project — a voluntary, non-territorial self-determination framework grounded in international law.

## Deployed Contract

| Property | Value |
|----------|-------|
| **Contract** | `EarthlingPassportV2` |
| **Network** | Polygon Mainnet (Chain ID: 137) |
| **Address** | [`0x20e7962878429B803E35F83ba34eD291afEC2Be4`](https://polygonscan.com/address/0x20e7962878429B803E35F83ba34eD291afEC2Be4) |
| **Standard** | ERC-721 (Soulbound — non-transferable) |
| **Token Name** | Earthling Passport |
| **Symbol** | EARTH |

## What is Earthlings?

Earthlings is a collective self-determination project that applies **ICCPR Article 1** (the right of peoples to self-determination) to build a voluntary, non-territorial governance framework using blockchain infrastructure.

The project combines legal theory, political science, and Web3 technology to create:

- **SBT Passports** — non-transferable digital identity tokens (this contract)
- **Two-Circuit DAO** — Civic governance (1 person = 1 vote) + Project governance (1 project = 1 vote)
- **Honeycombs (Cells)** — modular 6-person organizational units (Professional and Project types)
- **Constitution of Humanity** — 50 articles, 12 sections
- **Web3 Federation** — umbrella structure for international legal advocacy

## Contract Features

- **Soulbound (non-transferable)**: transfers between wallets are blocked at the contract level
- **One passport per wallet**: prevents duplicate identities
- **Owner minting**: passports are minted after KYC verification
- **Burn by owner**: moderation capability for identity revocation
- **Burn by holder**: opt-out — any holder can voluntarily burn their passport
- **Pausable**: owner can pause minting in emergencies
- **On-chain metadata**: passport data stored directly on-chain (earthlingId, pseudonym, verificationHash)

## Architecture

See the [`/docs`](./docs/) folder for detailed documentation:

- [**ARCHITECTURE.md**](./docs/ARCHITECTURE.md) — Platform architecture overview
- [**IDENTITY_MODEL.md**](./docs/IDENTITY_MODEL.md) — Decentralized identity model
- [**SECURITY.md**](./docs/SECURITY.md) — Security model and threat mitigation
- [**DATA_MINIMIZATION.md**](./docs/DATA_MINIMIZATION.md) — Privacy and data minimization approach
- [**CONTRIBUTIONS_FLOW.md**](./docs/CONTRIBUTIONS_FLOW.md) — Contribution tracking system
- [**REPUTATION.md**](./docs/REPUTATION.md) — Reputation system design

## Tech Stack

- **Solidity** 0.8.20
- **OpenZeppelin** Contracts (ERC721, Ownable, Pausable)
- **Hardhat** (compilation, deployment, testing)
- **Polygon** Mainnet (low gas costs, EVM-compatible)

## Getting Started

```bash
# Install dependencies
npm install

# Compile contracts
npx hardhat compile

# Run local tests
npx hardhat test

# Deploy to Polygon (requires .env with DEPLOYER_PRIVATE_KEY)
cp .env.example .env
# Edit .env with your private key
npx hardhat run scripts/deploy.js --network polygon
```

## Related Projects

The Earthlings ecosystem includes additional private repositories for:

- **KYC Platform** — ML-powered identity verification, payment processing
- **Digital Platform** — DAO governance interface, cells management, chat
- **Main Website** — [earth-lings.org](https://earth-lings.org) (multilingual, 7+ languages)

## Legal Foundation

The Earthlings project is grounded in public international law, specifically:

- **ICCPR Article 1** — Right of peoples to self-determination
- **Declaration of Earthlings** — Founding act of the collective
- **Constitution of Humanity** — Governance framework (50 articles, 12 sections)

The **International Earthlings Foundation** (Georgian NNLE) serves as the legal interface for the project.

## Links

- Website: [earth-lings.org](https://earth-lings.org)
- Donate: [Giveth](https://giveth.io/project/earthlings-a-new-people-for-a-new-era)
- Contract: [PolygonScan](https://polygonscan.com/address/0x20e7962878429B803E35F83ba34eD291afEC2Be4)
- DAO: [Snapshot](https://snapshot.org/#/earthlings-dao.eth)
- Twitter/X: [@EarthlingsTeam](https://x.com/EarthlingsTeam)
- LinkedIn: [Arthur Arakelian](https://www.linkedin.com/in/arthur-arakelyan-83b1503ba/)

## License

MIT
