// Separate from AI CAFE application tests: the owner's installed Firefox is controlled
// through geckodriver, NOT Playwright's bundled browser downloads.
import path from "node:path";

export function configureFirefox(firefox, profile) {
  if (!path.isAbsolute(profile)) throw new Error("Dedicated Firefox profile must use an absolute local path");
  // setProfile() copies the profile for each Selenium session, losing new logins.
  // -profile uses this dedicated on-disk directory directly, preserving sign-in state.
  return new firefox.Options()
    .addArguments("-profile", profile)
    .setPreference("browser.download.useDownloadDir", false);
}

export async function launchFirefox(profile, modules) {
  let { selenium, firefox } = modules || {};
  if (!selenium || !firefox) {
    try {
      const [s, f] = await Promise.all([
        import("selenium-webdriver"),
        import("selenium-webdriver/firefox.js"),
      ]);
      selenium = s.default ?? s;
      firefox = f.default ?? f;
    } catch {
      throw new Error("Selenium is not installed. Run npm install in the browser-worker folder.");
    }
  }
  const options = configureFirefox(firefox, profile);
  // Selenium Manager may download geckodriver on the first launch. It does not
  // download Playwright's unsupported Chromium or Firefox builds.
  const driver = await new selenium.Builder()
    .forBrowser("firefox")
    .setFirefoxOptions(options)
    .build();
  return { driver, css: selenium.By.css };
}

export async function checkFirefox(driver) {
  await driver.get("about:blank");
  if (await driver.getCurrentUrl() !== "about:blank") throw new Error("Firefox did not open the local check page");
  return true;
}
