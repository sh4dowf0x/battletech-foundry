const SYSTEM_ID = "atow-battletech";
const TEMPLATE = `systems/${SYSTEM_ID}/templates/character-skill-roll.hbs`;

function number(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function bindSkillRollDialog(html) {
  const form = html?.[0]?.querySelector?.("form.atow-character-skill-roll-dialog");
  if (!form) return;
  const total = form.querySelector("[data-skill-roll-total]");
  const edgeBonus = form.querySelector("[data-skill-edge-bonus]");
  const targetNumber = form.querySelector("[data-skill-target-number]");

  const update = () => {
    const data = new FormData(form);
    const edge = Math.max(0, Math.trunc(number(data.get("edgePoints"), 0)));
    const bonus = edge * 2;
    const modifier = number(data.get("rankModifier"), 0)
      + number(data.get("linkModifier"), 0)
      + number(data.get("customModifier"), 0)
      + bonus;
    if (edgeBonus) edgeBonus.textContent = bonus > 0 ? `+${bonus}` : "0";
    if (total) total.textContent = modifier > 0 ? `+${modifier}` : String(modifier);
    if (targetNumber) targetNumber.textContent = String(number(data.get("targetNumber"), 8));
  };

  form.querySelectorAll("input, select").forEach(element => {
    element.addEventListener("input", update);
    element.addEventListener("change", update);
  });
  update();
}

export async function promptCharacterSkillRoll(context = {}) {
  const edgeCurrent = Math.max(0, Math.trunc(number(context.edgeCurrent, 0)));
  const edgeOptions = Array.from({ length: edgeCurrent + 1 }, (_, value) => ({
    value,
    label: value ? `${value} Edge (+${value * 2})` : "No Edge"
  }));
  const content = await renderTemplate(TEMPLATE, { ...context, edgeCurrent, edgeOptions });

  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    new Dialog({
      title: `${context.skillName ?? "Skill"} - Skill Check`,
      content,
      buttons: {
        roll: {
          icon: '<i class="fas fa-dice"></i>',
          label: "Roll Skill",
          callback: html => {
            const form = html?.[0]?.querySelector?.("form.atow-character-skill-roll-dialog");
            if (!form) return finish(null);
            const data = new FormData(form);
            finish({
              rankModifier: number(data.get("rankModifier"), 0),
              linkModifier: number(data.get("linkModifier"), 0),
              customModifier: number(data.get("customModifier"), 0),
              edgePoints: Math.max(0, Math.min(edgeCurrent, Math.trunc(number(data.get("edgePoints"), 0)))),
              targetNumber: number(data.get("targetNumber"), number(context.targetNumber, 8))
            });
          }
        },
        cancel: { label: "Cancel", callback: () => finish(null) }
      },
      default: "roll",
      render: bindSkillRollDialog,
      close: () => finish(null)
    }).render(true);
  });
}
