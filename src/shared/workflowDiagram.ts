export type WorkflowDiagramStatus = "ready" | "empty" | "invalid";

export interface WorkflowDiagram {
  status: WorkflowDiagramStatus;
  source: string;
  message: string;
  nodeCount: number;
  edgeCount: number;
}

import { type Json as JsonObject, isJsonObject } from "./json";
import { nodeIdFromRolePath } from "./workflowRolePath";

interface DiagramNode {
  id: string;
  mermaidId: string;
  classType: string;
  inputs: JsonObject;
  roles: string[];
}

interface DiagramEdge {
  from: string;
  to: string;
  input: string;
}

export function createWorkflowMermaidDiagram(workflow: unknown, roleMap: unknown = {}): WorkflowDiagram {
  if (!isJsonObject(workflow)) {
    return invalidDiagram("workflow JSON must be an API-format JSON object");
  }

  const nodeIds = new Set(Object.keys(workflow));
  const roleIndex = buildRoleIndex(roleMap, nodeIds);
  const nodes = Object.entries(workflow)
    .filter(([, value]) => isJsonObject(value))
    .map(([id, rawNode], index) => toDiagramNode(id, rawNode as JsonObject, roleIndex, index));

  if (nodes.length === 0) {
    return {
      status: "empty",
      source: placeholderSource("Workflow JSON is empty"),
      message: "workflow JSONに表示できるノードがありません。",
      nodeCount: 0,
      edgeCount: 0
    };
  }

  const mermaidIds = new Map(nodes.map((node) => [node.id, node.mermaidId]));
  const edges = collectEdges(nodes, mermaidIds);
  const source = buildMermaidSource(nodes, edges);
  return {
    status: "ready",
    source,
    message: `${nodes.length} nodes / ${edges.length} edges`,
    nodeCount: nodes.length,
    edgeCount: edges.length
  };
}

function toDiagramNode(id: string, rawNode: JsonObject, roleIndex: Map<string, string[]>, index: number): DiagramNode {
  const classType = typeof rawNode.class_type === "string" ? rawNode.class_type : "Unknown";
  return {
    id,
    mermaidId: mermaidNodeId(id, index),
    classType,
    inputs: isJsonObject(rawNode.inputs) ? rawNode.inputs : {},
    roles: roleIndex.get(id) ?? []
  };
}

function collectEdges(nodes: DiagramNode[], mermaidIds: Map<string, string>) {
  const edges: DiagramEdge[] = [];
  const seen = new Set<string>();

  for (const node of nodes) {
    for (const [inputName, inputValue] of Object.entries(node.inputs)) {
      for (const sourceId of collectLinkedNodeIds(inputValue, mermaidIds)) {
        const key = `${sourceId}->${node.id}:${inputName}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        edges.push({
          from: mermaidIds.get(sourceId)!,
          to: node.mermaidId,
          input: inputName
        });
      }
    }
  }

  return edges;
}

function collectLinkedNodeIds(value: unknown, mermaidIds: Map<string, string>): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const directSourceId = linkSourceId(value, mermaidIds);
  if (directSourceId) {
    return [directSourceId];
  }

  return value.flatMap((item) => collectLinkedNodeIds(item, mermaidIds));
}

function linkSourceId(value: unknown[], mermaidIds: Map<string, string>) {
  if (value.length !== 2) {
    return null;
  }
  const [source, outputIndex] = value;
  if ((typeof outputIndex !== "number" && typeof outputIndex !== "string") || !isNumericLike(outputIndex)) {
    return null;
  }
  const sourceId = String(source);
  return mermaidIds.has(sourceId) ? sourceId : null;
}

function buildMermaidSource(nodes: DiagramNode[], edges: DiagramEdge[]) {
  const lines = [
    "flowchart LR",
    "  classDef roleNode fill:#2a1c4c,stroke:#a78bfa,color:#f8fafc,stroke-width:1px;",
    "  classDef defaultNode fill:#171729,stroke:#4b5563,color:#f4f4f7,stroke-width:1px;"
  ];

  for (const node of nodes) {
    const roles = node.roles.length ? `\n${node.roles.slice(0, 4).join(", ")}${node.roles.length > 4 ? ` +${node.roles.length - 4}` : ""}` : "";
    const label = `${node.id}: ${node.classType}${roles}`;
    lines.push(`  ${node.mermaidId}["${escapeMermaidLabel(label)}"]`);
    lines.push(`  class ${node.mermaidId} ${node.roles.length ? "roleNode" : "defaultNode"};`);
  }

  for (const edge of edges) {
    lines.push(`  ${edge.from} -->|${escapeMermaidEdgeLabel(edge.input)}| ${edge.to}`);
  }

  return lines.join("\n");
}

function buildRoleIndex(roleMap: unknown, workflowNodeIds: Set<string>) {
  const roleIndex = new Map<string, string[]>();
  if (!isJsonObject(roleMap)) {
    return roleIndex;
  }

  for (const [roleName, rawPath] of Object.entries(roleMap)) {
    const nodeId = nodeIdFromRolePath(rawPath);
    if (!nodeId || !workflowNodeIds.has(nodeId)) {
      continue;
    }
    const roles = roleIndex.get(nodeId) ?? [];
    roles.push(shortRoleName(roleName));
    roleIndex.set(nodeId, roles);
  }

  return roleIndex;
}

function shortRoleName(roleName: string) {
  return roleName
    .replace(/_node$/u, "")
    .replace(/_input$/u, "")
    .replace(/^ksampler_/u, "k_");
}

function mermaidNodeId(nodeId: string, index: number) {
  return `node_${index}_${nodeId.replace(/[^A-Za-z0-9_]/gu, "_")}`;
}

function escapeMermaidLabel(value: string) {
  return value
    .replace(/\\/gu, "\\\\")
    .replace(/"/gu, '\\"')
    .replace(/\r?\n/gu, "\\n")
    .replace(/\[/gu, "(")
    .replace(/\]/gu, ")");
}

function escapeMermaidEdgeLabel(value: string) {
  const cleaned = value.replace(/[|"]/gu, "").trim();
  return cleaned || "input";
}

function invalidDiagram(message: string): WorkflowDiagram {
  return {
    status: "invalid",
    source: placeholderSource("Invalid workflow JSON"),
    message,
    nodeCount: 0,
    edgeCount: 0
  };
}

function placeholderSource(label: string) {
  return `flowchart LR\n  empty["${escapeMermaidLabel(label)}"]`;
}

function isNumericLike(value: unknown) {
  return value !== "" && Number.isFinite(Number(value));
}
