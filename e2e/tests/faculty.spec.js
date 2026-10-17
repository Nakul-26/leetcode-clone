import { test, expect } from '@playwright/test';

test.describe('Faculty Management', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(120000); // Validation can be slow
    await page.goto('/login');
    await page.fill('input[type="email"]', 'faculty@test.com');
    await page.fill('input[type="password"]', 'password123');
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL('/assessments');
  });

  test('faculty can create and validate a problem', async ({ page }) => {
    await page.goto('/add-problem');

    // Fill in basic info
    const problemTitle = `E2E Test Problem ${Date.now()}`;
    await page.fill('input[name="title"]', problemTitle);
    await page.fill('textarea[name="description"]', 'This is a test problem created by E2E suite.');

    // Select a template (it's the first select on the page)
    page.once('dialog', async dialog => {
      console.log('Dialog appeared:', dialog.message());
      await dialog.accept();
    });
    await page.locator('select').first().selectOption('string');

    // Wait for fields to be filled (state update)
    await expect(page.locator('input[name="functionName"]')).toHaveValue('reverseString', { timeout: 10000 });

    // Reference solution should be filled by template
    const refSol = await page.locator('textarea[name="referenceSolution"]').inputValue();
    expect(refSol).toContain('function reverseString');

    // Click Validate Problem
    await page.click('button:has-text("Validate Problem")');

    // Wait for validation report success
    const reportBox = page.locator('.report-box.success');
    await expect(reportBox).toBeVisible({ timeout: 60000 });
    await expect(reportBox).toContainText('ready to be published');

    // Click Create Problem
    await page.click('button:has-text("Create Problem")');

    // Should redirect to problem page
    await expect(page).toHaveURL(/\/problems\/[a-f0-9]+/);
    await expect(page.getByRole('heading', { level: 1, name: problemTitle })).toBeVisible();
    await expect(page.locator('.success-box')).toContainText('Problem created successfully');
  });

  test('faculty can create an assessment', async ({ page }) => {
    await page.goto('/admin/assessments/add');

    const assessmentTitle = `E2E Assessment ${Date.now()}`;
    await page.fill('input[name="title"]', assessmentTitle);
    await page.fill('textarea[name="description"]', 'E2E Test Assessment Description');
    
    // Set duration
    await page.fill('input[name="durationMinutes"]', '60');

    // Set times (format: YYYY-MM-DDTHH:mm)
    const now = new Date();
    const startTime = now.toISOString().slice(0, 16);
    const endTime = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 16);
    
    await page.fill('input[name="startTime"]', startTime);
    await page.fill('input[name="endTime"]', endTime);

    // Add a problem to the assessment
    // Select the first problem from the list
    await page.selectOption('select:has-text("Choose a problem...")', { index: 1 });

    // Click "Add" button
    await page.click('button:has-text("Add")');

    // Set status to Published
    await page.selectOption('select[name="status"]', 'Published');

    // Submit
    await page.click('button:has-text("Save Assessment")');

    // Should redirect to assessments list (based on navigate('/admin/assessments'))
    // Wait, the page says it redirects to /admin/assessments.
    await expect(page).toHaveURL(/\/admin\/assessments/);
    await expect(page.locator('text=' + assessmentTitle)).toBeVisible();
  });
});
