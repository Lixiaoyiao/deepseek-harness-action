# DSH execution and isolation

`runDsh` admits a request, binds an immutable runtime, executes one worker turn,
and returns a validated result. `DshRunScope` owns the absolute deadline,
cumulative setup budget and resource cleanup ledger. `DshWorker.run()` owns
preparation, execution, terminal validation and turn evidence. Compositions retain
their separate policy responsibilities: controlled mode generates Controller
guards and receipts; native mode delegates tool inventory and policy to DSH.

The process adapter owns actual process termination. On POSIX it signals the
worker process group, escalates to `SIGKILL` after the grace period, and waits for
the output channels to close. The group still needs escalation when its leader
has exited but a descendant keeps stdout or stderr open. Docker workers also
carry an explicit container termination command. A deadline allocates an
execution budget; it does not prove that the worker has already stopped.

## Supported Docker hosts

Docker mode requires a local Linux Docker daemon whose bridge gateway is an
address of the Controller host. Use a dedicated runner with no concurrent
untrusted workloads. Docker Desktop and remote Docker daemons are unsupported:
their gateways ordinarily belong to another host or VM, so the Controller cannot
listen on the required address.

The Controller inspects the selected worker network and binds the ephemeral
credential proxy only to that network's IPv4 gateway. It uses the same address in
the worker URL. Wildcard, loopback and multicast gateways are rejected; there is
no wildcard fallback. If the gateway is unavailable locally, execution fails
before the worker starts with an isolation error that identifies the local Linux
requirement. The proxy keeps the real DeepSeek key Controller-side and issues a
temporary worker token. Restricting its listening address reduces unrelated
network exposure; it does not isolate the proxy from other processes on the same
runner or replace the runner firewall.

Workers without extension egress use a disposable internal Docker network.
Explicitly network-enabled extensions share the worker's bridge egress, including
other code inside that worker. Installer containers use bridge networking to
acquire pinned packages; package identities, preserved runtime inventory and lock
provenance are audited before worker launch. The worker receives the installed
package tree read-only.

## Cancellation and late cleanup

The scope registers network removal before attempting network creation. A
cancelled or timed-out Docker command can still create the named network after
the first cleanup attempt. The scope observes the underlying command's eventual
success or failure and repeats bounded removal if its execution budget has
already ended. Removal uses a surviving host temporary directory because the
caller may already have deleted its workspace.

Late proxy and runtime acquisitions are similarly disposed when they eventually
arrive. Cleanup failures produce warnings and preserve the primary result or
failure. Each cleanup attempt has a separate fixed bound; a failed or unreachable
Docker daemon can still require runner-level recovery. The scope does not extend
the worker's deadline to wait indefinitely for cleanup.
