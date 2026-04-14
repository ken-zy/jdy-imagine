// scripts/lib/character.ts
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";

export interface CharacterProfile {
  name?: string;
  description: string;
  negative?: string;
  references: string[]; // resolved to absolute paths
}

export function loadCharacter(filePath: string): CharacterProfile {
  if (!existsSync(filePath)) {
    throw new Error(`Character file not found: ${filePath}`);
  }
  const raw = JSON.parse(readFileSync(filePath, "utf-8")) as {
    name?: string;
    description?: string;
    negative?: string;
    references?: string[];
  };
  if (!raw.description) {
    throw new Error(
      `Character file ${filePath} is missing required "description" field`,
    );
  }
  const dir = dirname(resolve(filePath));
  return {
    name: raw.name,
    description: raw.description,
    negative: raw.negative,
    references: (raw.references ?? []).map((r) => resolve(dir, r)),
  };
}

// Inject description + negative into prompt (always applied, all modes)
export function applyCharacterPrompt(
  prompt: string,
  character: CharacterProfile,
): string {
  const parts = [character.description];
  if (character.negative) parts.push(character.negative);
  parts.push(prompt);
  return parts.join(" ");
}

// Merge character refs before task refs with dedup (skipped for chain tasks 2..N)
export function mergeCharacterRefs(
  taskRefs: string[],
  character: CharacterProfile,
): string[] {
  const seen = new Set(character.references);
  const merged = [...character.references];
  for (const r of taskRefs) {
    if (!seen.has(r)) {
      seen.add(r);
      merged.push(r);
    }
  }
  return merged;
}
