# Security Model

## Identity
- No passwords
- Wallet-based authentication
- SBT passport as long-term identity anchor

## Sessions
- httpOnly cookies
- SameSite=strict
- Secure flag in production
- Server-side session storage

## Transport security
- HTTPS only
- HSTS enabled
- CSP enforced via Helmet

## Database security
- RLS on all sensitive tables
- Least-privilege DB roles
- No direct DB access from frontend

## Audit
- All sensitive actions are logged:
  - Auth
  - Membership changes
  - Contributions
  - Reputation changes

## Threats mitigated
- Privilege escalation
- Horizontal data leaks
- Logic bugs in API
- Replay attacks (nonce-based auth)
