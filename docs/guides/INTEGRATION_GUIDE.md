# 🔌 Integration Guide: Testing Platform

This guide describes how to integrate external systems (e.g., a Testing Platform or ERP) with the Assessment Microservice.

## 🏗️ Architecture

The integration layer allows the Testing Platform to act as a bridge between the student and the Coding Platform.

```text
Student
   |
   | JWT (Student Identity)
   v
Testing Platform
   |
   | Service Key + Student JWT
   v
Coding Platform (Assessment Microservice)
```

## 🔐 Authentication

All integration requests must include two layers of authentication:

1.  **Service Authentication (`x-service-key`):** A shared secret between the Testing Platform and the Coding Platform.
2.  **User Authentication (`Authorization`):** The student's JWT forwarded from the Testing Platform.

### Required Headers

| Header | Description | Required For |
| :--- | :--- | :--- |
| `x-service-key` | Shared secret key (configured via `TESTING_PLATFORM_KEY` env) | All integration routes |
| `Authorization` | `Bearer <student_jwt>` | Student-specific actions |
| `x-request-id` | Optional unique request ID for tracing and debugging | Recommended for all requests |

---

## 🚀 Endpoints

All integration endpoints are prefixed with `/api/integration`.

### 1. Create Assessment
`POST /api/integration/assessments`

Allows the Testing Platform to programmatically create an exam.

**Auth:** Service Key only.
**Body:** Standard Assessment model (Title, StartTime, EndTime, Duration, Problem list).

### 2. Get Assessment Details
`GET /api/integration/assessments/:id`

Fetch details of a specific assessment.

**Auth:** Service Key + Student JWT.

### 3. Start Assessment
`POST /api/integration/assessments/:id/start`

Starts the assessment timer and creates an attempt for the student.

**Auth:** Service Key + Student JWT.

### 4. Submit Solution
`POST /api/integration/submissions`

Submits code for judging.

**Auth:** Service Key + Student JWT.
**Body:**
```json
{
  "problemId": "...",
  "code": "...",
  "language": "python",
  "assessmentId": "...",
  "attemptId": "..."
}
```

### 5. Get Results
`GET /api/integration/results/:assessmentId`

Fetch all student attempts and scores for a specific assessment.

**Auth:** Service Key only (Backend-to-Backend).

---

## ⚙️ Configuration

Set the following environment variable in the `assessment-api`:

```bash
TESTING_PLATFORM_KEY=your_secure_random_key_here
```

The coding platform must also share the same `JWT_SECRET` as the authentication provider used by the Testing Platform to verify forwarded student tokens.

## 🧪 Testing

You can verify the integration layer by running the automated test suite:

```bash
cd assessment-api
npm test src/routes/integration.test.js
```
