# Earthlings Digital Platform — Architecture

## Overview
The Earthlings Digital Platform is a modular, security-first system built around:
- Web3 identity (wallet + SBT passport)
- Row-Level Security (RLS) enforced at the database layer
- Clear domain separation: Identity, Cells, Projects, Contributions, Reputation, Governance

The system is designed so that **business rules are enforced by the database**, not duplicated across services.

## High-level components
- **app.earth-lings.org** — user-facing digital platform (SPA / static frontend)
- **api.earth-lings.org** — backend API (Node.js + Express)
- **PostgreSQL** — primary data store with RLS
- **Blockchain** — identity anchor (wallet + SBT), not a data store

## Key architectural principles
1. Single backend API for all subdomains
2. Stateless API, session-based auth (httpOnly cookies)
3. Database-level authorization (RLS)
4. One-query dashboards for complex views
5. Auditability by default

## Request lifecycle
1. Wallet signs nonce
2. API verifies signature → session
3. Transaction middleware opens DB transaction
4. RLS context is set (`app.current_user_id`)
5. SQL query executes with enforced RLS
6. Audit events are written
7. Transaction commits

## Why this architecture
- Minimizes attack surface
- Prevents privilege escalation
- Makes audits and reviews straightforward
