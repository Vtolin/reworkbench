import { test, expect } from "@playwright/test";
import { login, mockSupabase } from "./support";

test("research ask returns a diagnostic answer with an empty library", async ({ page }) => {
  await mockSupabase(page);
  await login(page);
  await page.goto("/research");
  const textarea = page.locator("textarea").first();
  await textarea.fill("What is in the library?");
  await page.keyboard.press("Enter");
  await expect(page.getByText(/couldn't find anything/i)).toBeVisible({ timeout: 30_000 });
});
