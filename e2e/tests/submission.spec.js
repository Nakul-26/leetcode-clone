import { test, expect } from '@playwright/test';

test.describe('Student Submissions', () => {
  test.beforeEach(async ({ page }) => {
    test.setTimeout(60000);
    // Login as student before each test
    await page.goto('/login');
    await page.fill('input[type="email"]', 'student@test.com');
    await page.fill('input[type="password"]', 'password123');
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL('/assessments');
    // The problem list lives at /problems (the base URL is now a landing page).
    await page.goto('/problems');
  });

  test('student can solve Two Sum problem', async ({ page }) => {
    // Search for "Two Sum" — with a large problem set, it may not be on the
    // default first page, so filter for it like a real student would. Wait for
    // the filtered response so the initial unfiltered fetch can't race back in
    // and detach the card mid-click.
    await page.fill('input[name="search"]', 'Two Sum');
    await page.waitForResponse((res) => res.url().includes('/api/v1/problems') && res.url().includes('search=Two'));
    await page.click('h3:text("Two Sum (Certification)")');
    await expect(page).toHaveURL(/\/problems\/[a-f0-9]+/);

    // Select Python
    await page.selectOption('select', 'python');

    const pythonCode = `def twoSum(nums, target):
    seen = {}
    for i, num in enumerate(nums):
        diff = target - num
        if diff in seen:
            return [seen[diff], i]
        seen[num] = i
    return []`;

    // Wait for the editor to load
    await page.waitForSelector('.monaco-editor');

    // Set code in Monaco
    const isSet = await page.evaluate((code) => {
      if (window.monaco && window.monaco.editor) {
        const models = window.monaco.editor.getModels();
        if (models.length > 0) {
          models[0].setValue(code);
          return true;
        }
      }
      return false;
    }, pythonCode);

    if (!isSet) {
      console.log('window.monaco not available, falling back to keyboard typing');
      await page.click('.monaco-editor');
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Backspace');
      await page.keyboard.insertText(pythonCode);
    }

    // Click Submit
    await page.click('button:has-text("Submit")');

    // Console drawer should show up
    const consoleDrawer = page.locator('.console-drawer');
    await expect(consoleDrawer).toBeVisible();

    // Wait for "Accepted" or "Success" status
    const statusTextLocator = page.locator('.verdict-banner span');
    
    // Increased timeout and added polling for debug
    await expect(async () => {
      const text = await statusTextLocator.innerText();
      console.log(`Current status: ${text}`);
      expect(['Accepted', 'Success']).toContain(text);
    }).toPass({ timeout: 45000, intervals: [2000] });
  });
});
