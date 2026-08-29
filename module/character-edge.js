const SYSTEM_ID = "atow-battletech";

function integer(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export function getCharacterEdgeResource(actor) {
  const edgeAttribute = actor?.system?.attributes?.edg ?? {};
  const attributeXp = Number(edgeAttribute.xp ?? (Number(edgeAttribute.value ?? 0) || 0) * 100) || 0;
  const max = Math.max(0, Math.floor(attributeXp / 100));
  const value = Math.max(0, integer(actor?.system?.edge?.value, max));
  return { value: Math.min(value, max), max };
}

export async function spendCharacterEdge(actor, amount, { label = "Edge" } = {}) {
  const requested = Math.max(0, integer(amount, 0));
  const resource = getCharacterEdgeResource(actor);
  if (!requested) return { ok: true, spent: 0, before: resource.value, after: resource.value };
  if (requested > resource.value) {
    return { ok: false, spent: 0, reason: `${actor?.name ?? "Character"} only has ${resource.value} Edge remaining.` };
  }

  const after = resource.value - requested;
  try {
    await actor.update({ "system.edge.value": after }, { atowEdgeSpend: true, atowEdgeLabel: label });
    return { ok: true, spent: requested, before: resource.value, after };
  } catch (error) {
    console.error(`${SYSTEM_ID} | Could not spend character Edge`, error);
    return { ok: false, spent: 0, reason: "Could not update the character's Edge resource.", error };
  }
}

export async function refundCharacterEdge(actor, amount) {
  const refund = Math.max(0, integer(amount, 0));
  if (!refund) return { ok: true, refunded: 0 };
  const resource = getCharacterEdgeResource(actor);
  const after = Math.min(resource.max, resource.value + refund);
  await actor.update({ "system.edge.value": after }, { atowEdgeRefund: true });
  return { ok: true, refunded: after - resource.value, after };
}
