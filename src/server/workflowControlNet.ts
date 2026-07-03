import type { GenerationRequest } from "../shared/types";
import {
  type JsonObject,
  findNodeIdByExactClass,
  getNodeInput,
  isConnection,
  nextNodeId,
  nodeClassIncludes,
  setNodeInput,
  setRolePath,
  stringRole
} from "./workflowGraph";

// Patches a template's ControlNetApplyAdvanced node (§5 of Docs/Feature-PoseControlNet.md).
// The apply node is located via roleMap.controlnet_apply_node, falling back to an exact
// class search. The image supplying it is found by following its `inputs.image` connection
// rather than by class search, because templates commonly contain more than one LoadImage
// node (see the reference workflow's node 754, an inpaint-mask leftover reused as the
// control image slot).
export function patchControlNetPath(
  workflow: JsonObject,
  roleMap: Record<string, unknown>,
  uploadedControlImageName: string,
  request: GenerationRequest
) {
  const controlnet = request.controlnet;
  if (!controlnet) {
    return;
  }

  const applyNodeId = stringRole(roleMap.controlnet_apply_node) ?? findNodeIdByExactClass(workflow, "ControlNetApplyAdvanced");
  if (!applyNodeId) {
    // ControlNet attachment is optional: templates without a ControlNetApplyAdvanced node
    // simply do not receive the pose image.
    return;
  }

  const imageConnection = getNodeInput(workflow, applyNodeId, ["image"]);
  const connectedNodeId = isConnection(imageConnection) ? imageConnection[0] : null;
  const loadImageNodeId = typeof connectedNodeId === "string" && nodeClassIncludes(workflow, connectedNodeId, ["LoadImage"])
    ? connectedNodeId
    : addLoadImageNode(workflow, uploadedControlImageName);

  setNodeInput(workflow, loadImageNodeId, ["image"], uploadedControlImageName);
  setNodeInput(workflow, applyNodeId, ["image"], [loadImageNodeId, 0]);

  setRolePath(workflow, roleMap.controlnet_strength_input, controlnet.strength);
  setNodeInput(workflow, applyNodeId, ["strength"], controlnet.strength);
  setRolePath(workflow, roleMap.controlnet_start_percent_input, controlnet.startPercent);
  setNodeInput(workflow, applyNodeId, ["start_percent"], controlnet.startPercent);
  setRolePath(workflow, roleMap.controlnet_end_percent_input, controlnet.endPercent);
  setNodeInput(workflow, applyNodeId, ["end_percent"], controlnet.endPercent);
}

function addLoadImageNode(workflow: JsonObject, uploadedImageName: string): string {
  const nodeId = nextNodeId(workflow);
  workflow[nodeId] = {
    inputs: {
      image: uploadedImageName
    },
    class_type: "LoadImage",
    _meta: {
      title: "GURUGURU ControlNet Load Image"
    }
  };
  return nodeId;
}
