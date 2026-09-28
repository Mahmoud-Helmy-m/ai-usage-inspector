// Model vendor is independent of the agent that recorded a turn.
import { isGlm } from "./zai/pricing.mjs";
import { knownModel as anthropicModel } from "../../providers/claude/pricing.mjs";
import { knownModel as openaiModel, normalize as openaiId } from "../../providers/codex/pricing.mjs";
import { lookup, platformOf, providerForId } from "./modelsdev/pricing.mjs";

export function vendorOf(model) {
  if (isGlm(model)) return "z.ai";
  if (platformOf(model)) return "anthropic";
  const extra = lookup(model);
  if (extra) return extra.provider === "openrouter"
    ? providerForId(model.split("/").pop()) || model.split("/")[0].toLowerCase() : extra.provider;
  const id = String(model || "").trim().toLowerCase().split("/").pop();
  if (anthropicModel(id)) return "anthropic";
  if (openaiModel(id) || lookup(id, ["openai"]) || lookup(openaiId(id), ["openai"])) return "openai";
  return null;
}
