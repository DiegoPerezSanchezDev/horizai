# FASE 12F.12N — Windows DNS root cause and single M38 bind

Captured 2026-10-21. This run investigated the reported Windows/Node DNS intermittency, performed the authorized read-only preflight, dispatched one M38 revision bind, reconciled its failure, and stopped before any human decision or publication.

## DNS findings

The active Wi-Fi adapter was Intel Wi-Fi 6 AX201 at `192.168.1.37`, using gateway `192.168.1.1`. Its TCP/IP registry configuration was static DNS `8.8.8.8, 8.8.4.4`; DHCP advertises `80.58.61.254, 80.58.61.250`. The Wi-Fi default route had metric 35. A ZeroTier default route was also present with metric 10034, so Wi-Fi remained the preferred route. The DNS Client service was running. The current-user proxy was disabled, proxy environment variables were absent, and the target hostname was absent from the hosts file. The WinHTTP proxy query was unavailable. No matching Supabase NRPT rule was found.

The Windows CIM-backed adapter and DNS cmdlets could not read their provider in this execution context. The network state was captured through `ipconfig`, the route table, and the TCP/IP registry. Windows DNS event-log queries were also inaccessible, so historical timeout events could not be confirmed.

In the restricted command context, Node reported `ENOTFOUND` for `dns.lookup`, and explicit DNS resolver requests timed out. The same host then resolved from the Windows default resolver and from `8.8.8.8`, `8.8.4.4`, `1.1.1.1`, and the DHCP DNS server when the checks ran outside that restriction. Node `lookup` and `resolve4` also succeeded there. Node returned `ENODATA` for `resolve6`; the host has usable A records, so this did not prevent transport. Node HTTPS and `curl` reached the Supabase origin over verified TLS and received HTTP 401 from the unauthenticated REST endpoint.

This comparison identifies the DNS failures reproduced in this run as restricted-execution network egress, rather than a current Windows resolver failure. It does not establish the cause of earlier intermittent failures on the normal Windows network. No local network recovery was warranted: no DNS flush or adapter setting change was made.

## Remote preflight and bind

The read-only preflight confirmed the exact review was still `WAITING_FOR_HUMAN_REVIEW`, unconsumed, and targeted at `ORIGINAL`; the M38 revision read returned `found: false`. The original draft hash was `3e03a0ada667bd6b46be7f99ac06d5c24ca80e82adaa33e85bb090a7b4062b14`. The corrected revision hash was `69f0d3e350621f86c69a72d2cb1cbf1cb390212d695f932eedb03d325ade2045`, and source lineage remained `42c5de597f333d80c31d634f61960181d7f5480201237b9f447d37b651d968dc`. The durable Critic/M34 proof passed. Two published articles and provider usage matched the preceding baseline.

Exactly one `bind_pipeline_human_review_revision` request was dispatched. PostgREST returned HTTP 400 with SQLSTATE `42725`: `operator is not unique: unknown - unknown`. Its hint was `Could not choose a best candidate operator. You might need to add explicit type casts.` The post-failure read found no revision. The review remained waiting, unconsumed, and targeted at the original draft. Published article fingerprints and provider usage remained unchanged.

The bind attempt therefore did not commit. The one authorized dispatch is consumed; this phase made no retry. M38 was already deployed and was not changed; no M39 was created. No approve, hold, reject, Publisher, provider, or pipeline action ran. Because the bind failed, this phase did not prove a corrected-revision approval or publication target. The run stopped on the exact database ambiguity as requested.

The safe RPC diagnostic and reconciliation record are in [the phase artifact](../artifacts/supervised-cycle-12f12n-dns-bind.json).
