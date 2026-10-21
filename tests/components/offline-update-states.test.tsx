/**
 * kenli F-007 T05 (R06-02, R06-03): what the update UI says when this page halted an update it
 * couldn't finish safely (the reason, changes paused, Reload) and when the stored update record
 * can't be read (shown, updates paused: no check, nothing offered).
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { UpdateBanner, UpdatePanel } from "@/features/settings/UpdatePanel";
import { useUpdateStore } from "@/offline/update";

const initial = useUpdateStore.getState();
afterEach(() => {
  cleanup();
  useUpdateStore.setState(initial, true);
});

describe("update UI: halted and unreadable", () => {
  it("halted: the banner gives the reason, says changes are paused, offers Reload; no check", () => {
    useUpdateStore.setState({
      halted: { code: "storage_quota", detail: "metadata full" },
      readOnly: false,
    });
    render(
      <>
        <UpdateBanner />
        <UpdatePanel />
      </>,
    );
    const banner = screen.getByTestId("update-banner");
    expect(banner).toHaveTextContent("couldn't finish safely");
    expect(banner).toHaveTextContent("not enough storage on this device (metadata full)");
    expect(banner).toHaveTextContent("Changes are paused");
    expect(screen.getByRole("button", { name: "Reload" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Check for an update" })).toBeDisabled();
  });

  it("unreadable record: shown, updates paused (check disabled, nothing offered)", () => {
    useUpdateStore.setState({ unreadable: true, state: null });
    render(<UpdatePanel />);
    expect(screen.getByTestId("update-unreadable")).toHaveTextContent(
      "kept as it is and updates are paused",
    );
    expect(screen.getByRole("button", { name: "Check for an update" })).toBeDisabled();
    expect(screen.queryByTestId("update-offer")).toBeNull();
  });
});
