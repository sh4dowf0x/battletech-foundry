import { getCharacterEdgeResource, refundCharacterEdge, spendCharacterEdge } from "./character-edge.js";

const SYSTEM_ID = "atow-battletech";
const FLAG = "characterSkillRoll";

function messageFromEntry(entry) {
  const element = entry instanceof HTMLElement ? entry : entry?.[0];
  const messageId = element?.dataset?.messageId;
  return messageId ? game.messages?.get(messageId) ?? null : null;
}

function skillRollData(message) {
  return message?.getFlag?.(SYSTEM_ID, FLAG) ?? null;
}

function actorForMessage(message, data = skillRollData(message)) {
  let actor = message?.speakerActor ?? message?.actor ?? null;
  if (!actor && data?.actorUuid && typeof fromUuidSync === "function") {
    try { actor = fromUuidSync(data.actorUuid); } catch (_) {}
  }
  if (!actor && data?.actorId) actor = game.actors?.get(data.actorId) ?? null;
  return actor;
}

function rollTotal(message) {
  const total = Number(message?.rolls?.[0]?.total ?? message?.roll?.total);
  return Number.isFinite(total) ? total : null;
}

function canSpendEdgeOnMessage(entry) {
  const message = messageFromEntry(entry);
  const data = skillRollData(message);
  if (!message || !data || data.superseded || rollTotal(message) === null) return false;
  const isAuthor = Boolean(message.isAuthor || String(message.author?.id ?? message.user?.id ?? "") === String(game.user?.id ?? ""));
  if (!game.user?.isGM && !isAuthor) return false;
  const actor = actorForMessage(message, data);
  return Boolean(actor?.isOwner && getCharacterEdgeResource(actor).value > 0);
}

function outcomeSuffix(total, targetNumber) {
  const tn = Number(targetNumber);
  if (!Number.isFinite(tn)) return `Adjusted Total <b>${total}</b>`;
  const margin = total - tn;
  return `Adjusted Total <b>${total}</b> | TN ${tn} -> <b>${margin >= 0 ? "SUCCESS" : "FAIL"}</b> (${margin >= 0 ? "+" : ""}${margin})`;
}

async function applyPostRollEdgeBonus(entry) {
  const message = messageFromEntry(entry);
  const data = skillRollData(message);
  const actor = actorForMessage(message, data);
  if (!message || !data || !actor) return;

  const spend = await spendCharacterEdge(actor, 1, { label: `Post-roll +1: ${data.skillName ?? "Skill"}` });
  if (!spend.ok) return ui.notifications?.warn?.(spend.reason ?? "Could not spend Edge.");

  const previousBonus = Math.max(0, Number(data.postEdgeBonus ?? 0) || 0);
  const nextBonus = previousBonus + 1;
  const adjustedTotal = Number(rollTotal(message)) + nextBonus;
  const baseFlavor = String(data.baseFlavor ?? data.skillName ?? "Skill Check");
  const flavor = `${baseFlavor} | Post-Roll Edge +${nextBonus} | ${outcomeSuffix(adjustedTotal, data.targetNumber)}`;

  try {
    await message.update({
      flavor,
      [`flags.${SYSTEM_ID}.${FLAG}.postEdgeBonus`]: nextBonus
    });
    ui.notifications?.info?.(`${actor.name} spent 1 Edge to add +1 to ${data.skillName ?? "the roll"}.`);
  } catch (error) {
    await refundCharacterEdge(actor, 1).catch(() => {});
    console.error(`${SYSTEM_ID} | Could not apply post-roll Edge bonus`, error);
    ui.notifications?.error?.("Could not apply Edge to that roll; the Edge point was refunded.");
  }
}

async function rerollWithEdge(entry) {
  const message = messageFromEntry(entry);
  const data = skillRollData(message);
  const actor = actorForMessage(message, data);
  if (!message || !data || !actor) return;

  const spend = await spendCharacterEdge(actor, 1, { label: `Full reroll: ${data.skillName ?? "Skill"}` });
  if (!spend.ok) return ui.notifications?.warn?.(spend.reason ?? "Could not spend Edge.");

  const oldFlavor = message.flavor;
  const baseFlavor = String(data.baseFlavor ?? data.skillName ?? "Skill Check");
  try {
    await message.update({
      flavor: `${oldFlavor ?? baseFlavor} | <b>Superseded by an Edge reroll</b>`,
      [`flags.${SYSTEM_ID}.${FLAG}.superseded`]: true
    });

    const originalFlavor = String(data.originalFlavor ?? data.baseFlavor ?? data.skillName ?? "Skill Check");
    const nextRerollCount = Math.max(0, Number(data.rerollCount ?? 0) || 0) + 1;
    const rerollFlavor = `${originalFlavor} | Edge Full Reroll #${nextRerollCount}`;
    const nextData = {
      ...data,
      originalFlavor,
      baseFlavor: rerollFlavor,
      postEdgeBonus: 0,
      superseded: false,
      rerollCount: nextRerollCount,
      previousMessageId: message.id
    };
    const api = game[SYSTEM_ID]?.api;
    if (typeof api?.rollCheck === "function") {
      await api.rollCheck({
        actor,
        label: data.skillName ?? "Skill Check",
        modifier: Number(data.modifier ?? 0) || 0,
        tn: data.targetNumber,
        flavor: rerollFlavor,
        diceFormula: data.diceFormula ?? "2d6",
        messageFlags: { [SYSTEM_ID]: { [FLAG]: nextData } },
        messageData: { whisper: message.whisper, blind: message.blind }
      });
    } else {
      const roll = await new Roll(`${data.diceFormula ?? "2d6"} + ${Number(data.modifier ?? 0) || 0}`).evaluate();
      await roll.toMessage({
        speaker: ChatMessage.getSpeaker({ actor }),
        flavor: rerollFlavor,
        whisper: message.whisper,
        blind: message.blind,
        flags: { [SYSTEM_ID]: { [FLAG]: nextData } }
      });
    }
  } catch (error) {
    await message.update({
      flavor: oldFlavor,
      [`flags.${SYSTEM_ID}.${FLAG}.superseded`]: false
    }).catch(() => {});
    await refundCharacterEdge(actor, 1).catch(() => {});
    console.error(`${SYSTEM_ID} | Could not reroll skill check with Edge`, error);
    ui.notifications?.error?.("Could not reroll that check; the Edge point was refunded.");
  }
}

export function registerCharacterEdgeChatHooks() {
  Hooks.on("getChatMessageContextOptions", (_application, menuItems) => {
    menuItems.unshift(
      {
        name: "Spend 1 Edge: Add +1",
        icon: '<i class="fas fa-plus-circle"></i>',
        group: SYSTEM_ID,
        condition: canSpendEdgeOnMessage,
        callback: applyPostRollEdgeBonus
      },
      {
        name: "Spend 1 Edge: Full Reroll",
        icon: '<i class="fas fa-dice"></i>',
        group: SYSTEM_ID,
        condition: canSpendEdgeOnMessage,
        callback: rerollWithEdge
      }
    );
  });
}
