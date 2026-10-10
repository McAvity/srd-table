import { formatMessage, MESSAGES_EN, type MessageCode, renderMessage } from "srd-rules-engine";
import { describe, expect, it } from "vitest";
import { nodeFacade } from "../../src/engine/node";
import { LOCALES } from "../../src/i18n";
import { ENGINE_LANGUAGES } from "../../src/i18n/engine";
import { fighter } from "../fixtures/characters";

/** Every `{name` that could be an argument of a template (option words included: harmless). */
function args(template: string): string[] {
  return [...template.matchAll(/\{\s*(\w+)\s*[,}]/g)].map((m) => m[1] as string);
}

describe("engine languages", () => {
  it("has an engine language for every app language but English", () => {
    for (const { id } of LOCALES) {
      if (id !== "en") expect(ENGINE_LANGUAGES[id], id).toBeDefined();
    }
  });

  for (const [locale, language] of Object.entries(ENGINE_LANGUAGES)) {
    it(`${locale}: every template parses and uses every parameter the English one shows`, () => {
      for (const code of Object.keys(MESSAGES_EN) as MessageCode[]) {
        const en = MESSAGES_EN[code];
        const params = Object.fromEntries(args(en).map((a) => [a, `@${a}@`]));
        const shownEn = new Set(formatMessage(en, params).match(/@\w+@/g) ?? []);
        const translated = formatMessage(language.messages[code], params, language.messages);
        for (const shown of shownEn) expect(translated, `${code}: ${shown}`).toContain(shown);
      }
    });
  }
});

describe("Italian lists and plurals", () => {
  const it_ = ENGINE_LANGUAGES.it;
  if (!it_) throw new Error("no Italian");
  const render = (code: MessageCode, params: Record<string, unknown>) =>
    renderMessage({ code, params, text: "" } as never, it_.messages, { locale: it_.locale });

  it("joins an or-list with the catalog's joiner and counts with Italian plurals", () => {
    expect(render("option.requires_ability", { abilities: ["Forza", "Destrezza"], min: 13 })).toBe(
      "richiede Forza o Destrezza 13+",
    );
    expect(render("refusal.roll_count", { count: 1, given: 3 })).toBe("Inserisci 1 dado, non 3");
    expect(render("refusal.roll_count", { count: 2, given: 3 })).toBe("Inserisci 2 dadi, non 3");
  });
});

describe("the facade in Italian", () => {
  it("names alignments and a sheet roll's label in Italian", async () => {
    const engine = nodeFacade({ seed: 5 });
    await engine.setLocale("it");
    const constants = await engine.constants();
    expect(constants.alignments.find((a) => a.id === "LG")?.name).toBe("Legale Buono");
    const build = await fighter(engine, 1);
    const test = await engine.rollCheck(build, await engine.createState(build), {
      skill: "athletics",
    });
    expect(test.label).toBe("prova di Atletica");
  });

  it("renders engine texts, names and refusals in Italian, and leaves documents alone", async () => {
    const engine = nodeFacade({ seed: 5 });
    await engine.setLocale("it");

    const constants = await engine.constants();
    expect(constants.abilities.find((a) => a.id === "str")?.name).toBe("Forza");
    expect(constants.skills.find((s) => s.id === "stealth")?.name).toBe("Furtività");
    expect(constants.steps.find((s) => s.id === "class")?.title).toBe("Classe");

    let build = await engine.newBuild();
    for (const edit of [
      { type: "class", id: "fighter" },
      { type: "species", id: "human" },
      { type: "background", id: "soldier" },
    ] as const) {
      const r = await engine.editBuild(build, edit);
      if (!r.ok) throw new Error(r.reasons.join("; "));
      build = r.build;
    }
    const view = await engine.evaluate(build);
    expect(view.steps.find((s) => s.step === "abilities")?.title).toBe(
      "Punteggi di caratteristica",
    );
    const skills = view.choices.find((c) => c.key === "class:fighter#skills");
    expect(skills?.options.find((o) => o.id === "athletics")?.unavailable).toBe(
      "hai già competenza da Soldier",
    );
    expect(view.build).toEqual(build);

    const refused = await engine.editBuild(build, {
      type: "choice",
      key: "class:fighter#skills",
      values: ["athletics", "history"],
    });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reasons.join(" ")).toMatch(/competenza da Soldier/);

    const fight = await engine.applyEncounterAction(await engine.newEncounter(), {}, [
      { type: "add_monster", monster: "goblin-warrior" },
      { type: "set_initiative", id: "goblin-warrior", value: 10 },
      { type: "start" },
      { type: "dodge", id: "goblin-warrior" },
    ]);
    if (!fight.ok) throw new Error(fight.reasons.join("; "));
    expect(fight.notes.join(" ")).toMatch(/usa Schivata/);
    // The stored messages keep the engine's English text.
    expect(fight.messages.map((m) => m.text).join(" ")).toMatch(/Dodges/);

    const rendered = await engine.renderMessages([fight.messages]);
    expect(rendered[0]).toEqual(fight.notes);
    await engine.setLocale("en");
    expect((await engine.renderMessages([fight.messages]))[0]?.join(" ")).toMatch(/Dodges/);
  });
});
