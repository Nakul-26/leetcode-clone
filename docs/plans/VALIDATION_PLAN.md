# Plan: Mandatory Problem Validation Flow

## Objective
Enforce a mandatory validation step for creating and updating problems. Users must validate the problem (and pass all checks) before they can save it.

## Scope & Impact
- **Frontend**: Modify `AddProblemPage.jsx` and `EditProblemPage.jsx` to disable the "Create/Update" button until validation passes.
- **Backend**: Update `problems.service.js` to include the full validation logic (schema + types + wrappers) during creation/update to ensure consistency.
- **Security**: Add authentication and authorization to the validation endpoint.

## Implementation Steps

### Phase 1: Backend Strengthening
1.  **Consolidate Validation**:
    - Update `assessment-api/src/services/problems.service.js` to call `validateProblemDefinition` (or equivalent logic) inside `createProblem` and `updateProblem`.
    - Ensure that even if a user bypasses the UI, the backend rejects invalid problems.
2.  **Secure Validation Route**:
    - Update `assessment-api/src/routes/preview.routes.js` to add `verifyToken` and `authorizeRoles("admin", "faculty")` to the `/validate` endpoint.

### Phase 2: Frontend UI Enforcement
1.  **AddProblemPage.jsx**:
    - Add state `isValidated` (boolean).
    - Initialize `isValidated` to false.
    - Set `isValidated` to true ONLY when `handleValidate` returns a report where all 3 checks (schema, type, wrapper) are true.
    - Reset `isValidated` to false whenever `formData` changes.
    - Disable the "Create Problem" button if `!isValidated`.
2.  **EditProblemPage.jsx**:
    - Similar logic for editing existing problems.

### Phase 3: Verification
1.  Attempt to create a problem without clicking "Validate" (button should be disabled).
2.  Modify a field after validation (button should become disabled again).
3.  Click "Validate" with a broken problem (creation should remain disabled).
4.  Click "Validate" with a correct problem (creation should become enabled).
5.  Save the problem and verify it is created successfully.

