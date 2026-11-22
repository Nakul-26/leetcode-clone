# Production and testing stacks

**Written:** 2026-11-22. **Status:** set up and verified 2026-11-22 (testing load test: Python 3,731/min, C++ 1,128/min at 40 concurrent, 0 errors, split 52/48). Two complete copies of the platform run on the same two servers, from the
same code, without touching each other:

| | Production | Testing |
|---|---|---|
| Who uses it | Real exams (the exam portal) | Trying changes, load tests |
| deploy2: stack | **Exam Sandbox** (`examportal-exam-sandbox-eyazdd`), site `examjudge.fortifyhub.net` | **Test GO Judge** (`examportal-go-judge-ifal7h`), sites `assess.fortifyhub.net`, `coding2.fortifyhub.net` |
| deploy2: share for the second judge | **Exam Judge Share** (`examportal-exam-judge-share-grzcft`), Tailscale `exam-judge-share`, UDP 41642 | **Test Judge Share** (`examportal-judge-share-6pogpk`), Tailscale `test-judge-share` (100.118.238.10), UDP 41641 |
| deploy4: second judge | **Judge Worker** (`judge-judge-worker-9v8lfl`), Tailscale `judge-worker`, UDP 41641 | **test-judge-worker** (`test-judge-worker-test-judge-worker-5peykz`), Tailscale `test-judge-worker`, UDP 41642 |
| Branch | `production` | `main` |
| Deploys | By hand, after testing | On every push to `main` (deploy4 autodeploys; click Deploy on deploy2) |

## What keeps them apart

| Shared thing | How it is kept apart |
|---|---|
| Data | Each stack has its own Mongo, Redis and RabbitMQ (separate Compose projects and volumes). Each second judge reaches only its own stack's, through its own share |
| Sandboxes on the same Docker | Each judge labels its sandboxes `judge-instance=<compose name>` and removes only its own (since 2026-11-12) |
| Language images on the same Docker | Each stack builds and runs `judge-<lang>-env:<compose name>` (`JUDGE_IMAGE_TAG`, since 2026-11-22). Before, both built `judge-<lang>-env:latest`, so deploying testing replaced the images production runs |
| Code | Production deploys from the `production` branch, testing from `main`. A push to `main` never reaches production |
| Tailscale | One node per share and per worker, each on its own UDP port per server |
| CPU | **Not** separated: both stacks' judges use the same cores. Don't load test the testing stack during an exam |

## Moving a change to production

1. Push to `main`. test-judge-worker on deploy4 deploys itself; click **Deploy** on Test GO Judge on deploy2.
2. Test on `assess.fortifyhub.net`: `npm run loadtest -- smoke`, then whatever the change needs.
3. When it is good, and no exam is running:
   ```bash
   git push origin main:production
   ```
4. Redeploy production: **Exam Sandbox** on deploy2, then **Judge Worker** on deploy4. Redeploy **Exam
   Judge Share** only if `docker-compose.judge-share.yml` changed.

To roll production back, point `production` at the previous good commit
(`git push --force-with-lease origin <commit>:production`) and redeploy the same way.

## One-time setup

Steps 1-2 must come **before** the next push to `main`: the deploy4 Judge Worker currently
autodeploys `main`, so anything pushed there reaches production.

### 1. Create the `production` branch

From the commit production should run (today: `06cfa34`, the commit the deploy4 worker runs):

```bash
git push origin 06cfa34:refs/heads/production
```

### 2. Point production at it

In Dokploy, for each production service: **General → Branch** `production`, save.

- deploy4 → project `judge` → **Judge Worker**. Rename it **Production Judge Worker** while you are there
  (optional; the compose name, and so its labels and image tag, stays the same).
- deploy2 → `exam-portal` → **Exam Sandbox** and **Exam Judge Share** (your friend's services: ask him,
  or do it together).

Don't redeploy them now; they keep running what they run.

### 3. Push the code to `main`

`git push origin main`. Production does not move. The Testing Judge Worker doesn't exist yet.

### 4. Testing on deploy2

1. **Judge Share** (stopped since 2026-11-21): **Deploy**. Its Tailscale login was kept, so it comes back as
   `judge-share` (100.118.238.10) with no login. Check: `docker ps | grep examportal-judge-share`.
2. **GO Judge**: **Deploy**. The first deploy builds its own copy of the 11 language images (10-20 min).

### 5. Testing on deploy4

Dokploy on deploy4 → project `judge` → **Create Service → Compose**, name **Testing Judge Worker**, this
repo, branch `main`, compose path `./docker-compose.judge-worker.yml`, autodeploy on. Environment:

```
JUDGE_SHARE_HOST=100.118.238.10
RABBITMQ_PASS=<GO Judge's>
MONGO_ROOT_PASS=<GO Judge's>
REDIS_PASS=<GO Judge's>
TS_HOSTNAME=test-judge-worker
TS_PORT=41642
TS_LAN_ENDPOINT=172.16.29.30:41642
JUDGE_WORKER_CONCURRENCY=12
```

Copy the three passwords from deploy2 → GO Judge → Environment (and `MONGO_DB_NAME` if GO Judge sets one).
**Deploy**: it builds its own image copy (10-20 min). Then open the login link in its `judge-link`
container's log (`docker logs <container> 2>&1 | grep login.tailscale.com`), log in with the same Tailscale
account as `judge-share`, and disable key expiry for `test-judge-worker` in the admin console.

### 6. Check

- On deploy4: `docker exec <testing judge-link container> tailscale ping 100.118.238.10` ends with
  `via 172.16.1.135:41641`, not `via DERP`.
- GO Judge's RabbitMQ shows 2 consumers per queue, and so does Exam Sandbox's:
  `docker exec <rabbitmq container> rabbitmqctl list_queues name consumers`.
- Each server runs two sets of sandboxes, one per stack:
  `docker ps --filter label=managed-by=judge-service --format '{{.Label "judge-instance"}}' | sort | uniq -c`.
- `npm run loadtest -- smoke` against `assess.fortifyhub.net` passes; both testing judges' logs show work.

### 7. Production picks up the image tags at its next deploy

Until production is redeployed from a `production` branch that includes the image-tag change, it keeps
running the untagged (`latest`) images. Nothing else builds those any more, so testing can't change them.
After that redeploy, remove the old untagged images on both servers to free ~10 GB each:
`docker image rm $(docker images --format '{{.Repository}}:{{.Tag}}' | grep -E '^judge-[a-z]+-env:latest$')`
(Docker refuses while a container still uses one.)
