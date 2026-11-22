# Security brainstorm: this platform

> **Archived.** An early AI-chat checklist of vulnerability classes, kept for reference. The findings that
> mattered, and their fixes, are in `docs/plans/PLATFORM_AUDIT_AND_SAAS_ROADMAP.md` and
> `docs/judge/JUDGE_FIX_PLAN.md` (S1-S3).

Absolutely, bro. For **your coding assessment platform**, the threat model is quite different from a normal CRUD website because you're accepting **untrusted source code and executing it**. That makes the judge/container layer one of the highest-risk components.

Based on your architecture — **React → Node/Express API → RabbitMQ → Go judge → Docker containers → MongoDB/Redis**, plus the Arventiq integration — I'd audit it across these areas:

## 🔥 1. Arbitrary Code Execution Escaping the Judge

This is the **#1 vulnerability**.

A student submits:

```python
# malicious submission
```

Your system executes it inside Docker.

The critical question is:

> Can submitted code escape the container and execute commands on the host?

Potential attack surfaces:

* Docker socket
* Container privileges
* `/var/run/docker.sock`
* Host filesystem mounts
* `--privileged`
* Dangerous Linux capabilities
* `host` networking
* Weak seccomp/AppArmor configuration
* Running as root
* Kernel/container escape vulnerabilities

### Especially important for your current setup

You previously identified that your `judge-service-go` had access to the **raw Docker socket**.

That is a major concern.

If an attacker can influence something that has unrestricted Docker API access, compromising the judge service can potentially become a **host-level compromise**.

Your move toward a scoped `docker-socket-proxy` is therefore very important.

---

# 🔥 2. Container Resource Exhaustion

A student can submit:

```c
while (1) {}
```

or something that consumes enormous memory.

Possible attacks:

```text
CPU exhaustion
RAM exhaustion
Process exhaustion
Disk exhaustion
Fork bombs
Huge output
Infinite loops
Huge compilation
Many threads
```

For example:

```c
int main() {
    while (1) {
        malloc(1024 * 1024);
    }
}
```

You need limits for:

* CPU
* Memory
* Execution time
* PIDs/processes
* Output size
* Input size
* File size
* Compilation time
* Number of concurrent executions

This is particularly important because your judge already has a configurable execution pool and concurrency limits.

---

# 🔥 3. Fork Bomb

A submission can attempt:

```c
while (1) {
    fork();
}
```

Without PID limits, this can potentially exhaust resources.

Use container-level process limits such as:

```text
--pids-limit
```

and enforce execution timeouts.

---

# 🔥 4. Network Access From Submitted Code

This is a **huge one**.

Imagine a student submits:

```python
import requests

requests.get("https://example.com")
```

Do you actually want arbitrary student code to access the Internet?

Usually:

**No.**

Otherwise they could potentially:

* Scan external systems
* Abuse APIs
* Download malware
* Attack websites
* Access cloud metadata services
* Exfiltrate information
* Use your infrastructure as a proxy

Ideally:

```text
Student Code
     │
     ▼
Docker Container
     │
     X
   Internet
```

The judge should normally have **no outbound network access** unless a problem explicitly requires it.

---

# 🔥 5. Cloud Metadata / SSRF Through Judge

This becomes particularly dangerous if your judge runs in AWS/Oracle/etc.

A malicious submission could try accessing cloud metadata endpoints.

Conceptually:

```text
Student Code
     ↓
HTTP request
     ↓
Cloud metadata service
     ↓
Temporary credentials
```

If the environment is misconfigured, this can potentially expose cloud credentials.

So the judge containers should have:

* No unnecessary network
* No cloud credentials
* No access to metadata services

---

# 🔥 6. Docker Socket Exposure

This deserves its own category.

If the judge container has:

```text
/var/run/docker.sock
```

mounted directly, you've effectively given that service powerful control over Docker.

If an attacker compromises the judge service itself, they may be able to abuse that Docker API.

Better architecture:

```text
                 ┌─────────────────┐
                 │ Assessment API  │
                 └────────┬────────┘
                          │
                       RabbitMQ
                          │
                          ▼
                 ┌─────────────────┐
                 │   Go Judge      │
                 └────────┬────────┘
                          │
                    restricted API
                          │
                          ▼
                 Docker Socket Proxy
                          │
                    allow-listed API
                          │
                          ▼
                     Containers
```

And only expose the Docker operations the judge actually needs.

---

# 🔥 7. Authentication Bypass

Your APIs need to be checked for:

```text
POST /login
POST /register
POST /refresh
POST /logout
```

Potential problems:

* JWT not validated correctly
* Expired JWT accepted
* Wrong issuer/audience accepted
* Algorithm confusion
* Refresh tokens reusable forever
* Session not invalidated
* Password reset bypass
* Weak reset tokens
* Brute-force login

---

# 🔥 8. Student → Admin Privilege Escalation

This is extremely important.

Imagine:

```http
PATCH /api/users/123
```

and a student sends:

```json
{
  "role": "admin"
}
```

If the backend blindly updates fields → **game over**.

Never trust frontend role restrictions.

The backend must enforce:

```text
student
   ↓
only student permissions

teacher
   ↓
teacher permissions

admin
   ↓
admin permissions
```

This ties directly into the permission-first RBAC work you've already been doing on your ERP.

---

# 🔥 9. IDOR on Assessments

Suppose:

```http
GET /api/assessments/100
```

A student is supposed to access assessment 100.

They change it:

```http
GET /api/assessments/101
```

and suddenly see another college's assessment.

That's **Broken Object Level Authorization / IDOR**.

Check:

```text
assessmentId
problemId
submissionId
studentId
collegeId
organizationId
testId
resultId
```

Every object access needs authorization.

---

# 🔥 10. Cross-Tenant Data Leakage

For your platform, this is probably one of the **most important application-level issues**.

Imagine:

```text
College A
 ├── Students
 ├── Assessments
 └── Results

College B
 ├── Students
 ├── Assessments
 └── Results
```

A College A user must **never** be able to query College B data.

Dangerous query:

```js
Submission.find({
    studentId
});
```

Safer concept:

```js
Submission.find({
    studentId,
    collegeId: authenticatedUser.collegeId
});
```

You need tenant isolation across **every relevant collection/table and every endpoint**.

---

# 🔥 11. Submission Tampering

A student shouldn't be able to modify:

```json
{
  "verdict": "Accepted"
}
```

or:

```json
{
  "score": 100
}
```

The client should never be trusted for:

```text
score
verdict
executionTime
memory
testCaseResults
passed
rank
attemptNumber
```

These should be generated server-side.

---

# 🔥 12. Result Tampering

Similar problem.

Imagine:

```http
PATCH /api/submissions/abc
```

with:

```json
{
  "status": "accepted"
}
```

The backend must prevent students from modifying judging results.

---

# 🔥 13. Submission Replay / Duplicate Submission Abuse

A student could potentially spam:

```text
POST /submissions
POST /submissions
POST /submissions
POST /submissions
...
```

This can:

* Fill RabbitMQ
* Consume judge capacity
* Increase database load
* Affect other students

You need:

```text
Rate limiting
Submission quotas
Assessment attempt rules
Queue protection
Per-user concurrency limits
```

---

# 🔥 14. RabbitMQ Abuse

Your architecture introduces another attack surface.

If an attacker can publish arbitrary messages into the judging queue:

```text
submit → RabbitMQ → judge
```

they could potentially:

* Create fake jobs
* Flood the queue
* Manipulate job payloads
* Cause invalid jobs
* Exhaust workers

RabbitMQ should not be exposed publicly.

And consumers should validate every message.

---

# 🔥 15. Malicious Problem/Test Case

Don't only trust student submissions.

If admins/teachers can create problems, test cases themselves become untrusted input.

For example:

```text
Huge input
Huge expected output
Malformed test case
Path traversal payload
Extremely expensive test
```

Your judge needs limits on test-case size and processing.

---

# 🔥 16. Compiler Abuse

Compilation itself can be attacked.

A submission can attempt to cause:

```text
Huge compilation time
Huge generated binaries
Huge compiler memory usage
Compiler crash
Massive compiler output
```

Therefore:

```text
Compile timeout
Compile memory limit
Compile output limit
Binary size limit
```

are important.

---

# 🔥 17. Output Flooding

Consider:

```c
while (1) {
    printf("AAAAAAAAAAAAAAAAAAAAAAAA\n");
}
```

Even if execution is eventually killed, the process could generate enormous output.

You need an output cap:

```text
MAX_OUTPUT_BYTES
```

Once exceeded:

```text
Output Limit Exceeded
```

and terminate the process.

---

# 🔥 18. Filesystem Abuse

A submission might try:

```python
open("/etc/passwd")
```

or write massive amounts of data:

```text
/tmp/
```

You should use:

* Isolated filesystem
* Read-only root filesystem where possible
* Temporary working directory
* Disk quotas
* No sensitive host mounts
* No unnecessary files

---

# 🔥 19. Secrets Available to Submitted Code

Never allow the container environment to contain:

```text
JWT_SECRET
MONGO_PASSWORD
RABBITMQ_PASSWORD
AWS_ACCESS_KEY
API_KEYS
ARVENTIQ_SECRET
```

A submission should receive essentially only what it needs to execute.

For example:

```text
PATH
HOME
language-specific environment
```

rather than your application's environment.

---

# 🔥 20. Language-Specific Sandbox Escapes

You support multiple languages, so each runtime has its own attack surface.

For example:

```text
Python
JavaScript
C
C++
Go
...
```

Don't assume:

> "We blocked Python's dangerous functions, so Python is safe."

That's not sufficient.

The **container must be the security boundary**, not language-level filtering.

---

# 🔥 21. Path Traversal in Submission Files

If your system creates:

```text
/submissions/{submissionId}/main.cpp
```

don't blindly concatenate user-controlled filenames.

Dangerous concept:

```text
../../something
```

Always sanitize and constrain paths.

---

# 🔥 22. Malicious Filenames

A submission/problem might contain weird filenames such as:

```text
../../foo
```

or shell metacharacters.

Never construct shell commands using raw user-controlled filenames.

---

# 🔥 23. Command Injection in the Judge

Be extremely careful with things like:

```go
exec.Command(...)
```

or shell execution.

Avoid:

```text
sh -c "compile " + userInput
```

Use argument arrays and strict validation.

---

# 🔥 24. API Parameter Pollution / Validation Problems

Someone sends:

```json
{
  "language": ["cpp", "python"]
}
```

when you expect:

```json
{
  "language": "cpp"
}
```

or:

```json
{
  "problemId": null
}
```

or enormous JSON bodies.

Every endpoint should have strict schema validation.

---

# 🔥 25. Assessment Answer Leakage

This is specific to your platform.

Suppose the frontend requests:

```http
GET /api/problems/123
```

and the response accidentally contains:

```json
{
  "testCases": [...],
  "expectedOutputs": [...]
}
```

A student can inspect DevTools and obtain the answers.

The API should return only what the student needs.

---

# 🔥 26. Hidden Test Case Leakage

Even more important:

```text
Visible test cases
        ↓
Student sees them

Hidden test cases
        ↓
ONLY judge sees them
```

Hidden tests should never reach:

```text
React
Browser
localStorage
IndexedDB
API response
HTML
JavaScript bundle
```

---

# 🔥 27. Assessment Time Manipulation

If the frontend says:

```json
{
  "remainingTime": 3600
}
```

don't trust it.

A student can modify it to:

```json
{
  "remainingTime": 99999999
}
```

The server should determine assessment timing.

---

# 🔥 28. Attempt Limit Bypass

If an assessment allows:

```text
3 attempts
```

don't rely on:

```js
if (frontendAttempts < 3)
```

The backend/database must enforce it.

Race conditions need consideration too.

---

# 🔥 29. Race Conditions in Submissions

Two simultaneous requests:

```text
Attempt 3
Attempt 3
```

could both pass an:

```text
attempts < 3
```

check if the operation isn't atomic.

Same applies to:

```text
exam submission
score updates
attempt creation
rank calculation
credits
```

---

# 🔥 30. Webhook / Integration Abuse

Your Arventiq integration adds another security boundary.

You have endpoints like:

```text
/api/arventiq/problems
/api/arventiq/submissions
/api/arventiq/submissions/:id
```

The shared secret must be:

* Strong
* Server-side only
* Never exposed to React
* Rotatable
* Validated consistently

And ideally the integration API should have strict schemas and authorization.

Your `externalId`, `externalStudentId`, and `externalAssessmentId` also need to be treated as **untrusted identifiers**, not authorization credentials.

---

# 🔥 31. WebSocket/SSE Security

If you use real-time judging:

```text
Submission → Accepted
```

make sure users cannot subscribe to:

```text
another student's submission
```

For example:

```text
/ws/submission/123
```

must verify that the authenticated user is allowed to see submission `123`.

---

# 🔥 32. Information Leakage Through Errors

Don't return:

```text
MongoDB connection failed:
mongodb://admin:password@...
```

or:

```text
/var/lib/docker/containers/...
```

or full stack traces.

Production responses should be something like:

```json
{
  "error": "Internal server error"
}
```

while detailed information goes into controlled server logs.

---

# 🔥 33. Database Injection / Query Abuse

Your MongoDB endpoints need protection against:

```text
$ne
$gt
$regex
$where
```

and expensive regex/query patterns.

Also ensure users cannot inject arbitrary MongoDB operators through request bodies.

---

# 🔥 34. Redis Abuse

If Redis is used for:

```text
sessions
caching
queues
rate limits
temporary results
```

don't expose Redis publicly.

And don't allow users to control arbitrary Redis keys/commands.

---

# 🔥 35. Database Credential Exposure

MongoDB should not be:

```text
Internet → MongoDB
```

It should be more like:

```text
Internet
   │
   ▼
API
   │
   ▼
Private MongoDB
```

Same principle for Redis and RabbitMQ.

---

# 🔥 36. Admin Panel Vulnerabilities

Your admin/teacher panel needs special attention:

```text
Create assessment
Delete assessment
View results
Export results
Create problems
View submissions
Manage users
Change roles
```

Every sensitive action needs backend authorization.

Not:

```text
if (user.role === "admin")
    show button
```

but:

```text
request
  ↓
authentication
  ↓
authorization
  ↓
resource ownership/tenant check
  ↓
operation
```

---

# 🔥 37. Result Export/Data Exfiltration

An admin/teacher might have an endpoint like:

```http
GET /api/results/export
```

Check whether:

```text
teacher A
```

can export:

```text
College B's entire student database
```

Export endpoints are often forgotten during authorization audits.

---

# 🔥 38. CSV Injection

If you export student/problem/result data to CSV and fields can contain formulas:

```text
=HYPERLINK(...)
```

opening the CSV in spreadsheet software can create security issues.

Sanitize exported spreadsheet values.

---

# 🔥 39. XSS Through Problem Statements

Teachers/admins may create:

```text
Problem title
Problem description
Constraints
Examples
Explanation
```

If HTML/Markdown is supported, stored XSS becomes possible.

For example:

```html
<script>...</script>
```

Your renderer needs proper sanitization.

---

# 🔥 40. Account Enumeration

Endpoints like:

```text
/api/check-email
/api/check-username
/api/forgot-password
```

can accidentally reveal:

```text
"User exists"
"User doesn't exist"
```

Attackers can use this to enumerate accounts.

---

# 🚨 Your platform's highest-priority security areas

If I were doing a security audit of **your actual platform**, I'd prioritize it like this:

| Priority | Area                             | Risk        |
| -------- | -------------------------------- | ----------- |
| 🔴 P0    | Docker/container escape          | Critical    |
| 🔴 P0    | Docker socket exposure           | Critical    |
| 🔴 P0    | Arbitrary code execution sandbox | Critical    |
| 🔴 P0    | Network access from submissions  | Critical    |
| 🔴 P0    | Host/cloud credential exposure   | Critical    |
| 🔴 P0    | Cross-tenant authorization       | Critical    |
| 🔴 P0    | Admin privilege escalation       | Critical    |
| 🔴 P0    | Hidden test-case leakage         | Critical    |
| 🔴 P1    | CPU/RAM/PID/disk exhaustion      | High        |
| 🔴 P1    | Submission flooding              | High        |
| 🔴 P1    | API IDOR                         | High        |
| 🔴 P1    | Result/score manipulation        | High        |
| 🔴 P1    | Assessment-time manipulation     | High        |
| 🔴 P1    | Attempt-limit bypass             | High        |
| 🔴 P1    | RabbitMQ abuse                   | High        |
| 🟠 P1    | SSRF/cloud metadata              | High        |
| 🟠 P1    | Command injection                | High        |
| 🟠 P1    | Mongo/NoSQL injection            | High        |
| 🟠 P1    | XSS                              | High        |
| 🟠 P2    | CSRF/CORS                        | Medium–High |
| 🟠 P2    | File/path traversal              | Medium–High |
| 🟠 P2    | Dependency vulnerabilities       | Medium–High |
| 🟡 P2    | Information leakage              | Medium      |
| 🟡 P2    | CSV injection                    | Medium      |
| 🟡 P2    | Account enumeration              | Medium      |

### The key architecture principle

For your judge, I'd make the security boundary look roughly like:

```text
                     INTERNET
                        │
                 ┌──────▼──────┐
                 │ API Gateway │
                 └──────┬──────┘
                        │
                 Auth + RBAC
                 Rate limiting
                 Validation
                        │
              ┌─────────▼─────────┐
              │ Assessment API    │
              └─────────┬─────────┘
                        │
                    RabbitMQ
                        │
                        ▼
              ┌───────────────────┐
              │     Go Judge      │
              │                   │
              │ NON-ROOT          │
              │ NO SECRETS        │
              │ NO INTERNET       │
              │ RESOURCE LIMITS   │
              └─────────┬─────────┘
                        │
                Restricted Docker
                    interface
                        │
                        ▼
              ┌───────────────────┐
              │ Disposable        │
              │ Execution         │
              │ Container         │
              │                   │
              │ CPU limit         │
              │ RAM limit         │
              │ PID limit         │
              │ Time limit        │
              │ Disk limit        │
              │ Network OFF       │
              │ Read-only FS      │
              └───────────────────┘
```

**The biggest mindset shift:** your React frontend is not your security boundary, and your API authentication is not your judge security boundary. **Untrusted student code must be treated as potentially hostile code trying to compromise the machine running your judge.**

Given the platform you're building, I'd actually recommend doing a **full security audit checklist against your current codebase**, covering the Node API, Go judge, Docker Compose, RabbitMQ, MongoDB/Redis, Arventiq integration, and frontend. That would be much more useful than a generic OWASP checklist because we can identify the actual vulnerabilities in your implementation.
