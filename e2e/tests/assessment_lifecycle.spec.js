import { test, expect } from '@playwright/test';

test.describe('Assessment Lifecycle', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(120000);
    // Login as student
    await page.goto('/login');
    await page.fill('input[type="email"]', 'student@test.com');
    await page.fill('input[type="password"]', 'password123');
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL('/assessments');
  });

  test('student can take an assessment and view results', async ({ page }) => {
    // 1. Navigate to Assessments
    await page.click('nav >> text=Assessments');
    await expect(page).toHaveURL('/assessments');

    // 2. Find an active assessment. 
    // We assume the seeding script created at least one active assessment.
    // If not, we might need to create one via faculty first in this test or a prerequisite.
    const joinButton = page.locator('text=Join Now').first();
    await expect(joinButton).toBeVisible({ timeout: 10000 });
    await joinButton.click();

    // 3. Details page
    await expect(page).toHaveURL(/\/assessments\/[a-f0-9]+/);
    const startButton = page.locator('button:has-text("Start Assessment")');
    await expect(startButton).toBeVisible();
    await startButton.click();

    // 3a. Instructions/anti-cheating modal: agree, then continue
    await page.check('input[type="checkbox"]');
    await page.click('button:has-text("I Understand & Continue")');

    // 3b. Fullscreen prompt: entering fullscreen starts the attempt
    await page.click('button:has-text("Enter Fullscreen and Start")');

    // 4. Workspace
    await expect(page).toHaveURL(/\/assessment-attempt\/[a-f0-9]+/);
    
    // Wait for the first problem to load
    await expect(page.locator('.workspace-description h2')).toBeVisible();
    const problemTitle = await page.locator('.workspace-description h2').innerText();
    console.log(`Taking assessment, first problem: ${problemTitle}`);

    // 5. Submit a solution (even if empty/wrong, just to test the flow)
    // We'll just use the default template for now
    await page.click('button:has-text("Submit")');

    // Wait for judge result
    const consoleDrawer = page.locator('.console-drawer');
    await expect(consoleDrawer).toBeVisible();
    
    // We don't necessarily need it to be 'Accepted', just to finish processing
    await expect(page.locator('.console-tab.active')).toHaveText('Result');
    
    // 6. Finish Assessment
    const finishButton = page.locator('button:has-text("Finish Assessment")');
    page.once('dialog', dialog => dialog.accept());
    await finishButton.click();

    // 7. View Results
    await expect(page).toHaveURL(/\/assessment-attempt\/[a-f0-9]+\/result/);
    await expect(page.locator('h2')).toContainText('Assessment Result');
    await expect(page.locator('.problem-card').first()).toBeVisible();
  });
});
