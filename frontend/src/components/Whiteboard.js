import React, { useImperativeHandle, forwardRef, useState } from "react";
import { Excalidraw, exportToBlob, convertToExcalidrawElements } from "@excalidraw/excalidraw";

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
          .filter((el) => el.type !== "text") // bound text is captured via textByContainer
          .map((el) => {
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
            // Can't resolve both endpoints — skip this arrow and warn
            console.warn(
              `[Whiteboard] Arrow "${skel.id}" skipped: could not resolve` +
              ` start="${skel.start?.id}" end="${skel.end?.id}"`
            );
            continue;
          }

          // Compute center-to-center geometry
          const sx = startEl.x + (startEl.width || 0) / 2;
          const sy = startEl.y + (startEl.height || 0) / 2;
          const ex = endEl.x + (endEl.width || 0) / 2;
          const ey = endEl.y + (endEl.height || 0) / 2;

          // Use convertToExcalidrawElements to fill in all required fields,
          // then immediately override the geometry with our computed values.
          let arrowEl = null;
          try {
            // Pass a minimal skeleton — no start/end IDs to avoid cross-ref issues
            const [base] = convertToExcalidrawElements(
              [{ type: "arrow", id: skel.id, x: sx, y: sy }],
              { regenerateIds: false }
            );
            arrowEl = base;
          } catch (err) {
            console.error("[Whiteboard] convertToExcalidrawElements (arrow) failed:", err);
            continue;
          }

          // Set correct geometry and bindings
          arrowEl.x = sx;
          arrowEl.y = sy;
          arrowEl.points = [[0, 0], [ex - sx, ey - sy]];
          arrowEl.width = Math.abs(ex - sx);
          arrowEl.height = Math.abs(ey - sy);
          arrowEl.startBinding = { elementId: startEl.id, focus: 0, gap: 1 };
          arrowEl.endBinding = { elementId: endEl.id, focus: 0, gap: 1 };

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
