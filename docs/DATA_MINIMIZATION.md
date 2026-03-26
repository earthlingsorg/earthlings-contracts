# Data Minimization Policy

## Objective
Ensure that the Earthlings platform collects and processes **only data strictly required**
to operate the digital coordination system.

## Categories of data

### Required (MVP)
- user_id (UUID)
- wallet address + chain
- SBT status (minted / revoked / etc.)
- project, cell, contribution content
- reputation events (non-financial)

### Optional (user-controlled)
- display name
- country code
- bio

### Derived
- reputation score (derived from events)
- membership counts
- activity metrics

## Explicitly excluded
- passwords
- emails (unless later added for notifications)
- phone numbers
- government identifiers
- biometric artifacts
- financial balances

## Design strategies
- Prefer derivation over storage
- Use event logs instead of mutable state
- Aggregate where possible
- Store references instead of raw documents

## Enforcement mechanisms
- Schema constraints
- Limited column sets
- No free-form personal data fields
- Periodic schema review before extensions

## Developer rules
- Adding new personal data requires:
  - justification
  - review
  - update to this document
