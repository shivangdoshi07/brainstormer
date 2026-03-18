import React, { useImperativeHandle, forwardRef, useState } from "react";
import { Excalidraw, exportToBlob, convertToExcalidrawElements } from "@excalidraw/excalidraw";

/**
 * Returns the point where the line from (cx, cy) toward (tx, ty) exits the
 * bounding box of an element centered at (cx, cy) with given width and height.
 * Used to start/end arrows at the edge of shapes instead of their centers.
 */
function getBoxEdgePoint(cx, cy, width, height, tx, ty) {
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };

  const halfW = (width  || 0) / 2;
  const halfH = (height || 0) / 2;

  // Scale factor so the point lands exactly on the box boundary
  const scaleX = halfW / (Math.abs(dx) || 1);
  const scaleY = halfH / (Math.abs(dy) || 1);
  const scale  = Math.min(scaleX, scaleY);

  return { x: cx + dx * scale, y: cy + dy * scale };
}

const Whiteboard = forwardRef((props, ref) => {
  const [excalidrawAPI, setExcalidrawAPI] = useState(null);

  useImperativeHandle(
    ref,
    () => ({
      exportToImage: async () => {
        if (!excalidrawAPI) return null;
        return exportToBlob({
          elements: excalidrawAPI.getSceneElements(),
          appState: excalidrawAPI.getAppState(),
          mimeType: "image/png",
        });
      },

      getSceneElements: () => excalidrawAPI?.getSceneElements() ?? [],

      getAppState: () => excalidrawAPI?.getAppState() ?? {},

      summarizeScene: () => {
        if (!excalidrawAPI) return "";
        const els = excalidrawAPI.getSceneElements();

        // Build a map from containerId → text so we can label parent shapes
        const textByContainer = {};
        for (const el of els) {
          if (el.type === "text" && el.containerId) {
            textByContainer[el.containerId] = el.text || el.originalText || "";
          }
        }

        return els
          .filter((el) => {
            // Include all non-text elements, plus free-floating text (no containerId)
            if (el.type !== "text") return true;
            return !el.containerId; // free-floating text labels
          })
          .map((el) => {
            if (el.type === "text") {
              const text = (el.text || el.originalText || "").slice(0, 60);
              return `[${el.id}] text (${Math.round(el.x)},${Math.round(el.y)}) label='${text}'`;
            }
            const labelText = textByContainer[el.id] || el.text || "";
            const label = labelText ? ` label='${labelText}'` : "";
            return `[${el.id}] ${el.type} (${Math.round(el.x)},${Math.round(el.y)}) ${Math.round(el.width || 0)}x${Math.round(el.height || 0)}${label}`;
          })
          .join("; ");
      },

      // Accepts ExcalidrawElementSkeleton[] from the LLM.
      //
      // Strategy:
      //   1. Convert shapes first — safe because they have no cross-references.
      //   2. Process arrows separately, one at a time, with access to the full
      //      element map (existing board + newly converted shapes).  This avoids
      //      the case where convertToExcalidrawElements receives an arrow whose
      //      start/end IDs refer to elements outside the current batch and either
      //      silently drops the binding or throws.
      addElements: (skeletons) => {
        if (!excalidrawAPI || !skeletons?.length) return;

        const current = excalidrawAPI.getSceneElements();
        const existingIds = new Set(current.map((el) => el.id));

        // Deduplicate: skip any skeleton whose ID is already on the board
        const fresh = skeletons.filter((s) => !s.id || !existingIds.has(s.id));
        if (!fresh.length) return;

        // ── Step 1: convert non-arrow skeletons ──────────────────────────
        const shapeSkeleons = fresh.filter((s) => s.type !== "arrow");
        let convertedShapes = [];
        if (shapeSkeleons.length) {
          try {
            convertedShapes = convertToExcalidrawElements(shapeSkeleons, { regenerateIds: false });
          } catch (err) {
            console.error("[Whiteboard] convertToExcalidrawElements (shapes) failed:", err);
          }
        }

        // Full lookup: existing board + shapes just converted
        const allById = Object.fromEntries(
          [...current, ...convertedShapes].map((e) => [e.id, e])
        );

        // ── Step 2: process arrows one-by-one with full context ──────────
        const arrowSkeletons = fresh.filter((s) => s.type === "arrow");
        const convertedArrows = [];

        for (const skel of arrowSkeletons) {
          const startEl = skel.start?.id ? allById[skel.start.id] : null;
          const endEl = skel.end?.id ? allById[skel.end.id] : null;

          if (!startEl || !endEl) {
            console.warn(
              `[Whiteboard] Arrow "${skel.id}" skipped: could not resolve` +
              ` start="${skel.start?.id}" end="${skel.end?.id}"`
            );
            continue;
          }

          // Compute center points
          const scx = startEl.x + (startEl.width || 0) / 2;
          const scy = startEl.y + (startEl.height || 0) / 2;
          const ecx = endEl.x + (endEl.width || 0) / 2;
          const ecy = endEl.y + (endEl.height || 0) / 2;

          // Find where the line from start-center toward end-center exits the
          // start element's bounding box, and vice versa for the end element.
          const startEdge = getBoxEdgePoint(scx, scy, startEl.width || 0, startEl.height || 0, ecx, ecy);
          const endEdge   = getBoxEdgePoint(ecx, ecy, endEl.width   || 0, endEl.height   || 0, scx, scy);

          // Add an 8px gap so the arrowhead doesn't sit flush against the shape
          const dist = Math.hypot(ecx - scx, ecy - scy) || 1;
          const gapX = ((ecx - scx) / dist) * 8;
          const gapY = ((ecy - scy) / dist) * 8;

          const ax = startEdge.x + gapX;
          const ay = startEdge.y + gapY;
          const bx = endEdge.x   - gapX;
          const by = endEdge.y   - gapY;

          // Use convertToExcalidrawElements to fill in all required Excalidraw fields,
          // then override geometry with our edge-to-edge coordinates.
          let arrowEl = null;
          try {
            const [base] = convertToExcalidrawElements(
              [{ type: "arrow", id: skel.id, x: ax, y: ay }],
              { regenerateIds: false }
            );
            arrowEl = base;
          } catch (err) {
            console.error("[Whiteboard] convertToExcalidrawElements (arrow) failed:", err);
            continue;
          }

          arrowEl.x = ax;
          arrowEl.y = ay;
          arrowEl.points = [[0, 0], [bx - ax, by - ay]];
          arrowEl.width  = Math.abs(bx - ax);
          arrowEl.height = Math.abs(by - ay);
          // Bindings keep arrows attached when shapes are moved interactively
          arrowEl.startBinding = { elementId: startEl.id, focus: 0, gap: 8 };
          arrowEl.endBinding   = { elementId: endEl.id,   focus: 0, gap: 8 };

          convertedArrows.push(arrowEl);
        }

        const allNew = [...convertedShapes, ...convertedArrows];
        if (!allNew.length) return;

        excalidrawAPI.updateScene({ elements: [...current, ...allNew] });

        // Animate viewport to fit the new elements
        requestAnimationFrame(() => {
          excalidrawAPI.scrollToContent(allNew, {
            fitToContent: true,
            animate: true,
            duration: 400,
          });
        });
      },

      clearScene: () => {
        excalidrawAPI?.resetScene();
      },
    }),
    [excalidrawAPI]
  );

  return (
    <div style={{ flex: 1, height: "100%", width: "100%", position: "relative", overflow: "hidden" }}>
      <div style={{ position: "absolute", inset: 0 }}>
        <Excalidraw excalidrawAPI={(api) => setExcalidrawAPI(api)} />
      </div>
    </div>
  );
});

export default Whiteboard;
