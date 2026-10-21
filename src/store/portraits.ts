/**
 * Portraits: images players upload for their characters (the SRD has no art). App-only data in
 * IndexedDB, next to the documents and never inside them; shown as object URLs.
 */

import { create } from "zustand";
import { admission } from "@/offline/admission";
import { db } from "@/persistence/db";

const MAX_SIDE = 512;

interface PortraitsState {
  /** Object URL by character id; `null`: none stored; missing: not loaded yet. */
  urls: Readonly<Record<string, string | null>>;
  load(id: string): Promise<void>;
  set(id: string, file: Blob): Promise<void>;
  remove(id: string): Promise<void>;
}

export const usePortraits = create<PortraitsState>()((set, get) => ({
  urls: {},
  async load(id) {
    if (id in get().urls) return;
    set((s) => ({ urls: { ...s.urls, [id]: null } }));
    const blob = await (await db()).get("portraits", id);
    if (blob) set((s) => ({ urls: { ...s.urls, [id]: URL.createObjectURL(blob) } }));
  },
  // kenli F-007 T05 (offline.md §7.3): portraits change only while the admission gate is open.
  set(id, file) {
    return admission.guard(
      "portraits.set",
      () => putPortrait(id, file),
      () => undefined,
    );
  },
  remove(id) {
    return admission.guard(
      "portraits.remove",
      () => removePortrait(id),
      () => undefined,
    );
  },
}));

async function putPortrait(id: string, file: Blob): Promise<void> {
  const { set, get } = portraitsApi;
  {
    const blob = await shrink(file);
    await (await db()).put("portraits", blob, id);
    const old = get().urls[id];
    if (old) URL.revokeObjectURL(old);
    set((s) => ({ urls: { ...s.urls, [id]: URL.createObjectURL(blob) } }));
  }
}

async function removePortrait(id: string): Promise<void> {
  const { set, get } = portraitsApi;
  await (await db()).delete("portraits", id);
  const old = get().urls[id];
  if (old) URL.revokeObjectURL(old);
  set((s) => ({ urls: { ...s.urls, [id]: null } }));
}

const portraitsApi = {
  set: (fn: (s: PortraitsState) => Partial<PortraitsState>) => usePortraits.setState(fn),
  get: () => usePortraits.getState(),
};

/** Scale a large image down so the database stays small. */
async function shrink(file: Blob): Promise<Blob> {
  if (typeof createImageBitmap !== "function") return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1) return file;
    const canvas = new OffscreenCanvas(
      Math.round(bitmap.width * scale),
      Math.round(bitmap.height * scale),
    );
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await canvas.convertToBlob({ type: "image/webp", quality: 0.85 });
  } catch {
    return file;
  }
}
