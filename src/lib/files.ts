/**
 * File export and import: the documents' own JSON, named like the srd-rules CLI's files
 * (`aerin.json` for a build, `aerin.state.json` for its play state), so each can open the other's.
 */

export function downloadJson(fileName: string, data: unknown): void {
  const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export interface ReadFile {
  readonly name: string;
  readonly data: unknown;
}

/** Read JSON files; a file that isn't JSON is reported by name. */
export async function readJsonFiles(
  files: Iterable<File>,
): Promise<{ files: ReadFile[]; bad: string[] }> {
  const read: ReadFile[] = [];
  const bad: string[] = [];
  for (const file of files) {
    try {
      read.push({ name: file.name, data: JSON.parse(await file.text()) });
    } catch {
      bad.push(file.name);
    }
  }
  return { files: read, bad };
}

/** `aerin.state.json` is a play state (the CLI's convention); anything else a build. */
export function isStateFile(name: string): boolean {
  return /\.state\.json$/i.test(name);
}

/** Pair builds with their states by base name: `aerin.json` + `aerin.state.json`. */
export function pairCharacterFiles(
  files: readonly ReadFile[],
): { build: ReadFile; state: ReadFile | null }[] {
  const base = (name: string) => name.replace(/(\.state)?\.json$/i, "").toLowerCase();
  const states = new Map(files.filter((f) => isStateFile(f.name)).map((f) => [base(f.name), f]));
  return files
    .filter((f) => !isStateFile(f.name))
    .map((build) => ({ build, state: states.get(base(build.name)) ?? null }));
}

/**
 * Where an imported file has data its parsed document doesn't keep (`stored_items`, an envelope's
 * `session`, an item's `location`): paths like `inventory.0.location`. The engine's parse drops
 * unknown fields silently, so an import compares the file with the document before committing.
 */
export function droppedFields(raw: unknown, parsed: unknown, path = ""): string[] {
  if (Array.isArray(raw)) {
    if (!Array.isArray(parsed)) return path ? [path] : [];
    return raw.flatMap((v, i) =>
      i < parsed.length
        ? droppedFields(v, parsed[i], join(path, String(i)))
        : [join(path, String(i))],
    );
  }
  if (!isRecord(raw)) return [];
  if (!isRecord(parsed)) return path ? [path] : [];
  return Object.entries(raw).flatMap(([key, value]) =>
    key in parsed ? droppedFields(value, parsed[key], join(path, key)) : [join(path, key)],
  );
}

/** The top-level fields whose values differ between two documents (key order ignored). */
export function changedFields(before: object, after: object): string[] {
  const a = before as Record<string, unknown>;
  const b = after as Record<string, unknown>;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((key) => canonical(a[key]) !== canonical(b[key]))
    .sort();
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function join(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isRecord(v))
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  return JSON.stringify(v) ?? "null";
}
