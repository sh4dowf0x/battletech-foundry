// Shared power-pack helpers for personal-scale equipment and weapons.

export function isCharacterPowerPack(item) {
  return ["characterEquipment", "gear"].includes(String(item?.type ?? ""))
    && String(item?.system?.gearType ?? "").trim() === "powerPacks";
}

export function getCharacterPowerPackCapacity(item) {
  if (!isCharacterPowerPack(item)) {
    return { tracked: false, current: 0, maximum: 0, display: "--" };
  }
  const rawCurrent = item.system?.powerCapacity?.current;
  const rawMaximum = item.system?.powerCapacity?.max;
  const storedCurrent = Number(rawCurrent);
  const storedMaximum = Number(rawMaximum);
  const hasCurrent = rawCurrent !== "" && rawCurrent != null && Number.isFinite(storedCurrent);
  const hasMaximum = rawMaximum !== "" && rawMaximum != null && Number.isFinite(storedMaximum) && storedMaximum > 0;
  if (!hasMaximum) return { tracked: false, current: 0, maximum: 0, display: "--" };
  const maximum = Math.max(0, Math.floor(storedMaximum));
  const current = Math.min(maximum, Math.max(0, hasCurrent ? Math.floor(storedCurrent) : maximum));
  return { tracked: true, current, maximum, display: `${current}/${maximum} PP` };
}

export function getCharacterPowerPacks(actor) {
  return Array.from(actor?.items?.contents ?? actor?.items ?? []).filter(isCharacterPowerPack);
}

export function getSelectedCharacterPowerPack(actor, weapon) {
  const packId = String(weapon?.system?.powerPackId ?? "").trim();
  return packId ? getCharacterPowerPacks(actor).find(pack => String(pack.id) === packId) ?? null : null;
}
