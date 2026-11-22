# Security brainstorm: websites in general

> **Archived.** An early AI-chat checklist of vulnerability classes, kept for reference. The findings that
> mattered, and their fixes, are in `docs/plans/PLATFORM_AUDIT_AND_SAAS_ROADMAP.md` and
> `docs/judge/JUDGE_FIX_PLAN.md` (S1-S3).

Bro, a website can have **a huge number of security vulnerabilities**, but most fall into a few major categories. If you're building full-stack applications, I'd learn these in roughly this order.

### 🔴 1. Broken Authentication

Problems with login/session handling.

Examples:

* Weak passwords allowed
* Brute-force login attacks
* No rate limiting
* Passwords stored in plaintext
* Predictable session IDs
* JWTs accepted without proper validation
* Session not invalidated after logout/password change
* Account takeover through password reset flaws

**Example:**
If `/api/reset-password?userId=123` lets you reset any user's password without verifying ownership → account takeover.

---

### 🔴 2. Broken Authorization / IDOR

One of the **most common problems in APIs**.

The server checks that you're logged in, but doesn't check whether you're allowed to access the specific resource.

```http
GET /api/students/123
```

If student `123` belongs to College A and a user from College B can simply change:

```http
GET /api/students/124
```

and see their data → **IDOR / Broken Access Control**.

This is especially important for your ERP and assessment platforms because of **tenant isolation**.

---

### 🔴 3. SQL Injection

User input gets directly incorporated into a SQL query.

Bad:

```js
const query = `SELECT * FROM users WHERE email = '${email}'`;
```

An attacker can manipulate the query.

Use parameterized queries/prepared statements instead.

---

### 🔴 4. NoSQL Injection

Same concept, but against MongoDB and similar databases.

For example, accepting an object where a string was expected can sometimes allow query operators such as:

```json
{
  "email": {
    "$ne": null
  }
}
```

This is particularly relevant to MERN applications.

---

### 🔴 5. Cross-Site Scripting (XSS)

Attacker-controlled JavaScript gets executed in another user's browser.

Example:

```html
<script>alert(document.cookie)</script>
```

Common forms:

* **Stored XSS** — malicious content saved in the database
* **Reflected XSS** — malicious input reflected in a response
* **DOM XSS** — frontend JavaScript creates the vulnerability

For example, blindly rendering user-provided HTML with `dangerouslySetInnerHTML` can be dangerous.

---

### 🔴 6. CSRF

An attacker tricks an authenticated user's browser into making an unwanted request.

For example, a logged-in admin could unknowingly send:

```http
POST /api/users/delete
```

while visiting an attacker's page.

Important defenses include:

* SameSite cookies
* CSRF tokens where applicable
* Checking request origin
* Proper authentication architecture

---

### 🔴 7. SSRF

**Server-Side Request Forgery.**

Your server fetches a URL supplied by the user:

```http
POST /api/fetch
{
  "url": "https://example.com"
}
```

If insufficiently restricted, an attacker may make your server request internal resources that aren't publicly accessible.

This becomes particularly serious in cloud environments.

---

### 🔴 8. File Upload Vulnerabilities

Uploading files can be dangerous.

Problems include:

* Executable files being uploaded
* Malicious HTML/SVG
* Path traversal through filenames
* Huge files causing DoS
* Malware uploads
* Files being stored in executable locations
* MIME type spoofing

Don't trust:

```http
Content-Type: image/png
```

alone.

---

### 🔴 9. Path Traversal

Attacker manipulates filenames/paths to access files outside the intended directory.

Conceptually:

```text
/download?file=../../some-sensitive-file
```

The application should resolve paths safely and restrict access to an intended directory.

---

### 🔴 10. Command Injection

User input reaches an operating-system command.

Dangerous pattern:

```js
exec(`some-command ${userInput}`);
```

An attacker may manipulate the command.

This is **particularly important for your Go judge**, because you're executing user-submitted code.

For a judge system, you need strong:

* Container isolation
* CPU limits
* Memory limits
* Process limits
* Timeouts
* Network isolation
* Filesystem restrictions
* Non-root execution
* Resource quotas

---

### 🔴 11. Insecure Deserialization

The application accepts serialized data from users and reconstructs objects without sufficient validation.

Depending on the technology, this can lead to:

* Authentication bypass
* Data manipulation
* Remote code execution

---

### 🔴 12. Security Misconfiguration

Very common.

Examples:

```text
DEBUG=true
```

in production.

Or:

* Default passwords
* Exposed admin panels
* Unnecessary ports
* Detailed error messages
* Stack traces exposed to users
* Missing security headers
* Public database
* Cloud storage accidentally public
* Secrets committed to GitHub

---

### 🔴 13. Secrets Exposure

Examples:

```env
JWT_SECRET=...
MONGO_PASSWORD=...
AWS_SECRET_ACCESS_KEY=...
```

being exposed through:

* GitHub
* frontend JavaScript
* logs
* error messages
* Docker images
* `.env` files accidentally served publicly

**Never put server secrets in frontend environment variables.**

---

### 🔴 14. Sensitive Data Exposure

Examples:

* Password hashes exposed through APIs
* Student personal information returned unnecessarily
* Internal IDs exposed
* Assessment answers exposed before an exam
* API returning fields the frontend doesn't need

Bad:

```json
{
  "name": "Nakul",
  "passwordHash": "...",
  "jwtSecret": "...",
  "internalNotes": "..."
}
```

Even if the frontend doesn't display those fields, the API shouldn't return them.

---

### 🔴 15. API Vulnerabilities

APIs have their own common problems:

* Missing authentication
* Missing authorization
* Excessive data exposure
* Mass assignment
* Missing rate limiting
* Predictable IDs
* Unrestricted pagination
* No request validation
* No request-size limits
* Verbose error responses

Example:

```http
PATCH /api/users/123
```

If the server blindly accepts:

```json
{
  "role": "admin"
}
```

then you've potentially got a **mass assignment / privilege escalation** vulnerability.

---

### 🔴 16. Rate-Limit / Brute-Force Vulnerabilities

Endpoints such as:

```text
/login
/otp
/reset-password
/register
/verify-email
/api/submit
```

can be abused if unlimited requests are allowed.

For example:

```text
POST /login
POST /login
POST /login
...
```

You generally need appropriate rate limits, account protections, and abuse detection.

---

### 🔴 17. Business Logic Vulnerabilities

These are interesting because everything can be technically "valid" but the **logic is wrong**.

Example:

```text
Product price = ₹10,000
```

Frontend sends:

```json
{
  "price": 1
}
```

If the backend trusts it → payment manipulation.

Another example:

```text
User has 5 exam attempts.
```

They discover they can call:

```http
POST /exam/start
```

six times because the backend doesn't enforce the limit.

---

### 🔴 18. Race Conditions

Two requests happen simultaneously and bypass a business rule.

Example:

```text
Available seats = 1

Request A → reserve seat
Request B → reserve seat
```

If both requests read `available = 1` before either updates the database, you might sell the same seat twice.

This is important for:

* Payments
* Inventory
* Reservations
* Exam attempts
* Credits
* Wallets
* Stock management

---

### 🔴 19. CORS Misconfiguration

Bad CORS configuration can expose APIs to unintended origins.

For example, blindly allowing:

```http
Access-Control-Allow-Origin: *
```

or dynamically reflecting arbitrary origins can become dangerous depending on the authentication mechanism and whether credentials are allowed.

---

### 🔴 20. Clickjacking

An attacker embeds your website inside an iframe and tricks users into clicking something they didn't intend to.

Defenses include:

```http
Content-Security-Policy: frame-ancestors ...
```

and appropriate frame protections.

---

### 🔴 21. Open Redirect

Your website accepts a redirect URL:

```text
/login?redirect=https://attacker.com
```

and blindly redirects users there after login.

This can be used for phishing and sometimes becomes part of larger attack chains.

---

### 🔴 22. Dependency Vulnerabilities

Your application itself may be fine, but a dependency isn't.

For example:

```text
React
Express
jsonwebtoken
MongoDB driver
npm packages
Docker images
```

could contain known vulnerabilities.

You need dependency updates and vulnerability scanning.

---

### 🔴 23. Supply-Chain Attacks

Even more dangerous: something you depend on gets compromised.

Examples:

* Malicious npm package
* Compromised GitHub dependency
* Malicious Docker image
* Compromised CI/CD action

Your application can become compromised without your own code being directly vulnerable.

---

### 🔴 24. Logging / Monitoring Problems

Security events aren't logged properly.

You should generally be able to detect things like:

```text
1000 failed login attempts
Permission denied repeatedly
Admin role changed
Suspicious API usage
Mass data export
```

But **don't log secrets, passwords, tokens, or unnecessary sensitive data.**

---

### 🔴 25. Denial of Service

An attacker consumes your:

```text
CPU
RAM
Database connections
Storage
Network
API quota
```

Examples:

* Huge request bodies
* Expensive database queries
* Massive file uploads
* Repeated expensive API calls
* Algorithmic complexity attacks

For your **judge platform**, arbitrary code execution makes this especially important.

---

## 🛡️ The big picture

A useful way to think about web security is:

```text
                    WEB APPLICATION
                          │
       ┌──────────────────┼──────────────────┐
       │                  │                  │
   Frontend             API               Backend
       │                  │                  │
      XSS             Auth/AuthZ        Injection
   CSRF/CORS          IDOR              SSRF
   Clickjacking       Rate limits       Command injection
       │              Validation        File uploads
       │                  │                  │
       └──────────────────┼──────────────────┘
                          │
                       Database
                          │
                   SQL/NoSQL injection
                   Data exposure
                   Race conditions
                          │
                     Infrastructure
                          │
                   Secrets / Docker
                   Cloud / Network
                   Misconfiguration
```

### If you're learning web security, prioritize these 10 first:

1. **Authentication**
2. **Authorization / IDOR**
3. **SQL/NoSQL Injection**
4. **XSS**
5. **CSRF**
6. **SSRF**
7. **File Upload vulnerabilities**
8. **Command Injection**
9. **Security Misconfiguration / Secrets**
10. **Business Logic vulnerabilities**

And for the applications **you've been building**, I'd put **authorization/tenant isolation, API validation, secrets, rate limiting, file uploads, business logic, and arbitrary-code execution/container isolation** particularly high on your checklist.

If you want to become genuinely good at this, the next useful step is to take **one of your own apps (ERP or judge)** and go through it like an attacker, endpoint by endpoint, rather than just memorizing vulnerability names.
