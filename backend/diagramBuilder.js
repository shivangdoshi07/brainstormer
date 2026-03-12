// DiagramBuilder: deterministic skeleton-format fallback for when the LLM
// returns no elements. Returns ExcalidrawElementSkeleton[] which the frontend
// passes through convertToExcalidrawElements.

const crypto = require("crypto");

function uuid() {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

const KNOWN_LABELS = [
  "user",
  "load balancer",
  "application server", "backend server", "server",
  "dropbox service", "dropbox",
  "blob storage", "storage",
  "upload interface", "upload component", "upload",
  "database", "db", "cache",
  "client", "browser",
  "api gateway", "gateway",
  "queue", "message queue",
];

function normalizePrimaryLabel(raw) {
  if (!raw) return raw;
  if (raw.includes("load balancer")) return "Load Balancer";
  if (raw.includes("application server") || raw.includes("backend server") || raw === "server") return "Application Server";
  if (raw.includes("blob storage") || raw === "storage") return "Blob Storage";
  if (raw.includes("upload interface") || raw.includes("upload component") || raw === "upload") return "Upload Interface";
  if (raw.includes("dropbox")) return "Dropbox Service";
  if (raw.includes("api gateway") || raw === "gateway") return "API Gateway";
  if (raw.includes("database") || raw === "db") return "Database";
  if (raw.includes("cache")) return "Cache";
  if (raw.includes("queue")) return "Message Queue";
  if (raw.includes("client") || raw.includes("browser")) return "Client";
  if (raw.includes("user")) return "User";
  return raw;
}

function shapeTypeForLabel(label) {
  if (label === "Load Balancer" || label === "API Gateway") return "diamond";
  if (label === "Database") return "ellipse";
  return "rectangle";
}

class DiagramBuilder {
  constructor() {
    this.xStart = 100;
    this.yBase = 150;
    this.xStep = 240;
  }

  // Returns ExcalidrawElementSkeleton[] for shapes and arrows that the LLM missed.
  // drawnElementIds is a Set of IDs already on the board (strings).
  buildSkeletons(stepDesc, drawnElementIds = new Set()) {
    const lower = stepDesc.toLowerCase();
    const isConnection = /(arrow|connect|link|─|→)/.test(lower);

    if (isConnection) {
      return this._buildArrowSkeleton(lower, drawnElementIds);
    }

    return this._buildShapeSkeleton(lower, drawnElementIds);
  }

  _buildShapeSkeleton(lower, drawnElementIds) {
    // Extract label from step description
    let label = null;
    for (const k of KNOWN_LABELS) {
      if (lower.includes(k)) {
        label = normalizePrimaryLabel(k);
        break;
      }
    }
    if (!label) label = lower.split(/\s+/).slice(0, 3).join(" ");

    const id = label.toLowerCase().replace(/\s+/g, "-");

    // Don't recreate if already on board
    if (drawnElementIds.has(id)) return [];

    const shapeType = shapeTypeForLabel(label);
    const x = this.xStart + drawnElementIds.size * this.xStep;
    const y = this.yBase;

    return [
      {
        type: shapeType,
        id,
        x,
        y,
        width: 140,
        height: 60,
        label: { text: label },
      },
    ];
  }

  _buildArrowSkeleton(lower, drawnElementIds) {
    // Try to extract "from X to Y"
    let fromLabel = null;
    let toLabel = null;
    const m = lower.match(/from (.+?) to (.+)/);
    if (m) {
      fromLabel = normalizePrimaryLabel(m[1].trim());
      toLabel = normalizePrimaryLabel(m[2].trim());
    } else {
      const found = [];
      for (const k of KNOWN_LABELS) {
        if (lower.includes(k)) found.push(normalizePrimaryLabel(k));
        if (found.length === 2) break;
      }
      if (found.length >= 2) { fromLabel = found[0]; toLabel = found[1]; }
    }

    if (!fromLabel || !toLabel) return [];

    const fromId = fromLabel.toLowerCase().replace(/\s+/g, "-");
    const toId = toLabel.toLowerCase().replace(/\s+/g, "-");

    if (!drawnElementIds.has(fromId) || !drawnElementIds.has(toId)) return [];

    return [
      {
        type: "arrow",
        id: `arrow-${fromId}-${toId}`,
        x: 0,
        y: 0,
        start: { id: fromId },
        end: { id: toId },
      },
    ];
  }
}

module.exports = DiagramBuilder;
