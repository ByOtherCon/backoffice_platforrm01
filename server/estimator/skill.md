# byOther Construction — Estimating Skill

## Overview

This skill reads architectural and MEP permit sets as a complete drawing package and produces:
1. A **proposal draft** (.docx + .pdf) in byOther's format with scope language pulled directly from plan keynotes, fixture schedules, and finish schedules
2. A **Flagged Items list** (appended to the same document) covering anything outside byOther's standard trades or requiring scope ownership clarification
3. **Pricing** for any trade when requested, based on current Florida commercial market rates

When plan PDFs are uploaded, read them as one complete set before generating anything.

---

## Company Header (include on every document)

```
byOther Construction, LLC
184 E Liberty St, Hernando FL 34442
407-434-1825
```

---

## Proposal Format Rules

Follow these exactly every time:

1. **Header block**: Date (top right), byOther logo placeholder, company address block
2. **Created For**: GC name and project name (ask if not provided)
3. **Project Address**: Full address from cover sheet
4. **Permit Set**: Architect name, project number, issue date
5. **Scope line**: Trades included, separated by ` / `
6. **Two-column proposal table**: Description/Scope | Total
   - Each trade gets a **bold underlined header** (e.g., DEMOLITION)
   - Scope items are bullet points using plan keynote codes (e.g., D-2:, A-1.0-7:) followed by scope description pulled directly from plan language
   - Product specs pulled from fixture schedules and keynotes — manufacturer, model number, description exactly as shown on drawings
   - Each trade section ends with: `*Any item not explicitly listed is not included in Scope or Price.`
   - Lump sum dollar amount in the Total column (leave as `$_____` until priced)
7. **No grand total line** unless explicitly requested

**Document generation**: Use the `docx` skill to generate both .docx and .pdf. See `references/docx-template.md` for the exact Node.js boilerplate and styling constants used by byOther.

---

## Standard Trades to Scan For

Only include a section if scope exists in the plans:

| Trade | Trigger |
|---|---|
| Demolition | Demo plan (A-0.x) exists |
| Framing | New partitions, wall types sheet (A-4.x) exists |
| Carpentry | Door schedule, accessory schedule, FF&E plan |
| Flooring | Finish plan (A-1.x) with floor finish schedule |
| Plumbing | Plumbing drawings (P-x.x) exist |
| ACT Ceiling | Reflected ceiling plan (A-2.x) with ACT spec |
| Painting | Finish plan with paint codes |

---

## How to Write Each Trade Section

Read `references/trade-writing-guide.md` for full detail. Summary:

### DEMOLITION
- List every item being removed and disposed of by keynote code
- Reference the demo plan sheet number
- Call out items being salvaged vs. disposed (owner has first right of refusal)
- Note dumpster is included; state proximity requirement
- Flag slab cutting separately — never include in demo scope
- Quantities: floor demo SF, ceiling demo SF (for PlanSwift)

### FRAMING
- List each partition type by designation (Type 1, Type 2, etc.) from the wall types sheet
- State stud gauge, size, height, GWB type, finish level, special conditions (deflection track, bridging, blocking, acoustic treatment)
- Output quantities as: `_____ LF` (placeholder for PlanSwift takeoff)
- Include all blocking scope (TV mounts, mirrors, fitness equipment, accessories)

### CARPENTRY
- List door and frame installs with door numbers, sizes, hardware sets, and full hardware spec from the door schedule
- List all accessories with tag numbers, full manufacturer name, model number, and description from the restroom accessories schedule
- Distinguish: furnished & installed by contractor vs. owner-furnished / contractor-installed
- Include FRP panels with spec from finish schedule

### FLOORING
- List each floor finish by tag (T-1, F-1, F-3, F-4, B-1, etc.) with full manufacturer, item number, color, size, and installation notes from the finish schedule
- Note required vendors if called out in the finish schedule key notes
- Output quantities as: `_____ SF` per finish type (for PlanSwift)
- Note if material is owner-furnished (turf, specialty finishes)

### PLUMBING
- List every fixture by tag (WC-1, LAV-1, MS-1, DF-1, etc.) with full manufacturer name, model number, and description from P-3.0 fixture schedule
- List water heaters with full schedule spec (manufacturer, model, KW, GPM, voltage)
- List all water piping connections per the water floor plan keynotes
- List all sanitary and vent connections per the sanitary floor plan keynotes
- Note permit status: contractor to obtain and pay for all permits
- Flag any slab cutting/concrete work — never include in plumbing scope

### ACT CEILING
- State grid manufacturer and model, tile size, finish/color, wire spacing, attachment method
- Note Rockwool or other insulation above if called out on RCP
- Output quantities as: `_____ SF` ACT area (for PlanSwift)
- If open ceiling / exposed structure exists, note paint scope handles it
- Flag sprinkler modifications separately

### PAINTING
- List each paint code (P-1, P-2, etc.) with: Benjamin Moore (or spec'd manufacturer), color number, color name, finish (semi-gloss, dry-fall, etc.)
- State surface type (walls, ceilings, exposed structure, doors/frames)
- State coat standard (1 prime / 2 finish is byOther standard for GWB)
- State minimum GWB finish level required before paint (Level 4 is standard)
- Include patching scope for existing walls to remain
- Output quantities as: `_____ SF` per paint code / surface type (for PlanSwift)

---

## Quantities to Output

These are placeholders for PlanSwift — always leave as `_____ SF` or `_____ LF` in the proposal body. Never estimate SF/LF unless the user specifically requests a pricing breakdown (see Pricing section below).

| Quantity | Trade |
|---|---|
| Floor demo SF | Demolition |
| Ceiling demo SF | Demolition |
| Partition LF per type | Framing |
| Floor finish SF per tag | Flooring |
| Wall/floor tile SF | Flooring |
| ACT ceiling SF | ACT Ceiling |
| Paint SF per code/surface | Painting |
| All other trades | Count or describe; user applies day-rate |

---

## Flagged Items — Output Separately

After the proposal table, always include a section titled **"FLAGGED ITEMS — REVIEW BEFORE SENDING"** in red.

Flag anything that:
- Is electrical work of any kind
- Is concrete cutting, slab work, or structural concrete
- Involves fire sprinkler modifications or fire alarm work
- Is roof work or waterproofing
- Involves structural steel or engineering scope
- Has ambiguous ownership ("by others," "coordinate with landlord," "by owner's contractor")
- References items supplied by tenant/owner but installed by GC (confirm split)
- Is a deferred permit item (fire alarm, sprinklers) — GC base price may need to include design/submission cost
- Is HVAC / mechanical work
- Is a security or AV system

**Format**: Two-column table — Item | Plan Reference / Notes

For each flagged item, cite the specific sheet and keynote where it appears.

---

## Pricing Trade Sections

When the user asks to price out a trade, provide a **line-item breakdown** in the conversation (not in the proposal body) with:

- Line item description
- Quantity and unit
- Unit price
- Extended cost
- Subtotal
- Overhead & margin (byOther standard: 15%)
- **TRADE TOTAL**

Then ask if the user wants to update the proposal document with the total. When confirmed, regenerate the .docx and .pdf with the price dropped into the corresponding Total cell.

**Market rate guidance**: Read `references/pricing-guide.md` for Florida commercial market rates by trade. Naples/Mercato is a Class A premium market — use the upper band of ranges. Always flag assumptions (quantities estimated vs. measured, allowances vs. hard counts) so the user can validate before submitting.

---

## File Output

Always generate both:
- `[ProjectName]_Proposal_byOther.docx`
- `[ProjectName]_Proposal_byOther.pdf`

Both files identical in content. Copy to `/mnt/user-data/outputs/` and present to user.

---

## Reference Files

| File | When to Read |
|---|---|
| `references/trade-writing-guide.md` | Writing detailed scope language for any trade; edge cases and examples |
| `references/pricing-guide.md` | When pricing out a trade; Florida market rates, crew rates, material costs |
| `references/docx-template.md` | When generating the .docx; Node.js boilerplate, color constants, helper functions |
