import { createHash } from "node:crypto";

export type JsonObject = Record<string, unknown>;

export function hashJson(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function normalizeRoleMap(value: unknown): Record<string, unknown> {
  if (!isObject(value)) {
    throw new Error("role map must be a JSON object");
  }
  return value;
}

export function ensureWorkflowObject(value: unknown): Record<string, unknown> {
  if (!isObject(value) || Array.isArray(value)) {
    throw new Error("workflow JSON must be an API-format JSON object");
  }
  return value;
}

export function setRolePath(workflow: JsonObject, rawPath: unknown, value: unknown): boolean {
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    return false;
  }

  const path = rawPath.split(".").filter(Boolean);
  if (path.length < 2) {
    throw new Error(`Invalid role map path: ${rawPath}`);
  }

  let cursor: unknown = workflow;
  for (const part of path.slice(0, -1)) {
    if (!isObject(cursor) || !(part in cursor)) {
      throw new Error(`Role map path was not found: ${rawPath}`);
    }
    cursor = cursor[part];
  }

  if (!isObject(cursor)) {
    throw new Error(`Role map path does not resolve to an object: ${rawPath}`);
  }

  cursor[path[path.length - 1]!] = value;
  return true;
}

export function setNodeInput(workflow: JsonObject, rawNodeId: unknown, candidateInputs: string[], value: unknown): boolean {
  if (typeof rawNodeId !== "string" || rawNodeId.trim() === "") {
    return false;
  }

  const node = workflow[rawNodeId];
  if (!isObject(node)) {
    throw new Error(`Role map node was not found: ${rawNodeId}`);
  }

  if (!isObject(node.inputs)) {
    node.inputs = {};
  }

  const inputs = node.inputs as JsonObject;
  for (const inputName of candidateInputs) {
    if (inputName in inputs) {
      inputs[inputName] = value;
      return true;
    }
  }

  inputs[candidateInputs[0]!] = value;
  return true;
}

export function getNodeInput(workflow: JsonObject, rawNodeId: unknown, candidateInputs: string[]): unknown {
  if (typeof rawNodeId !== "string" || rawNodeId.trim() === "") {
    return undefined;
  }

  const node = workflow[rawNodeId];
  if (!isObject(node) || !isObject(node.inputs)) {
    return undefined;
  }

  for (const inputName of candidateInputs) {
    if (inputName in node.inputs) {
      return node.inputs[inputName];
    }
  }
  return undefined;
}

export function stringRole(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function findNodeIdByClass(workflow: JsonObject, classFragments: string[]): string | null {
  for (const [nodeId, rawNode] of Object.entries(workflow)) {
    if (!isObject(rawNode) || typeof rawNode.class_type !== "string") {
      continue;
    }
    const classType = rawNode.class_type.toLowerCase();
    if (classFragments.some((fragment) => classType.includes(fragment.toLowerCase()))) {
      return nodeId;
    }
  }
  return null;
}

export function findNodeIdByExactClass(workflow: JsonObject, className: string): string | null {
  for (const [nodeId, rawNode] of Object.entries(workflow)) {
    if (!isObject(rawNode) || typeof rawNode.class_type !== "string") {
      continue;
    }
    if (rawNode.class_type === className) {
      return nodeId;
    }
  }
  return null;
}

export function nodeClassIncludes(workflow: JsonObject, nodeId: string, classFragments: string[]): boolean {
  const node = workflow[nodeId];
  if (!isObject(node) || typeof node.class_type !== "string") {
    return false;
  }
  const classType = node.class_type.toLowerCase();
  return classFragments.some((fragment) => classType.includes(fragment.toLowerCase()));
}

export function findNodeIdWithInput(workflow: JsonObject, inputName: string): string | null {
  for (const [nodeId, rawNode] of Object.entries(workflow)) {
    if (!isObject(rawNode) || !isObject(rawNode.inputs)) {
      continue;
    }
    if (inputName in rawNode.inputs) {
      return nodeId;
    }
  }
  return null;
}

export function nextNodeId(workflow: JsonObject): string {
  const numericIds = Object.keys(workflow)
    .map((nodeId) => Number(nodeId))
    .filter((nodeId) => Number.isInteger(nodeId) && nodeId >= 0);
  if (numericIds.length > 0) {
    return String(Math.max(...numericIds) + 1);
  }

  let index = 1;
  while (`guruguru_${index}` in workflow) {
    index += 1;
  }
  return `guruguru_${index}`;
}

export function isConnection(value: unknown): value is unknown[] {
  return Array.isArray(value) && typeof value[0] === "string" && typeof value[1] === "number";
}

export function positiveInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.trunc(value)) : 1;
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

export function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null;
}

export function findVaeConnection(workflow: JsonObject): unknown[] {
  const vaeLoaderNodeId = findNodeIdByClass(workflow, ["VAELoader"]);
  if (vaeLoaderNodeId) {
    return [vaeLoaderNodeId, 0];
  }

  for (const rawNode of Object.values(workflow)) {
    if (!isObject(rawNode) || typeof rawNode.class_type !== "string" || !isObject(rawNode.inputs)) {
      continue;
    }
    if (!rawNode.class_type.toLowerCase().includes("vaedecode")) {
      continue;
    }
    const vae = rawNode.inputs.vae;
    if (isConnection(vae)) {
      return [...vae];
    }
  }

  for (const rawNode of Object.values(workflow)) {
    if (!isObject(rawNode) || !isObject(rawNode.inputs)) {
      continue;
    }
    const vae = rawNode.inputs.vae;
    if (isConnection(vae)) {
      return [...vae];
    }
  }

  throw new Error("img2img derivation requires an existing VAE connection or VAELoader node");
}
