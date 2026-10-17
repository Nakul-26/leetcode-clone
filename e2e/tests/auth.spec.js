import { test, expect } from '@playwright/test';

test.describe('Authentication', () => {
  test('student can login successfully', async ({ page }) => {
    // Navigate to login page
    await page.goto('/login');

    // Fill in credentials
    await page.fill('input[type="email"]', 'student@test.com');
    await page.fill('input[type="password"]', 'password123');

    // Click sign in button
    await page.click('button[type="submit"]');

    // Login lands on the assessments page
    await expect(page).toHaveURL('/assessments');

    // Logout button should be visible
    const logoutButton = page.locator('button:has-text("Logout")');
    await expect(logoutButton).toBeVisible();
    
    // Verify user info is in localStorage (optional but good for robustness)
    const user = await page.evaluate(() => JSON.parse(localStorage.getItem('user')));
    expect(user.email).toBe('student@test.com');
    expect(user.role).toBe('student');
  });

  test('faculty can login successfully', async ({ page }) => {
    await page.goto('/login');
    await page.fill('input[type="email"]', 'faculty@test.com');
    await page.fill('input[type="password"]', 'password123');
    await page.click('button[type="submit"]');

    await expect(page).toHaveURL('/assessments');
    
    // Faculty should see "Add Problem" link in nav
    const addProblemLink = page.locator('nav >> text=Add Problem');
    await expect(addProblemLink).toBeVisible();
  });

  test('show error on invalid credentials', async ({ page }) => {
    await page.goto('/login');
    await page.fill('input[type="email"]', 'wrong@test.com');
    await page.fill('input[type="password"]', 'wrongpassword');
    await page.click('button[type="submit"]');

    const errorBox = page.locator('.error-box');
    await expect(errorBox).toBeVisible();
    await expect(errorBox).toContainText('Invalid credentials');
  });
});
