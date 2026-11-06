# Second judge server (JUDGE_FIX_PLAN M2)

**Written:** 2026-11-05. **Status:** live since 2026-11-06 (Judge Worker on deploy4 / `ssh college-server2`).

## How it works

The judge keeps no state of its own. It takes submissions and Runs from RabbitMQ, reads problems
from Mongo, writes results to Mongo and announces them on Redis. Since M1 (2026-10-31) Run goes
through RabbitMQ too. So a second judge that connects to the **same** RabbitMQ, Mongo and Redis
shares all the work, with no change to the API: whichever judge is free takes the next message.

```
                     deploy2 (server 1)                                server 2
 ┌──────────────────────────────────────────────────────┐   ┌──────────────────────────────┐
 │ GO Judge stack: api, frontend, judge, rabbitmq,      │   │ Judge Worker stack:          │
 │                 mongo, redis                          │   │   judge + Docker guard +     │
 │        ▲  (stack network, go-judge-* aliases)         │   │   language images            │
 │ Judge Share stack: tailscale "judge-share" + 3 relays │◄──┤   + tailscale "judge-worker" │
 └──────────────────────────────────────────────────────┘   └──────────────────────────────┘
                       private Tailscale link (WireGuard, encrypted)
```

- `docker-compose.judge-share.yml` (deploy2): a Tailscale container joins your tailnet as
  `judge-share`, and three relays listen inside it and forward to `go-judge-rabbitmq:5672`,
  `go-judge-mongo:27017` and `go-judge-redis:6379`. **No host port is published**: these services
  are reachable from your tailnet only, never from the internet. It is a separate stack because
  `docker-compose.prod.yml` is also deployed by the Exam Sandbox on the same server.
- `docker-compose.judge-worker.yml` (server 2): the judge, its Docker guard and the 11 language
  images, configured like the main judge but pointing at `judge-share`.

If the link drops, the second judge exits and restarts until it can reconnect; anything it had
taken but not finished goes back to the queue and is judged again (R1-R6), by either judge.

## Setup

Tailscale runs in a container on **both** servers (`judge-share` on deploy2, `judge-worker` on
server 2), so nothing is installed on the hosts and no sudo is needed. Server 1 is
`ssh college-server` (Dokploy deploy2.fortifyhub.net), server 2 is `ssh college-server2`.

### 1. deploy2: Judge Share

1. Dokploy → exam-portal → **Create Service → Compose**, name it `Judge Share`, repository
   `leetcode-clone`, branch `main`, compose path `./docker-compose.judge-share.yml`. Environment:
   `TS_LAN_ENDPOINT=172.16.1.135:41641` (this host's LAN IP; `TS_AUTHKEY` is optional).
2. **Deploy.** Then open the login link printed in the tailscale container's log:
   `docker logs examportal-judge-share-*-tailscale-1 2>&1 | grep -o 'https://login.tailscale.com/[^ ]*'`.
   The container waits for the login as long as needed and remembers it.
   Signing in there adds the node `judge-share` to your tailnet (the first login creates the
   account). In the admin console, open its menu → **Disable key expiry**, and note its
   **100.x address**.

### 2. Server 2: Judge Worker

1. In server 2's Dokploy: project `judge` → **Create Service → Compose**, name `Judge Worker`,
   same repository and branch, compose path `./docker-compose.judge-worker.yml`.
2. Environment:
   ```
   JUDGE_SHARE_HOST=<judge-share 100.x address>
   RABBITMQ_PASS=<same as GO Judge on deploy2>
   MONGO_ROOT_PASS=<same as GO Judge on deploy2>
   REDIS_PASS=<same as GO Judge on deploy2>
   JUDGE_WORKER_CONCURRENCY=<about 4 x this server's CPU cores>
   TS_LAN_ENDPOINT=<this host's LAN IP>:41641
   ```
   `TS_LAN_ENDPOINT` matters: Tailscale inside a container can't see the host's LAN address,
   and without it two servers on the same network go through Tailscale's relay (~57 ms a trip
   here, which made the load test *slower* with two judges). With it: direct, <1 ms.
   Check with `docker exec <judge-link container> tailscale ping <judge-share address>`: it must
   say `via <LAN IP>:41641`, not `via DERP`.
   Copy the three passwords from deploy2 → GO Judge → Environment. Add `MONGO_DB_NAME` only if
   GO Judge sets it.
3. **Deploy.** The first build compiles all 11 language images (10-20 min). Open the login link in
   the `judge-link` container's log the same way, and disable key expiry for `judge-worker`.

### 3. Check the link

From server 2: `docker exec <judge-link container> sh -c 'nc -zv judge-share-address 5672'`, or
simply read the `judge-service-go` log: it should end with the pool warm-up and the judge
consuming the queues, with no connection errors.

### 4. Check that both judges work

- Run the load test from this repo: `npm run loadtest -- quick`. With two judges, throughput at
  10 at a time should rise compared with the 2026-11-05 numbers (Python 1,242/min, C++ 600/min).
- Both judges' logs show submissions during the test.

## Security

- RabbitMQ, Mongo and Redis are only reachable on the tailnet, and still need their passwords.
- Optional, tighter: let only server 2 reach `judge-share` (by default every device on your
  tailnet can). Tag the two machines (admin console → machine menu → **Edit ACL tags**:
  `tag:judge-share` on judge-share, `tag:judge-worker` on server 2), then in Access controls
  replace the default allow-all rule with:
  ```json
  "tagOwners": { "tag:judge-share": ["autogroup:admin"], "tag:judge-worker": ["autogroup:admin"] },
  "acls": [
    { "action": "accept", "src": ["autogroup:member"], "dst": ["autogroup:member:*"] },
    { "action": "accept", "src": ["tag:judge-worker"], "dst": ["tag:judge-share:5672,27017,6379"] }
  ]
  ```
  The first rule keeps your own (untagged) devices reaching each other; tagged machines are only
  reachable as the second rule allows. Check the judge log on server 2 afterwards.

## Running it

- **Deploy both judges from the same commit.** When judge code changes, deploy GO Judge on
  deploy2 and then Judge Worker on server 2. Until both are on the same version, either may
  take a given submission.
- **To stop the second judge**, stop Judge Worker on server 2. Work carries on on deploy2. The
  Judge Share stack can stay.
- Size each server's pool for its own CPU (see `docs/JUDGE_PERFORMANCE_REVIEW.md`). The pool
  limits are per judge, not shared.
- The System page's judge statistics come from deploy2's judge only.

## Results (2026-11-06)

`npm run loadtest -- full --langs=python,cpp --levels=40,80 --seconds=30`, compared with the
single judge on 2026-11-05:

| | single judge peak | two judges, x40 | two judges, x80 |
|---|---|---|---|
| Python | ~1,690/min | 2,003/min | 2,149/min (+27%) |
| C++ | ~660/min | 698/min | 744/min (+13%) |

No errors. At 10 concurrent, each judge took exactly half; at 40-80 the split was uneven
(deploy4 903, deploy2 2,474), so something other than judge CPU now limits throughput (the
API, Mongo or RabbitMQ on deploy2, or the extra round trips from deploy4). Find that before
adding a third judge.
