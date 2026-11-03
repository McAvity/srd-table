// kenli F-014 T01: the footer's version leads to About, which shows the build's metadata and copies
// it — with the text always on screen, so copying never depends on the Clipboard API.

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BuildDetails } from "@/features/settings/AboutPage";
import type { BuildInfo } from "@/offline/build-info";
import { installTestEngine, renderApp, resetStores } from "../helpers/app";

const TABLE = "0d64dc4dae2cf7c1e973065297d53ed19a8618aa";
const ENGINE = "65ff5e28f6bd03a5abf7521c29913e3276b48013";
const RC1: BuildInfo = {
  version: "0.2.0-rc.1",
  release_id: "r-0123456789abcdef",
  table_commit: TABLE,
  engine_commit: ENGINE,
};

// The running build's metadata, switchable per test (the real one is the dev build here).
const build = vi.hoisted(() => ({ info: null as BuildInfo | null }));
vi.mock("@/offline/build-info", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/offline/build-info")>();
  return {
    ...actual,
    get BUILD_INFO() {
      return build.info ?? actual.DEV_BUILD_INFO;
    },
  };
});

installTestEngine(3);
beforeEach(async () => {
  cleanup();
  build.info = null;
  await resetStores();
});
const realClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
afterEach(() => {
  if (realClipboard) Object.defineProperty(navigator, "clipboard", realClipboard);
  else delete (navigator as { clipboard?: unknown }).clipboard;
});
const setClipboard = (value: unknown) =>
  Object.defineProperty(navigator, "clipboard", { value, configurable: true });

describe("footer → About", () => {
  it("a release shows its version in the footer, and About its details", async () => {
    build.info = RC1;
    await renderApp("/characters");
    const footerVersion = await screen.findByTestId("footer-version");
    expect(footerVersion).toHaveTextContent("0.2.0-rc.1");
    expect(footerVersion).toHaveAttribute("href", "/about");
    expect(footerVersion).toHaveAccessibleName("Version 0.2.0-rc.1: details in About");

    fireEvent.click(footerVersion);
    const details = await screen.findByTestId("about-build");
    expect(within(details).getByTestId("about-build-version")).toHaveTextContent("0.2.0-rc.1");
    expect(details).toHaveTextContent("r-0123456789abcdef");
    expect(details).toHaveTextContent(TABLE);
    expect(details).toHaveTextContent(ENGINE);
    // the F-007 marker of the running release stays as it was
    expect(screen.getByTestId("about-version")).toHaveTextContent(/^Version r-/);
  });

  it("the development build never shows a version number", async () => {
    await renderApp("/characters");
    expect(await screen.findByTestId("footer-version")).toHaveTextContent("development build");
    fireEvent.click(screen.getByTestId("footer-version"));
    expect(await screen.findByTestId("about-build-version")).toHaveTextContent("development build");
    expect(screen.getByTestId("about-build")).toHaveAttribute("data-version", "");
    expect(screen.getByTestId("about-build")).toHaveTextContent("unknown");
    expect(screen.getByTestId("about-version")).toHaveTextContent("Version r-dev");
  });

  it("a release without a number shows its own release id", async () => {
    build.info = { ...RC1, version: null };
    await renderApp("/about");
    expect(await screen.findByTestId("footer-version")).toHaveTextContent("r-0123456789abcdef");
    expect(screen.getByTestId("about-build-version")).toHaveTextContent("no version number");
  });
});

describe("copying the details", () => {
  const text = [
    "SRD Table 0.2.0-rc.1",
    "release: r-0123456789abcdef",
    `table: ${TABLE}`,
    `engine: ${ENGINE}`,
  ].join("\n");

  it("shows the text and copies it with the Clipboard API", async () => {
    const writeText = vi.fn(async () => {});
    setClipboard({ writeText });
    render(<BuildDetails info={RC1} />);
    expect(screen.getByTestId("about-build-text").textContent).toBe(text);
    await act(async () => fireEvent.click(screen.getByTestId("about-build-copy")));
    expect(writeText).toHaveBeenCalledWith(text);
    expect(screen.getByTestId("about-build-copy-status")).toHaveTextContent("Copied.");
  });

  it.each([
    ["absent", undefined],
    [
      "refused",
      {
        writeText: async () => {
          throw new DOMException("denied", "NotAllowedError");
        },
      },
    ],
  ])("with the Clipboard API %s, says to copy the text on screen by hand", async (_, clip) => {
    setClipboard(clip);
    render(<BuildDetails info={RC1} />);
    await act(async () => fireEvent.click(screen.getByTestId("about-build-copy")));
    expect(screen.getByRole("status")).toHaveTextContent(/select the text above/);
    expect(screen.getByTestId("about-build-text").textContent).toBe(text);
  });

  it("a dirty build says so", () => {
    render(<BuildDetails info={{ ...RC1, version: null, dirty: true }} />);
    expect(screen.getByTestId("about-build")).toHaveTextContent("uncommitted changes");
    expect(screen.getByTestId("about-build-text").textContent).toContain(
      "uncommitted changes: yes",
    );
  });
});
