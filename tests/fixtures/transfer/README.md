# Transfer fixtures (synthetic)

Copied unchanged from the kenli F-008 contract fixtures (`docs/features/F-008-url-import/contracts/fixtures/`
in the dnd5 workbench): an invented pack `synthetic-a` in two versions (1.0.0: a cantrip, humans resist fire, a
30 HP dummy; 2.0.0: a 1st-level spell, no resistance, a 40 HP dummy), two characters on them (Wren on 1.0.0 with
a spent state, Sable on 2.0.0), a build without a state, a mixed-version encounter, a stopped `add_character`,
negative cases and a library layout (`library/s/<sha256>.json` snapshots, `library/d/…` pointers). No SRD text
beyond ids, no campaign data. `refs.json` lists their exact identities (the SRD's is engine `dist/srd-5.2.1`'s).
