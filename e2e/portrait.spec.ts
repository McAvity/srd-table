/**
 * kenli F-011 T04 in real browsers (Chromium, WebKit; the iPad project is an emulation, not a
 * physical iPad), on a production build served from /tmp: "Import character" of a full copy with a
 * real PNG portrait — fully decoded by the browser, previewed, created, shown; a copy whose portrait
 * has a valid header over broken image data refused at import with nothing written; a new portrait
 * made by this browser's own encoder above 512 px — shrunk, and stored as whatever the encoder
 * really returned (WebKit may answer PNG for WebP), read back from the character's export; a damaged
 * image refused by the real decoder with the old portrait kept; Undo/Redo of the import with the
 * portrait. Review03 R03-06: JPEGs made by this browser with EXIF orientation 6 or 8 — accepted by
 * the real decoders, kept byte for byte up to 512 px and shown turned, shrunk above it with the
 * turned shape; a copy carrying one imported with its exact bytes.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as base, expect, type Page } from "@playwright/test";
import { contentSha } from "../src/lib/canonical";
import { checkImageBytes, toBase64 } from "../src/lib/image";
import { realPng, withExif } from "../tests/helpers/images";
import { FIXTURES } from "./global-setup";

const COPY = join(FIXTURES, "cora.local-copy.json");

/**
 * WebKit's default Playwright context is ephemeral (like Private Browsing), where IndexedDB stores
 * no Blob at all; Safari's normal profile does. So WebKit runs these on a persistent profile (a /tmp
 * folder), and the ephemeral case is its own test below (a safe refusal, nothing written).
 */
const test = base.extend<{ ephemeral: Page }>({
  ephemeral: async ({ context }, use) => use(await context.newPage()),
  page: async ({ page, browserName, playwright, baseURL }, use, info) => {
    if (browserName !== "webkit") return use(page);
    const u = info.project.use;
    const ctx = await playwright.webkit.launchPersistentContext(
      mkdtempSync(join(tmpdir(), "f011-webkit-")),
      {
        ...(process.env.F006_WEBKIT ? { executablePath: process.env.F006_WEBKIT } : {}),
        ...(baseURL ? { baseURL } : {}),
        ...(u.viewport ? { viewport: u.viewport } : {}),
        ...(u.userAgent ? { userAgent: u.userAgent } : {}),
        ...(u.deviceScaleFactor ? { deviceScaleFactor: u.deviceScaleFactor } : {}),
        hasTouch: Boolean(u.hasTouch),
        isMobile: Boolean(u.isMobile),
        acceptDownloads: true,
      },
    );
    await use(ctx.pages()[0] ?? (await ctx.newPage()));
    await ctx.close();
  },
});
const button = (page: Page, name: string | RegExp) =>
  page.getByRole("button", { name, exact: typeof name === "string" });

async function importCopy(
  page: Page,
  file: { name: string; mimeType: string; buffer: Buffer } | string,
) {
  await page.goto("/#/characters");
  await button(page, "Import character").click();
  await page.getByTestId("local-copy-file").setInputFiles(file);
}
/** The shown portrait's decoded size (0×0 when the browser couldn't show it). */
const shownSize = (page: Page) =>
  page
    .locator("img")
    .first()
    .evaluate(async (img: HTMLImageElement) => {
      await img.decode().catch(() => undefined);
      return [img.naturalWidth, img.naturalHeight];
    });
/** The character's exported copy (the real download from its card), parsed; back to the sheet. */
async function exportedCopy(page: Page) {
  const sheet = page.url();
  await page.goto("/#/characters");
  await page
    .getByRole("article")
    .filter({ hasText: "Cora" })
    .getByRole("button", { name: "Export character" })
    .click();
  const download = page.waitForEvent("download");
  await button(page, "Save the file").click();
  const path = await (await download).path();
  await page.keyboard.press("Escape");
  await page.goto(sheet);
  return JSON.parse(readFileSync(path, "utf8"));
}
const portraitInput = (page: Page) =>
  page.locator('input[type="file"][aria-label="Choose a portrait"]');

test("@touch a copy with a portrait: decoded by the browser, previewed, created, shown; Undo and Redo keep it whole", async ({
  page,
}) => {
  await importCopy(page, COPY);
  await expect(page.getByTestId("local-copy-preview")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("local-copy-portrait")).toHaveText(/Portrait: image\/png/);
  await button(page, "Create the copy").click();
  await expect(page.getByRole("heading", { level: 1, name: "Cora" })).toBeVisible();
  expect(await shownSize(page)).toEqual([96, 64]);
  await page.goto("/#/characters");
  await button(page, "Undo the import").click();
  await expect(page.getByRole("article").filter({ hasText: "Cora" })).toHaveCount(0);
  await button(page, "Redo the import").click();
  await page
    .getByRole("article")
    .filter({ hasText: "Cora" })
    .getByRole("link", { name: "Sheet" })
    .click();
  expect(await shownSize(page)).toEqual([96, 64]);
});

test("a copy whose portrait has a good header over broken data: refused by the real decoder, nothing written", async ({
  page,
}) => {
  const copy = JSON.parse(readFileSync(COPY, "utf8"));
  const broken = realPng(96, 64, true);
  checkImageBytes(broken, "image/png"); // the header and CRCs pass: only a full decode tells
  copy.payload.character.portrait = {
    mime: "image/png",
    bytes: broken.length,
    base64: toBase64(broken),
  };
  copy.payload_sha256 = await contentSha(copy.payload);
  await importCopy(page, {
    name: "broken.local-copy.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(copy)),
  });
  await expect(page.getByTestId("local-copy-problem")).toHaveText(
    /The portrait doesn't open as an image/,
    {
      timeout: 60_000,
    },
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("article").filter({ hasText: "Cora" })).toHaveCount(0);
});

test("a new portrait from this browser's encoder above 512 px: shrunk, stored as what the encoder really made; a damaged one refused, the old kept", async ({
  page,
}, info) => {
  await importCopy(page, COPY);
  await expect(page.getByTestId("local-copy-preview")).toBeVisible({ timeout: 60_000 });
  await button(page, "Create the copy").click();
  await expect(page.getByRole("heading", { level: 1, name: "Cora" })).toBeVisible();
  for (const type of ["image/jpeg", "image/webp"]) {
    // The browser's own encoder makes the upload: 1200×800 in the asked type (or what it supports).
    const made = await page.evaluate(async (t) => {
      const canvas = new OffscreenCanvas(1200, 800);
      const g = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
      g.fillStyle = "#3a6";
      g.fillRect(0, 0, 1200, 800);
      g.fillStyle = "#c33";
      g.fillRect(100, 100, 600, 400);
      const blob = await canvas.convertToBlob({ type: t, quality: 0.9 });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let s = "";
      for (const b of bytes) s += String.fromCharCode(b);
      return { type: blob.type, base64: btoa(s) };
    }, type);
    await portraitInput(page).setInputFiles({
      name: `big.${made.type.split("/")[1]}`,
      mimeType: made.type,
      buffer: Buffer.from(made.base64, "base64"),
    });
    await expect(page.getByTestId("portrait-problem")).toHaveCount(0);
    await expect
      .poll(async () => (await shownSize(page)).join("×"), { timeout: 20_000 })
      .toBe("512×341");
    const portrait = (await exportedCopy(page)).payload.character.portrait;
    const bytes = new Uint8Array(Buffer.from(portrait.base64, "base64"));
    const header = checkImageBytes(bytes, portrait.mime);
    expect([header.width, header.height]).toEqual([512, 341]);
    expect(["image/webp", "image/png", "image/jpeg"]).toContain(portrait.mime);
    console.log(`[encoder] ${info.project.name}: upload ${made.type} → stored ${portrait.mime}`);
    info.annotations.push({
      type: "encoder",
      description: `${info.project.name}: upload ${made.type} → stored ${portrait.mime} ${header.width}×${header.height}`,
    });
  }
  // A damaged image (good header, broken data): the real decoder refuses; the shown portrait stays.
  await portraitInput(page).setInputFiles({
    name: "broken.png",
    mimeType: "image/png",
    buffer: Buffer.from(realPng(64, 64, true)),
  });
  await expect(page.getByTestId("portrait-problem")).toHaveText("The image doesn't open.");
  expect(await shownSize(page)).toEqual([512, 341]);
});

test("WebKit's ephemeral profile (as Private Browsing): no Blob in IndexedDB — the import refused whole, nothing written", async ({
  ephemeral: page,
  browserName,
}) => {
  test.skip(browserName !== "webkit", "WebKit's ephemeral store only");
  await importCopy(page, COPY);
  await expect(page.getByTestId("local-copy-preview")).toBeVisible({ timeout: 60_000 });
  await button(page, "Create the copy").click();
  await expect(page.getByTestId("local-copy-problem")).toHaveText(
    /Saving failed: nothing was saved/,
  );
  const count = await page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const req = indexedDB.open("srd-table");
        req.onsuccess = () => {
          const c = req.result.transaction("characters").objectStore("characters").count();
          c.onsuccess = () => resolve(c.result);
          c.onerror = () => reject(c.error);
        };
        req.onerror = () => reject(req.error);
      }),
  );
  expect(count).toBe(0);
});

/** A JPEG made by this browser's encoder (`w`×`h`, two colours), its bytes. */
async function pageJpeg(page: Page, w: number, h: number): Promise<Uint8Array<ArrayBuffer>> {
  const b64 = await page.evaluate(
    async ([width, height]) => {
      const canvas = new OffscreenCanvas(width as number, height as number);
      const g = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
      g.fillStyle = "#246";
      g.fillRect(0, 0, width as number, height as number);
      g.fillStyle = "#e93";
      g.fillRect(0, 0, (width as number) / 2, (height as number) / 3);
      const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let s = "";
      for (const x of bytes) s += String.fromCharCode(x);
      return btoa(s);
    },
    [w, h],
  );
  return new Uint8Array(Buffer.from(b64, "base64"));
}

test("R03-06: EXIF orientation 6 and 8 JPEGs accepted by the real decoders: up to 512 px kept byte for byte and shown turned, above shrunk with the turned shape", async ({
  page,
}, info) => {
  await importCopy(page, COPY);
  await expect(page.getByTestId("local-copy-preview")).toBeVisible({ timeout: 60_000 });
  await button(page, "Create the copy").click();
  await expect(page.getByRole("heading", { level: 1, name: "Cora" })).toBeVisible();
  for (const o of [6, 8]) {
    const small = withExif(await pageJpeg(page, 96, 64), o);
    expect(checkImageBytes(small)).toMatchObject({ width: 96, height: 64, orientation: o });
    await portraitInput(page).setInputFiles({
      name: `o${o}.jpg`,
      mimeType: "image/jpeg",
      buffer: Buffer.from(small),
    });
    await expect(page.getByTestId("portrait-problem")).toHaveCount(0);
    await expect
      .poll(async () => (await shownSize(page)).join("×"), { timeout: 20_000 })
      .toBe("64×96");
    const kept = (await exportedCopy(page)).payload.character.portrait;
    expect(kept.mime).toBe("image/jpeg");
    expect(kept.base64).toBe(toBase64(small)); // the raw bytes, EXIF included

    const big = withExif(await pageJpeg(page, 1200, 800), o);
    await portraitInput(page).setInputFiles({
      name: `big-o${o}.jpg`,
      mimeType: "image/jpeg",
      buffer: Buffer.from(big),
    });
    await expect(page.getByTestId("portrait-problem")).toHaveCount(0);
    await expect
      .poll(async () => (await shownSize(page)).join("×"), { timeout: 20_000 })
      .toBe("341×512");
    const thumb = (await exportedCopy(page)).payload.character.portrait;
    const header = checkImageBytes(new Uint8Array(Buffer.from(thumb.base64, "base64")), thumb.mime);
    expect([header.width, header.height, header.orientation]).toEqual([341, 512, 1]);
    console.log(
      `[exif] ${info.project.name}: orientation ${o} → kept ${small.length} B raw; thumbnail ${thumb.mime} 341×512`,
    );
  }
  // An ordinary JPEG (no EXIF) keeps its coded shape.
  const plain = await pageJpeg(page, 1200, 800);
  await portraitInput(page).setInputFiles({
    name: "plain.jpg",
    mimeType: "image/jpeg",
    buffer: Buffer.from(plain),
  });
  await expect
    .poll(async () => (await shownSize(page)).join("×"), { timeout: 20_000 })
    .toBe("512×341");
});

test("R03-06: a copy whose portrait is an EXIF-oriented JPEG imports with its exact bytes and shows turned", async ({
  page,
}) => {
  await page.goto("/#/characters");
  const image = withExif(await pageJpeg(page, 96, 64), 6);
  const copy = JSON.parse(readFileSync(COPY, "utf8"));
  copy.payload.character.portrait = {
    mime: "image/jpeg",
    bytes: image.length,
    base64: toBase64(image),
  };
  copy.payload_sha256 = await contentSha(copy.payload);
  await importCopy(page, {
    name: "oriented.local-copy.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(copy)),
  });
  await expect(page.getByTestId("local-copy-portrait")).toHaveText(/Portrait: image\/jpeg/, {
    timeout: 60_000,
  });
  await button(page, "Create the copy").click();
  await expect(page.getByRole("heading", { level: 1, name: "Cora" })).toBeVisible();
  expect(await shownSize(page)).toEqual([64, 96]);
  const back = (await exportedCopy(page)).payload.character.portrait;
  expect(back).toEqual({ mime: "image/jpeg", bytes: image.length, base64: toBase64(image) });
});
