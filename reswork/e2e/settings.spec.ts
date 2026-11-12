import { test, expect } from "@playwright/test";
import { login, mockSupabase } from "./support";

test("settings page renders and keeps a value after reload", async ({ page }) => {
  await mockSupabase(page);
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "rw.inference_settings.v1",
      JSON.stringify({
        provider: "cloud",
        model: "gpt-4o-mini",
        embedMode: "server",
        temperature: 0.2,
        numCtx: 4096,
        cloudProvider: "openai",
        cloudModel: "gpt-4o-mini",
        summarizeMethod: "stuff",
        mapStage: { provider: "inherit", model: "", cloudProvider: "openai", cloudModel: "" },
        reduceStage: { provider: "inherit", model: "", cloudProvider: "openai", cloudModel: "" },
        synthesisStage: { provider: "inherit", model: "", cloudProvider: "openai", cloudModel: "" },
        makalahOutlineStage: { provider: "inherit", model: "", cloudProvider: "openai", cloudModel: "" },
        makalahSectionStage: { provider: "inherit", model: "", cloudProvider: "openai", cloudModel: "" },
        makalahThinking: false,
        makalahNumPredict: 3072,
        makalahThinkLevel: "low",
        makalahThinkingBudget: 1024,
      }),
    );
  });
  await login(page);
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: /Chat — inference/i })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: /Chat — inference/i })).toBeVisible();
});
