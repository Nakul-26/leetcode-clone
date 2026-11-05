# Second judge server (JUDGE_FIX_PLAN M2)

**Written:** 2026-11-05. **Status:** files ready, not deployed yet.

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
 │ Judge Share stack: tailscale "judge-share" + 3 relays │◄──┤   (host Tailscale)           │
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

### 1. Tailscale (once)

1. Create a free account at tailscale.com (any login).
2. **Server 2:** install Tailscale on the host and log in:
   `curl -fsSL https://tailscale.com/install.sh | sh` then `sudo tailscale up`.
   Open the link it prints and approve the machine. In the admin console, open the machine's
   menu and choose **Disable key expiry**, so the server doesn't drop off after 180 days.
3. **Auth key for deploy2:** admin console → Settings → Keys → **Generate auth key**
   (one-off is fine). Copy it; it's used once in step 2 below.

### 2. deploy2: Judge Share

1. Dokploy → exam-portal → **Create Service → Compose**, name it `Judge Share`.
2. Provider: GitHub, repository `leetcode-clone`, branch `main`, compose path
   `./docker-compose.judge-share.yml`.
3. Environment: `TS_AUTHKEY=<the key from 1.3>`.
4. **Deploy.** In the Tailscale admin console a machine `judge-share` appears. Disable its key
   expiry too, and copy its **100.x address**.

### 3. Check the link from server 2

```
nc -zv <judge-share 100.x address> 5672
nc -zv <judge-share 100.x address> 27017
nc -zv <judge-share 100.x address> 6379
```
All three must say `succeeded`/`open`.

### 4. Server 2: Judge Worker

1. In server 2's Dokploy: create a project (for example `judge`), then **Create Service →
   Compose**, name it `Judge Worker`. Same repository and branch, compose path
   `./docker-compose.judge-worker.yml`.
2. Environment:
   ```
   JUDGE_SHARE_HOST=<judge-share 100.x address>
   RABBITMQ_PASS=<same as GO Judge on deploy2>
   MONGO_ROOT_PASS=<same as GO Judge on deploy2>
   REDIS_PASS=<same as GO Judge on deploy2>
   JUDGE_WORKER_CONCURRENCY=<about 4 x this server's CPU cores>
   ```
   Copy the three passwords from deploy2 → GO Judge → Environment. Add `MONGO_DB_NAME` only if
   GO Judge sets it. Other `JUDGE_*` settings are optional, as on deploy2.
3. **Deploy.** The first build compiles all 11 language images and takes a while (10-20 min).
4. Logs of `judge-service-go` should end with the pool warm-up and the judge consuming the queues,
   with no connection errors.

### 5. Check that both judges work

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
  reachable as the second rule allows. Repeat the `nc` checks in step 3 afterwards.

## Running it

- **Deploy both judges from the same commit.** When judge code changes, deploy GO Judge on
  deploy2 and then Judge Worker on server 2. Until both are on the same version, either may
  take a given submission.
- **To stop the second judge**, stop Judge Worker on server 2. Work carries on on deploy2. The
  Judge Share stack can stay.
- Size each server's pool for its own CPU (see `docs/JUDGE_PERFORMANCE_REVIEW.md`). The pool
  limits are per judge, not shared.
- The System page's judge statistics come from deploy2's judge only.
