import { test, expect } from "@playwright/test";
import { login, mockSupabase } from "./support";

test("upload previews a text file and confirms", async ({ page }) => {
  await mockSupabase(page);
  await login(page);
  await page.goto("/upload");
  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.setInputFiles({
    name: "note.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Deep learning for legal research. A sufficiently long sentence for chunking."),
  });
  await expect(page.getByText("Accept & Index")).toBeVisible({ timeout: 30_000 });
  await page.click('button:has-text("Accept & Index")');
  await expect(page.getByText("✓ Accepted")).toBeVisible({ timeout: 30_000 });
});
