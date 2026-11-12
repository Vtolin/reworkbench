import { test, expect } from "@playwright/test";
import { login, mockSupabase } from "./support";

test("makalah setup and outline approval guard", async ({ page }) => {
  await mockSupabase(page);
  await login(page);
  await page.goto("/makalah");
  // Step 1: enter a topic, switch to Mode B (define structure).
  await page.fill('input[placeholder^="cth."]', "Test topic for makalah");
  await page.click('button:has-text("Mode B")');
  await page.click('button:has-text("Continue")');
  // Step 2: approve is disabled while subsection titles are empty.
  await expect(page.getByRole("button", { name: /Approve outline/i })).toBeDisabled();
});
