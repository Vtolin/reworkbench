import { test, expect } from "@playwright/test";
import { login, mockSupabase } from "./support";

test("login flow reaches the workbench", async ({ page }) => {
  await mockSupabase(page);
  await login(page);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator('input[type="email"]')).not.toBeVisible();
});
