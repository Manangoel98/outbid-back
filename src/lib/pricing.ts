// Whole-building price, based on real footprint area + height so a skyscraper costs
// meaningfully more than a small shopfront. Mirrors buildingFloor() in
// frontend/src/stores/gameStore.ts exactly (same coefficients, x100 for cents) — keep
// both in sync if this ever changes.
//
// The $10 floor is a pure safety backstop against corrupt/zero-dimension data — it must
// stay BELOW the naturally smallest real building's computed price (~$23 for the tiniest
// building in this city) or every small building collapses onto the identical floor value
// instead of scaling with its real size, which is the whole point of this formula.
export function buildingFloorCents(w: number, d: number, h: number) {
  return Math.max(1000, Math.round(w * d * 16 + h * 90))
}
