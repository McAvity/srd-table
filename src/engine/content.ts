/**
 * Content packs loaded by table. A catalog without a table throws `ContentError` on any read, so
 * a missing table is never a silent `undefined`; a loader rebuilds its catalog with more tables
 * when an operation needs them.
 *
 * The worker keeps one loader for the campaign's packs (Settings: documents without their own
 * content) and one per exact content context (kenli F-008: a document pinned to packs by id,
 * version and hash), so two versions of a pack never meet in one catalog. A pack's files are read
 * whole the first time it's used and kept for the session (served packs) or registered with their
 * verified hash (imported packs), so a table never opened before still loads with the host gone.
 */

import {
  type Catalog,
  CORE_TABLES,
  ContentError,
  type ContentPack,
  createCatalog,
  loadPack,
  TABLE_NAMES,
  type TableName,
} from "srd-rules-engine";
import {
  type ContentContext,
  contextKey,
  type PackFiles,
  type PackRef,
  packRefOf,
} from "@/lib/canonical";

/** Fetch a pack's file (`manifest.json`, `classes.json`) as parsed JSON. */
export type FetchPackFile = (pack: string, file: string) => Promise<unknown>;

/**
 * What each kind of screen needs, in the order an operation escalates when it reads a table that
 * isn't loaded: a builder starts with the core tables and adds spells for a caster; play adds magic
 * items; encounters add monsters.
 */
export const TIERS = {
  builder: [CORE_TABLES, [...CORE_TABLES, "spells"], TABLE_NAMES],
  play: [[...CORE_TABLES, "spells", "magic_items"], TABLE_NAMES],
  encounter: [TABLE_NAMES],
} as const satisfies Record<string, readonly (readonly TableName[])[]>;
export type Tier = keyof typeof TIERS;

export interface ContentSettings {
  /** Pack ids, in load order (the SRD first). Each is served at `content/<id>/`. */
  readonly packs: readonly string[];
  /** Sources a campaign allows (`null`: every source of the loaded packs). */
  readonly sources: readonly string[] | null;
}

export const DEFAULT_CONTENT: ContentSettings = { packs: ["srd-5.2.1"], sources: null };

export class ContentLoader {
  private settings: ContentSettings = DEFAULT_CONTENT;
  private readonly files = new Map<string, Promise<unknown>>();
  private loaded: { tables: Set<TableName>; catalog: Catalog } | null = null;
  private pending: Promise<Catalog> | null = null;

  constructor(private readonly fetchFile: FetchPackFile) {}

  configure(settings: ContentSettings): void {
    this.settings = settings;
    this.loaded = null;
    this.pending = null;
    // kenli F-007 T04: another configuration may read other files under the same pack id.
    this.files.clear();
  }

  /** A catalog with at least these tables (rebuilt with the union of what's loaded and them). */
  async catalog(tables: readonly TableName[]): Promise<Catalog> {
    for (;;) {
      const current = this.loaded;
      if (current && tables.every((t) => current.tables.has(t))) return current.catalog;
      if (this.pending) {
        await this.pending;
        continue;
      }
      const wanted = new Set<TableName>([...(current?.tables ?? []), ...tables]);
      this.pending = this.build([...wanted]);
      try {
        const catalog = await this.pending;
        this.loaded = { tables: wanted, catalog };
        return catalog;
      } finally {
        this.pending = null;
      }
    }
  }

  /**
   * Run `fn` against a catalog of the tier's first table set; if it reads a table that isn't
   * loaded (`ContentError`), run it again with the tier's next, larger set.
   */
  async run<T>(tier: Tier, fn: (catalog: Catalog) => T): Promise<T> {
    const sets = TIERS[tier];
    for (const [i, tables] of sets.entries()) {
      const catalog = await this.catalog(tables);
      try {
        return fn(catalog);
      } catch (error) {
        if (!(error instanceof ContentError) || i === sets.length - 1) throw error;
      }
    }
    throw new Error("unreachable");
  }

  private async build(tables: readonly TableName[]): Promise<Catalog> {
    const packs: ContentPack[] = await Promise.all(
      this.settings.packs.map((id) => loadPack((file) => this.file(id, file), { tables })),
    );
    const sources = this.settings.sources ?? undefined;
    return createCatalog(packs, { tables, ...(sources ? { sources } : {}) });
  }

  /** Each file is fetched once; a failed fetch is forgotten so it can be retried. */
  private file(pack: string, file: string): Promise<unknown> {
    const key = `${pack}/${file}`;
    let promise = this.files.get(key);
    if (!promise) {
      promise = this.fetchFile(pack, file).catch((error: unknown) => {
        this.files.delete(key);
        throw error;
      });
      this.files.set(key, promise);
    }
    return promise;
  }
}

/**
 * Served packs read whole, once per session: the manifest and every table it lists. A later
 * catalog (another table, another context, after the cache let one go) needs no network. With the
 * host gone, a copy kept in storage (`bundled`) serves instead.
 */
export class SessionPacks {
  private readonly packs = new Map<string, Promise<PackFiles>>();
  /** Copies kept in storage (`bundled`, kenli F-008 §9.5), used when the host can't serve the pack. */
  private readonly stored = new Map<string, PackFiles>();

  constructor(private readonly fetchFile: FetchPackFile) {}

  /** A stored copy of a served pack (verified by the caller), for when the host is gone. */
  remember(pack: string, files: PackFiles): void {
    this.stored.set(pack, files);
  }

  files(pack: string): Promise<PackFiles> {
    let promise = this.packs.get(pack);
    if (!promise) {
      const fetching = this.fetchWhole(pack).catch((error: unknown) => {
        const stored = this.stored.get(pack);
        if (stored) return stored;
        throw error;
      });
      fetching.catch(() => {
        if (this.packs.get(pack) === fetching) this.packs.delete(pack);
      });
      this.packs.set(pack, fetching);
      promise = fetching;
    }
    return promise;
  }

  private async fetchWhole(pack: string): Promise<PackFiles> {
    const manifest = (await this.fetchFile(pack, "manifest.json")) as {
      tables?: Record<string, { file: string }>;
    };
    const entries = await Promise.all(
      Object.values(manifest.tables ?? {}).map(
        async ({ file }) => [file, await this.fetchFile(pack, file)] as const,
      ),
    );
    return { "manifest.json": manifest, ...Object.fromEntries(entries) } as PackFiles;
  }

  /** A file of a pack, from the session's copy. */
  async file(pack: string, file: string): Promise<unknown> {
    const files = await this.files(pack);
    if (!(file in files)) throw new ContentError(`${pack} has no file ${file}`);
    return files[file];
  }
}

/** The packs a document's content needs aren't all here (contract `context_unavailable`). */
export class ContextUnavailable extends ContentError {
  override name = "ContextUnavailable";
}

/** A stored pack row as the app reads it from IndexedDB (kenli F-007 T04 §5.1.2). */
export interface StoredPackRow {
  readonly key: string;
  readonly ref: PackRef;
  readonly files: PackFiles;
  readonly bundled: boolean;
}

/** What registering a stored row found: registered, or kept out (`corrupt`, with why). */
export interface StoredPackStatus {
  readonly key: string;
  readonly status: "ok" | "corrupt";
  readonly detail: string | null;
}

export type LocalPackStatus =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "context_unavailable" | "pack_corrupt" };

const rowKey = (ref: PackRef) => `${ref.id}@${ref.version ?? ""}#${ref.sha256}`;

/** Whether a pack's files are whole: its manifest and every table file it lists. */
function missingFiles(files: PackFiles): string[] | null {
  const manifest = files["manifest.json"] as
    | { manifest?: { id?: unknown }; tables?: Record<string, { file?: unknown }> }
    | undefined;
  if (typeof manifest?.manifest?.id !== "string") return null;
  return Object.values(manifest.tables ?? {})
    .map((t) => t?.file)
    .filter((f): f is string => typeof f !== "string" || !Object.hasOwn(files, f))
    .map(String);
}

const MAX_CONTEXTS = 8;

/**
 * The catalogs of the session: the campaign's (`undefined` content) and one per exact content
 * context. Imported packs are registered with their files (checked against their hash); a served
 * pack (the SRD) is used for a context when its hash is the one the context names.
 */
export class ContentRegistry {
  readonly session: SessionPacks;
  private readonly legacy: ContentLoader;
  private readonly registered = new Map<string, PackFiles>();
  /** Hashes of stored rows that didn't verify (kenli F-007 T04): never registered. */
  private readonly corrupt = new Set<string>();
  /**
   * kenli F-007 T04 §5.2: the prepared campaign context's exact refs, by pack id, while it matches
   * the settings. The campaign catalog then reads only these registered files — never the host,
   * never another version.
   */
  private campaign: ReadonlyMap<string, PackRef> | null = null;
  private readonly served = new Map<string, Promise<PackRef>>();
  private readonly loaders = new Map<
    string,
    { loader: ContentLoader; busy: number; used: number }
  >();
  private clock = 0;

  constructor(fetchFile: FetchPackFile) {
    this.session = new SessionPacks(fetchFile);
    this.legacy = new ContentLoader((pack, file) => this.campaignFile(pack, file));
  }

  configure(settings: ContentSettings): void {
    this.campaign = null;
    this.legacy.configure(settings);
  }

  /**
   * The campaign's catalog (kenli F-007 T04 §5.2): with a prepared context whose pack ids (in
   * order) and sources are the settings', its exact refs from registered files, no network;
   * otherwise as `configure` (served packs, then a stored copy when the host is gone).
   */
  configureCampaign(settings: ContentSettings, prepared: ContentContext | null): boolean {
    const sources = (s: readonly string[] | null) =>
      s === null ? null : JSON.stringify([...new Set(s)].sort());
    const usable =
      !!prepared &&
      prepared.packs.length === settings.packs.length &&
      prepared.packs.every((p, i) => p.id === settings.packs[i]) &&
      sources(prepared.sources) === sources(settings.sources);
    this.legacy.configure(settings);
    this.campaign = usable ? new Map(prepared.packs.map((p) => [p.id, p])) : null;
    return usable;
  }

  private async campaignFile(pack: string, file: string): Promise<unknown> {
    const refs = this.campaign;
    if (!refs) return this.session.file(pack, file);
    const ref = refs.get(pack);
    if (!ref)
      throw new ContextUnavailable(`context_unavailable: no ${pack} in the prepared context`);
    const files = this.registered.get(ref.sha256);
    if (!files)
      throw new ContextUnavailable(
        `context_unavailable: ${ref.id} ${ref.version ?? ""} (${ref.sha256.slice(0, 12)}) isn't stored on this device`,
      );
    if (!Object.hasOwn(files, file)) throw new ContentError(`${pack} has no file ${file}`);
    return files[file];
  }

  /**
   * Register stored rows (kenli F-007 T04 §5.1.2): a row is registered only when its files are
   * whole and hash to its own ref and key; anything else is reported `corrupt`, not registered
   * (and not deleted). A bad row never stands in for a hash, and never takes a good one out.
   */
  async registerStored(rows: readonly StoredPackRow[]): Promise<StoredPackStatus[]> {
    const out: StoredPackStatus[] = [];
    // Older stored copies first: the newest bundled copy of a pack is the one kept for the host.
    for (const row of rows) {
      let detail: string | null = null;
      const missing = missingFiles(row.files);
      if (missing === null) detail = "manifest";
      else if (missing.length) detail = `missing ${missing.join(", ")}`;
      else {
        const ref = await packRefOf(row.files);
        if (
          ref.id !== row.ref.id ||
          ref.version !== row.ref.version ||
          ref.sha256 !== row.ref.sha256 ||
          rowKey(row.ref) !== row.key
        )
          detail = `hash ${ref.sha256.slice(0, 12)} ≠ ${row.ref.sha256.slice(0, 12)}`;
      }
      if (detail) {
        if (!this.registered.has(row.ref.sha256)) this.corrupt.add(row.ref.sha256);
        out.push({ key: row.key, status: "corrupt", detail });
        continue;
      }
      this.registered.set(row.ref.sha256, row.files);
      this.corrupt.delete(row.ref.sha256);
      if (row.bundled) this.session.remember(row.ref.id, row.files);
      out.push({ key: row.key, status: "ok", detail: null });
    }
    return out;
  }

  /** Whether an exact pack is registered here and whole (kenli F-007 T04 §5.2), without network. */
  localPackFiles(ref: PackRef): LocalPackStatus {
    const files = this.registered.get(ref.sha256);
    if (!files)
      return this.corrupt.has(ref.sha256)
        ? { ok: false, code: "pack_corrupt" }
        : { ok: false, code: "context_unavailable" };
    const missing = missingFiles(files);
    return missing && missing.length === 0 ? { ok: true } : { ok: false, code: "pack_corrupt" };
  }

  /**
   * Register imported packs (immutable, by hash); returns their refs. `bundled`: stored copies of
   * packs served with the app, also used for the served pack when the host is gone.
   */
  async register(packs: readonly PackFiles[], bundled = false): Promise<PackRef[]> {
    const refs: PackRef[] = [];
    for (const files of packs) {
      const ref = await packRefOf(files);
      this.registered.set(ref.sha256, files);
      if (bundled) this.session.remember(ref.id, files);
      refs.push(ref);
    }
    return refs;
  }

  /** A served pack whole, with its exact ref (to keep it in storage). */
  async servedFiles(pack: string): Promise<{ ref: PackRef; files: PackFiles }> {
    const ref = await this.servedRef(pack);
    return { ref, files: await this.session.files(pack) };
  }

  /** The exact ref of a pack served with the app (the SRD), read whole and hashed once. */
  servedRef(pack: string): Promise<PackRef> {
    let promise = this.served.get(pack);
    if (!promise) {
      promise = this.session
        .files(pack)
        .then(packRefOf)
        .catch((error: unknown) => {
          this.served.delete(pack);
          throw error;
        });
      this.served.set(pack, promise);
    }
    return promise;
  }

  private async filesOf(ref: PackRef): Promise<PackFiles> {
    const own = this.registered.get(ref.sha256);
    if (own) return own;
    let served: PackRef | null = null;
    try {
      served = await this.servedRef(ref.id);
    } catch {
      served = null;
    }
    if (served?.sha256 === ref.sha256) return this.session.files(ref.id);
    throw new ContextUnavailable(
      `context_unavailable: ${ref.id} ${ref.version ?? ""} (${ref.sha256.slice(0, 12)}) isn't installed`,
    );
  }

  /** The loader of a context (least recently used ones let go, never one in use). */
  private loaderFor(content: ContentContext) {
    const key = contextKey(content);
    let entry = this.loaders.get(key);
    if (!entry) {
      const byId = new Map(content.packs.map((p) => [p.id, p]));
      const loader = new ContentLoader(async (pack, file) => {
        const ref = byId.get(pack);
        if (!ref) throw new ContextUnavailable(`context_unavailable: no ${pack} in the context`);
        const files = await this.filesOf(ref);
        if (!(file in files)) throw new ContentError(`${pack} has no file ${file}`);
        return files[file];
      });
      loader.configure({ packs: content.packs.map((p) => p.id), sources: content.sources });
      const created = { loader, busy: 0, used: 0 };
      this.loaders.set(key, created);
      if (this.loaders.size > MAX_CONTEXTS) {
        const idle = [...this.loaders.entries()]
          .filter(([, e]) => e.busy === 0 && e !== created)
          .sort(([, a], [, b]) => a.used - b.used)[0];
        if (idle) this.loaders.delete(idle[0]);
      }
      entry = created;
    }
    entry.used = ++this.clock;
    return entry;
  }

  private async use<T>(
    content: ContentContext | undefined,
    fn: (loader: ContentLoader) => Promise<T>,
  ): Promise<T> {
    if (!content) return fn(this.legacy);
    const entry = this.loaderFor(content);
    entry.busy++;
    try {
      return await fn(entry.loader);
    } finally {
      entry.busy--;
    }
  }

  run<T>(content: ContentContext | undefined, tier: Tier, fn: (catalog: Catalog) => T): Promise<T> {
    return this.use(content, (loader) => loader.run(tier, fn));
  }

  catalog(content: ContentContext | undefined, tables: readonly TableName[]): Promise<Catalog> {
    return this.use(content, (loader) => loader.catalog(tables));
  }

  /** How many context catalogs are held (tests). */
  get contexts(): number {
    return this.loaders.size;
  }
}

/** The browser's loader: packs served as static files under `<base>content/<pack>/`. */
export function fetchFromServer(base: string): FetchPackFile {
  return async (pack, file) => {
    const response = await fetch(`${base}content/${pack}/${file}`);
    if (!response.ok) {
      throw new ContentError(`Couldn't load ${pack}/${file} (HTTP ${response.status})`);
    }
    return response.json();
  };
}
