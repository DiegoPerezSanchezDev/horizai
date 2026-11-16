# 12F.12M.2 — Transport recheck and pending bind

Run timestamp: 2026-10-21T09:24:41.742Z

## Result

`BLOCKED_DNS`. The transport gate failed before HTTP. The pending M38 bind was not dispatched and remains unconsumed.

## Transport

The hostname was derived from `NEXT_PUBLIC_SUPABASE_URL` loaded with the repository's Node `--env-file-if-exists=.env.local` mechanism. Only the hostname was emitted; no credential value was read into output or displayed.

- Hostname: `skrthgpurquypgdwxast.supabase.co`
- Node `dns.lookup`: `ENOTFOUND`
- Node `dns.resolve4`: `ETIMEOUT`
- Node HTTPS: `NOT_RUN` (stopped after `dns.lookup` returned `ENOTFOUND`)
- `curl.exe` HTTPS: `NOT_RUN` (stopped after `dns.lookup` returned `ENOTFOUND`)
- PowerShell `Resolve-DnsName`: `NOT_RUN`

## Remote state and bind

The transport contract requires successful Node DNS, Node HTTPS with an HTTP response, and `curl.exe` with an HTTP response. Since Node `dns.lookup` returned `ENOTFOUND`, no privileged read or remote precondition check was made.

- Privileged read: `NOT_RUN`
- Remote preconditions: `NOT_REVALIDATED`
- Review `ebd8acc0-76a2-4977-81d9-60a7f6240084`: `NOT_REVALIDATED`
- Corrected draft hash: expected `69f0d3e350621f86c69a72d2cb1cbf1cb390212d695f932eedb03d325ade2045`; not recomputed in this run because the transport gate stopped execution
- Bind calls dispatched: `0`
- Bind result: `NOT_RUN`
- Reconciliation: `NOT_RUN`
- Human decisions: `0`
- Publisher: `NOT_RUN`
- Provider calls: `0`
- Pipeline runs: `0`
- Remote writes: `0`

## Readiness

`READY FOR FINAL HUMAN APPROVAL = NO`. The review state, corrected revision, approval target, stale approval protection, and Publisher target were not revalidated. Stop here. Do not retry the bind, approve, hold, reject, or publish.
