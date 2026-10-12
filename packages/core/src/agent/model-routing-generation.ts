/**
 * 模型路由代数：设置页默认主/轻量模型，或 Bot 的 runtime.model /
 * light_model / agent 变更时递增。进行中的同模型 HTTP 重试链据此提前停
 * 止，外层 complete / job 用新路由再请求，避免改完设置后仍对着旧模型
 * 退避几十秒。
 */
let generation = 0;

export function modelRoutingGeneration(): number {
  return generation;
}

export function bumpModelRoutingGeneration(): void {
  generation += 1;
}

/** 单测重置。 */
export function resetModelRoutingGeneration(): void {
  generation = 0;
}

export function settingsAffectModelRouting(
  previous: { defaultMainModel: string; defaultLightModel: string },
  next: { defaultMainModel: string; defaultLightModel: string },
): boolean {
  return (
    previous.defaultMainModel !== next.defaultMainModel ||
    previous.defaultLightModel !== next.defaultLightModel
  );
}

export function botRuntimeAffectsModelRouting(
  previous: {
    model: string;
    light_model: string;
    agent: { id: string; model: string };
  },
  next: {
    model: string;
    light_model: string;
    agent: { id: string; model: string };
  },
): boolean {
  return (
    previous.model !== next.model ||
    previous.light_model !== next.light_model ||
    previous.agent.id !== next.agent.id ||
    previous.agent.model !== next.agent.model
  );
}
