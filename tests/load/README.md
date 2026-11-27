# Load and resilience tests

Black-box load and resilience scenarios for the API. They call the API directly over HTTP, with no
dependencies: Node 24, `fetch`, and a small async worker pool in `lib/pool.mjs`.

```sh
node tests/load/run.mjs                              # scenarios 1 to 5, about 8 minutes on a first run
node tests/load/run.mjs --soak                       # also scenario 6, 10 minutes
node tests/load/run.mjs --only=booking,sse           # pick scenarios
node tests/load/run.mjs --duration=20                # shorter read, write and SSE phases (smoke check)
node tests/load/run.mjs --think-ms=0                 # read scenario as a closed loop (saturation)
node tests/load/run.mjs --out=/tmp/results.json      # also write every number to a JSON file
```

Scenario names for `--only`: `read-heavy`, `write-heavy`, `auth-storm`, `booking`, `sse`, `soak`.

## Before you run

1. **The API is running** and its database is up. `GET $API_URL/readyz` must return 200. The runner checks this
   first and stops if it does not.
2. **Verification codes can be read.** Accounts are created through signup, and the 6-digit codes are read either
   from Mailpit (default, `MAILPIT_URL`, `http://localhost:8025`, as in `tests/e2e`) or from the API's log
   (`CODE_SOURCE=api-log`). Use the log mode when the API runs its development log sender, as the kind overlay does:
   it prints "email (not sent: development log sender)" and never reaches Mailpit.
3. **`PROXY_SECRET` is set to the API's value.** The suite signs one client IP per simulated user with the same
   HMAC the Next.js proxy uses (`x-client-ip` and `x-client-ip-signature`). The API's read, write and sign-in budgets
   are keyed by client IP, so without signing, every simulated user shares one budget and the results mean nothing.
   The runner refuses to start without it. The value is never printed.

   Local compose stack, without printing the secret:

   ```sh
   export PROXY_SECRET="$(docker inspect wa-api-dev --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^PROXY_SECRET=//p')"
   ```

   kind cluster: the value is in the local overlay (`deploy/k8s/overlays/local/secrets.env`). Read it from there, and do
   not paste it into commands or logs:

   ```sh
   export PROXY_SECRET="$(sed -n 's/^PROXY_SECRET=//p' deploy/k8s/overlays/local/secrets.env)"
   ```

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `API_URL` | `http://127.0.0.1:8080` | API origin, without `/api/v1`. |
| `MAILPIT_URL` | `http://localhost:8025` | Mailpit origin, for verification codes (`CODE_SOURCE=mailpit`). |
| `CODE_SOURCE` | `mailpit` | `api-log` reads codes from the API's log instead. |
| `API_LOG_COMMAND` | `kubectl -n invigil logs deploy/api --since=15m` | Prints the API log in `api-log` mode. Split on spaces and run without a shell. |
| `PROXY_SECRET` | none, required | Signs the simulated client IPs. Must match the API. |
| `DOCKER_CONTAINER` | `wa-api-dev` | Container whose memory the soak test samples. Skipped if absent. |
| `LOAD_PASSWORD` | `Correct horse battery 57!` | Password for the disposable accounts this suite creates. |
| `LOAD_RUN_ID` | random 8 hex chars | Names this run's storm accounts, booking resource and notes. Set it to repeat a run exactly. |

Flags: `--only`, `--soak`, `--duration` (seconds, default 60, applies to scenarios 1, 2 and 5), `--soak-duration`
(seconds, default 600), `--think-ms` (default 2000), `--out`.

## Scenarios

Each scenario prints its checks and notes, then the summary table. A check is `PASS`, `FAIL` or `SKIP`. A scenario
passes when none of its checks fail. A scenario that throws is `ERROR`.

### 1. read-heavy

200 virtual users list and read notes for 60 s. First it seeds 10,000 notes across 50 owners (200 each) through
`POST /entities/notes`, with an `Idempotency-Key` per (owner, index). Content is deterministic, so a rerun replays
the same requests and creates no duplicates. Owners that already have 200 or more notes are skipped with no writes.

Each VU is a visitor with its own signed IP, acting as owner `i % 50`. Its mix per iteration is 60% list with cursor
paging (`scope=mine`, `limit=20`), 30% read one note by id, and 10% search (`q=`, sometimes `filter[pinned]=true`).
Each VU thinks for `--think-ms` (jittered 0.5 to 1.5 times) between iterations. A per-VU pacer keeps each IP near
545 requests/min, under the 600/min read budget.

### 2. write-heavy

50 users, two workers each, all sharing one signed IP and one pacer (about 85 writes/min per user, under the
120/min write budget). Each user starts with 4 notes. Then, for 60 s, 90% of operations are `PATCH` with `If-Match`
set to the version the worker last saw, and 10% are creates.

- On `409 VERSION_CONFLICT`, the worker adopts `details.currentVersion` and continues. These conflicts are expected
  under contention and are reported, not failed.
- Afterwards every tracked note is re-read. The suite checks that:
  - the final version is exactly `1 + successful updates` (lost or phantom updates);
  - the successful versions are unique and contiguous (no duplicates or gaps);
  - the body matches the body written at the final version;
  - every record's `ownerId` is the owner, and every tracked record appears in that owner's `scope=mine` listing
    (wrong-owner or missing records).

### 3. auth storm

500 sign-in attempts with a wrong password, across 100 verified accounts created for this run and 50 IPs.
The budgets are 20 sign-ins per IP and 8 per account per 15 minutes (`kernel/src/security.rs`). If 500 attempts were
spread evenly over 50 IPs and 100 accounts, no budget would ever be reached (10 per IP, 5 per account), so the storm
is built to hit each budget deliberately and to keep background traffic under them:

| Phase | Attempts | Expected |
| --- | --- | --- |
| `ip`: 5 hot IPs, 30 attempts each, against cold accounts | 150 | 20 pass and 10 limited per IP: **50 `RATE_LIMITED`** |
| `account`: 5 hot accounts, 20 attempts each, from cold IPs | 100 | 8 pass and 12 limited per account: **60 `RATE_LIMITED`** |
| `background`: spread over cold accounts and IPs | 250 | all pass the budgets: **0 `RATE_LIMITED`** |

Every cold account receives at most 5 attempts and every cold IP at most 8, so nothing outside the intended phases
can be limited. The 390 remaining responses must be `401 INVALID_CREDENTIALS`. Each `429` must carry a positive
`Retry-After`. During the storm, four probes poll `GET /api/v1/health` at 5 requests/s each. The health p95 is
checked against the budget, and any non-200 health response is reported with its status and code.

Sign-in is checked before the account lookup, so the limits apply the same way to known and unknown addresses.
The storm uses accounts created for this run, so a rerun within 15 minutes starts with fresh budgets.

### 4. booking contention

A resource with capacity 1, one-hour slots, and availability open all day. Five free slots are chosen starting 2 hours
from now. 100 distinct bookers (each on its own IP) then book at the same moment, with attempt `i` aiming at slot
`i % 5`. Afterwards the owner's view must show exactly one confirmed booking per slot and no free seats left on those
slots. The resource is soft-deleted at the end.

### 5. SSE

300 subscribers on `GET /entities/notes/events?scope=mine`. Each user may hold 5 streams, so the subscribers are
60 users with 5 streams each. The first 20 of those users also write: 20 writers create notes at roughly one per
1.5 s for 30 s. Each writer's five streams must receive every create. The other 40 users must receive nothing.

- **Delivery latency** is measured end to end, from just before the writer sends its `POST` to when the subscriber
  receives the `change` frame, so it includes the write itself. The writer's `POST` latency is also reported on
  its own, so a slow delivery can be attributed to the write or to the stream.
- **Leaks:** any `change` frame on a stream whose user is not the record's owner.
- **Missing:** any expected delivery that never arrives.
- Writers start only after every subscriber has its first frame (the `retry:` frame). The server creates the
  broadcast subscription before it returns the response, so a live first frame means no change made after it can
  be missed.

### 6. soak (`--soak`)

Ten minutes of mixed traffic: 60 readers (with think time), 10 writers (one `PATCH` per 800 ms, `If-Match`), and 20
realtime streams. Container memory from `docker stats --no-stream` is sampled before the load, once a minute during
it, and after it. If Docker or the container is unavailable, the memory check is `SKIP`, not `FAIL`.

## Budgets

The numbers live in `lib/budgets.mjs`. The reasoning is here, so a change to a number should come with a change here.
Targets are for the local debug build (`wa-api-dev`, Postgres in a container, Docker Desktop on Windows, the client on
the same laptop). That is slower than a release build on a real host, so the latency numbers are generous. The
correctness numbers are not: a lost update, a leaked id or an unexpected 5xx fails at any speed.

| Scenario | Check | Budget | Why |
| --- | --- | --- | --- |
| 1 | p95 of all reads | <= 500 ms | The point at which a person notices a page is slow. |
| 1 | p99 of all reads | <= 1500 ms | Tail ceiling. It catches stalls such as lock waits or pool starvation. |
| 1 | throughput vs offered load | >= 90% of `VUs / (think + mean latency)` | With think time, users set the rate, so the check asks whether the client kept up with them. With `--think-ms=0` (closed loop, a saturation test) the floor is 100 req/s instead. |
| 1 | non-2xx responses | 0 | The paced load stays under the per-IP budget, so any 429 or 5xx is a regression. |
| 1 | notes in dataset | >= 10,000 | Precondition: the scenario must test the dataset it describes. |
| 2 | p95 / p99 of writes | <= 800 / 2000 ms | A `PATCH` does validation, a row lock and an event. That is about 1.6 times a read. |
| 2 | 429 responses | 0 | Paced under the 120/min per-IP write budget. |
| 2 | unknown outcomes (timeouts, network, 5xx) | 0 | An unknown write cannot be counted, so none are allowed. |
| 2 | lost or phantom updates | 0 | Final version must be `1 + successes`. |
| 2 | duplicate or gapped versions, body mismatch | 0 | Each successful update must be a distinct, contiguous version whose body is what the final version holds. |
| 2 | wrong-owner or missing records | 0 | Data isolation. |
| 3 | 429s from the IP budget / account budget / background | exactly 50 / 60 / 0 | Shows the documented budgets fire where they should and nowhere else. |
| 3 | 401s / total 429s | exactly 390 / 110 | Every attempt has one of the two expected outcomes. |
| 3 | health p95 during storm | <= 200 ms | Liveness must not degrade under auth load. |
| 3 | health non-200 during storm | 0 | As above. |
| 4 | successful bookings | exactly 5 | One success per slot on a capacity-1 resource. |
| 4 | p95 of booking attempts | <= 1000 ms | A booking is a transaction, an advisory lock and a constraint check. The lock serialises attempts on one resource. |
| 5 | streams open | 300 | Each stream must start and send its first frame. |
| 5 | leaks, missing deliveries | 0, 0 | Scope and delivery guarantees. |
| 5 | p95 / p99 delivery | <= 500 / 1000 ms | Delivery is notify-driven, so it should be near immediate. The budget covers debug and Docker. |
| 6 | p95 of reads and writes | <= 500 ms | As in scenario 1. |
| 6 | unexpected responses | 0 | Any 5xx or 429 over ten minutes is a regression. |
| 6 | memory growth | <= 25% | Warm-up of allocators and caches is normal. More than 25% in ten minutes is worth investigating. It is a heuristic, not proof of a leak. |

## Reading the output

Each scenario prints:

- **checks**, one line each: `[PASS]`, `[FAIL]` or `[SKIP]`, with the actual value and the budget;
- **notes**: context such as outcome counts (for example `201: 5, 409 CONFLICT: 95`), the phase breakdown, and the
  first exception if there was one;
- **verdict** and wall time.

The summary table at the end has `requests`, `rps`, `p50`, `p95`, `p99` (milliseconds, all operations of the scenario)
and `checks` as passed/scored.

- `p50` is typical. `p95` and `p99` are the tail. Under contention the tail moves first, so always read p95 and p99
  together with throughput: if throughput stops rising while latency climbs, the server is saturated.
- Outcome keys are `status CODE`. `0 TIMEOUT` and `0 NETWORK` are client-side and count as unknown outcomes.
- A `429` with `RATE_LIMITED` is the API saying a budget was used up, not a failure by itself. Scenarios 1 and 2
  are paced to stay under budget, so there a `429` is a failure. Scenario 3 expects them.
- `SKIP` means the check could not be measured here (for example, no Docker). It does not fail the run.
- A run that is not clean is still informative. Compare the counts in the notes with the checks.

### Reruns and rate-limit windows

Budgets are counted over windows from one minute (API reads and writes) to one hour (signup). Within a window, a
rerun starts with whatever the previous run left behind. The suite avoids most of this by design:

- every simulated user has a new IP, so per-IP counters start empty;
- the 100 storm accounts are new for each run;
- the pool accounts (`loadtest-pool-000..100@example.test`) are signed in, not created. A successful sign-in resets
  that account's sign-in counter; the per-IP counter is not reset, which is why each sign-in gets a new IP;
- booking resources are soft-deleted at the end and do not count toward the 50-per-owner cap.

Pool accounts keep their notes between runs. Seeding is skipped once an owner has 200 notes, so the second run is quick.

## Running against the kind cluster

```sh
export API_URL=http://api.localtest.me
export CODE_SOURCE=api-log                       # the kind API logs codes instead of sending mail
export PROXY_SECRET="$(sed -n 's/^PROXY_SECRET=//p' deploy/k8s/overlays/local/secrets.env)"
node tests/load/run.mjs --only=read-heavy,auth-storm
```

Scenarios 1 and 3 are the ones requested for the cluster. The others need only the same variables. For each simulated
user to get its own budget, the ingress must pass `x-client-ip` and `x-client-ip-signature` through unchanged. If it
strips or rewrites them, the API falls back to the ingress address and every request shares one budget, which shows
up as 429s in scenario 1. Check the first run for that before trusting its numbers.

Before running, check the API pod. The API container's memory limit is `256Mi` (`deploy/k8s/base/deployment.yaml`).
The debug binary uses about 670 MiB idle in the compose stack, so under
load the kernel kills it (`OOMKilled`, exit 137). Each kill returns 502 from the ingress until the pod is ready, and
provisioning fails. Raise the limit before a cluster run; the suite does not change cluster configuration.

## Not covered

- Real browser behaviour and the Next.js proxy path. The suite talks to the API directly, as instructed.
- Failure injection, such as killing a pod or the database mid-run. Use the suite's output to see whether a fault
  is visible, then design that test separately.
- Measuring a release build. Numbers from the debug image are pessimistic; compare like with like.
- Client resources. Node, the API and Postgres share one laptop in the local setup, so the client can skew
  latency. Check the client's CPU if the numbers look odd.

## Results from the first runs (2026-11-23)

Local API: `wa-api-dev` (debug build, Docker Desktop on Windows), client on the same laptop, one run per line unless
noted. Latencies in ms. Re-run before quoting; these are a baseline, not a release benchmark.

| Scenario | Verdict | Numbers |
| --- | --- | --- |
| 1 read-heavy, 200 VUs, 60 s, think 2 s | latency PASS | p50 25.9, p95 118.5, p99 178.6; 93.6 req/s, which is about 99% of the 94 offered; 0 non-2xx. |
| 1 read-heavy, closed loop (think 0), 30 s | saturation | p50 543, p95 1168, p99 1372; 314 req/s; API container CPU about 400%, Postgres about 2%. |
| 2 write-heavy, 50 users, 60 s | PASS (10/10) | p50 196, p95 579, p99 835; 71 req/s; 3,933 updates, 6 version conflicts; 0 unknown, 0 lost, 0 duplicate, 0 wrong-owner. |
| 3 auth storm, 500 attempts | PASS when clean | Exact: 50 / 60 / 0 limited by IP / account / background, 390 401s; health p95 87, p99 151, 0 non-200 during the storm; sign-in p50 6,198, p95 10,651. Not reproducible every run (see below). |
| 4 booking, 100 bookers on 5 slots | correctness PASS, latency FAIL | Exactly 5 bookings, one per slot, 95 `CONFLICT`. p50 811, p95 1161, p99 1198 against a 1000 ms p95 budget. |
| 5 SSE, 300 streams, 20 writers, 60 s | PASS (9/9) | Delivery p95 199, p99 493; 3,875 of 3,875 expected deliveries; 0 leaks, 0 missing. A 20 s run on a quiet system: p95 217, p99 395. |
| 6 soak, 10 min | PASS (6/6) | 24,843 requests, p50 13, p95 121, p99 422; 0 unexpected responses; container memory 1,571 to 1,404 MiB (-10.6%), flat after the first minute. |

Problems found (not caused by the harness, unless marked):

1. **Postgres backend crashes.** The compose Postgres (`invigil-postgres-1`, 17.12) logged
   `server process ... exited with exit code 2` five times between 12:41 and 13:15 (12:41:50, 12:46:48, 12:53:13,
   13:00:45, 13:14:14). Each one terminates all connections and runs crash recovery. The API then returns
   `500 INTERNAL` ("error communicating with database ... EOF") and `503 UNAVAILABLE`. The cause is not identified.
   The container has the default 64 MiB `/dev/shm` (`ShmSize` 67108864), which is the first thing to check.
2. **Rate-limit counters reset on every crash.** `rate_limits` is an `UNLOGGED` table
   (`backend/migrations/20261122000001_core.sql`). After the 13:14:14 crash it was empty. Budgets are therefore not
   durable across database crashes.
3. **Connection pool saturation.** `backend/crates/server/src/main.rs` sets `max_connections(10)`. Under the auth
   storm and provisioning bursts the log shows `pool timed out while waiting for an open connection` (363 times in
   about 25 minutes) and `realtime listener disconnected` (7 times, which stops change delivery until the listener
   reconnects with backoff). The logs also show `slow statement` warnings on `insert into audit_log` (about 100 in
   25 minutes), which means the write path is slow when the pool is busy.
4. **Auth-storm budgets were not exact in every run.** Of four storm runs, two were exact (run `0d46d99f`, a 20 s
   smoke; run `2830d062`, 50 / 60 / 0). Two were not: run `a078bd38` admitted 129 IP-phase attempts against 100
   expected and 70 account-phase against 40 (21 and 30 limited, against 50 and 60), with no errors; run `73e650cf`,
   the full suite run, had 56 responses that were neither 401 nor 429, in the window of the database trouble in item 1
   (the status codes were not recorded for that run). Direct probes of the
   same shape were exact (30 concurrent attempts from one IP, and the mixed IP-phase shape at concurrency 50). The
   cause of the inexact run `a078bd38` is not identified; its window contained no database crash, so the
   unlogged-table reset (item 2) does not explain it.
5. **Argon2 sign-in cost.** 100 concurrent correct sign-ins, all 200: p50 4.7 s, p95 5.4 s, in the debug build.
   Health stays fast during the storm, so the cost is CPU in the sign-in path, not in the server as a whole.
6. **Booking tail under contention.** The per-resource advisory lock (`docs/BOOKING.md`) serialises the 100
   attempts. Correctness holds; the p95 of 1,161 ms misses the 1,000 ms budget.
7. **Kind cluster (`api.localtest.me`) not measured.** The API pod is limited to `256Mi`
   (`deploy/k8s/base/deployment.yaml`) and was `OOMKilled` (exit 137) three times, which the ingress turned into 502s.
   The kind overlay also uses the development log sender, so codes come from the API log (`CODE_SOURCE=api-log`).
   Scenarios 1 and 3 need the memory limit raised before they can produce numbers.
8. **Other log noise seen during the runs.** `password breach check unavailable, error: error decoding response body`
   (7 times, on signup) suggests the external breach check is failing; this is not load-related and was not
   investigated.
