// Model vendor is independent of the agent that recorded a turn.
import { isGlm } from "./zai/pricing.mjs";
import { knownModel as anthropicModel } from "../../providers/claude/pricing.mjs";
import { knownModel as openaiModel } from "../../providers/codex/pricing.mjs";

export function vendorOf(model) {
  if (isGlm(model)) return "z.ai";
  const id = String(model || "").trim().toLowerCase().split("/").pop();
  if (anthropicModel(id)) return "anthropic";
  if (openaiModel(id)) return "openai";
  return null;
}
