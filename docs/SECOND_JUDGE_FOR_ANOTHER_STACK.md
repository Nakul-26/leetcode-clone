# Second judge for another stack (deploy2 + deploy4)

**Written:** 2026-11-12. For the owner of the second copy of this stack on deploy2 (the Exam
Sandbox compose in Dokploy project `exam-portal`), to get the same setup as GO Judge: the main
stack on deploy2 and a second judge on deploy4 taking work from the same queues
(`docs/SECOND_JUDGE.md` explains how it works and why).

Both servers already run one copy of this setup (GO Judge's). Yours runs **beside** it, so the
only differences from `docs/SECOND_JUDGE.md` are a few values that must not clash with it.

## What you deploy

| Where | Dokploy compose | Compose file |
|---|---|---|
| deploy2 | your stack (already there, redeploy it) | `docker-compose.prod.yml` |
| deploy2 | new: **Judge Share** for your stack | `docker-compose.judge-share.yml` |
| deploy4 | new: **Judge Worker** for your stack | `docker-compose.judge-worker.yml` |

All from this repo, branch `main`, **at least the commit that adds this file**. That commit
labels each judge's sandboxes with its stack name (`JUDGE_INSTANCE`, set automatically from the
Dokploy compose name). Before it, a judge starting up deleted *every* judge's sandboxes on the
server, so redeploying either stack on deploy2 broke submissions running in the other one.

## 0. Before you start

- **Redeploy both stacks on deploy2 at a quiet time** (no exam running), first GO Judge, then
  yours: until both run the new code, a judge starting up can still remove the other's sandboxes.
- **Keep both stacks on the same commit.** Both build the language images under the same names
  (`judge-py-env`, `judge-cpp-env`...) on each server, so the last stack built decides which
  version every judge on that server runs.
- **Tailscale:** use your own Tailscale account (free plan is enough). Your Judge Share and your
  Judge Worker must log in to the **same** account. Using your own keeps your nodes apart from
  GO Judge's.
- Get from your stack's Dokploy Environment: `RABBITMQ_PASS`, `MONGO_ROOT_PASS`, `REDIS_PASS`,
  and `MONGO_DB_NAME` if you set it.

## 1. Redeploy your stack on deploy2

Redeploy it from `main` (see above). Nothing to set: `JUDGE_INSTANCE` defaults to the compose
name. Check the judge log: `Startup cleanup` must no longer remove GO Judge's containers.

## 2. Judge Share on deploy2

1. Find your stack's network on deploy2:
   `docker network ls | grep assessment-net`. GO Judge's is
   `examportal-go-judge-ifal7h_assessment-net`; yours is the other one (likely
   `examportal-exam-sandbox-eyazdd_assessment-net`).
2. Dokploy → your project → **Create Service → Compose**, name it e.g. `Exam Judge Share`,
   provider GitHub, this repo, branch `main`, compose path `./docker-compose.judge-share.yml`.
3. Environment:
   ```
   JUDGE_STACK_NETWORK=<your network from step 1>
   TS_PORT=41642
   TS_LAN_ENDPOINT=172.16.1.135:41642
   TS_HOSTNAME=exam-judge-share
   ```
   `TS_PORT` must not be 41641: GO Judge's Judge Share already uses that UDP port on deploy2.
   `TS_LAN_ENDPOINT` is deploy2's LAN IP with the same port; it makes the two servers talk
   directly (<1 ms) instead of through Tailscale's relay (~60 ms, which made two judges
   *slower* than one when we tried).
4. **Deploy.** Open the login link in the `tailscale` container's log
   (`docker logs <container> 2>&1 | grep login.tailscale.com`) and log in to your Tailscale
   account. In the Tailscale admin console: note its `100.x.y.z` address, and **disable key
   expiry** for it.

## 3. Judge Worker on deploy4

1. In deploy4's Dokploy: **Create Service → Compose**, e.g. `Exam Judge Worker`, this repo,
   branch `main`, compose path `./docker-compose.judge-worker.yml`.
2. Environment:
   ```
   JUDGE_SHARE_HOST=<100.x address of exam-judge-share from step 2>
   RABBITMQ_PASS=<your stack's>
   MONGO_ROOT_PASS=<your stack's>
   REDIS_PASS=<your stack's>
   TS_PORT=41642
   TS_LAN_ENDPOINT=172.16.29.30:41642
   TS_HOSTNAME=exam-judge-worker
   JUDGE_WORKER_CONCURRENCY=12
   ```
   Add `MONGO_DB_NAME` only if your stack sets it. deploy4 is shared with GO Judge's worker, so
   start with half the usual concurrency (12) and the compose's default pool sizes.
3. **Deploy.** The first build compiles all 11 language images (10-20 min). Open the login link
   in the `judge-link` container's log, log in to the **same** Tailscale account as step 2, and
   disable key expiry for `exam-judge-worker`.

## 4. Check it

- **Direct link:** on deploy4,
  `docker exec <judge-link container> tailscale ping <exam-judge-share address>` must end with
  `via 172.16.1.135:41642`, not `via DERP`.
- **Worker connected:** the `judge-service-go` log on deploy4 ends with the pool warm-up and the
  judge consuming the queues, with no connection errors.
- **Both judges work:** send a few submissions (or a load test against your own API with an API
  key); both judges' logs show submissions.
- **GO Judge untouched:** its sandboxes on both servers are still running
  (`docker ps --filter label=judge-instance=examportal-go-judge-ifal7h` on deploy2).

## Running it

- When judge code changes, redeploy your stack on deploy2, then your Judge Worker on deploy4,
  from the same commit. Until both match, either judge may take a given submission.
- To stop the second judge, stop your Judge Worker on deploy4; deploy2 carries on alone.
- deploy4's CPU is shared by both workers. Under load at the same time, each gets less than in
  the single-stack numbers in `docs/SECOND_JUDGE.md` (+27% Python, +13% C++).
- Security: your RabbitMQ, Mongo and Redis are reachable only on your tailnet, and still need
  their passwords. deploy4 holds your stack's passwords and runs your users' code, like it does
  for GO Judge. `docs/SECOND_JUDGE.md` → Security shows how to let only the worker reach the share.
