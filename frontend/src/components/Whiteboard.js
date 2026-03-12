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
        return excalidrawAPI
          .getSceneElements()
          .filter((el) => el.type !== "text") // skip bound text elements — redundant noise for LLM
          .map((el) => {
            const label = el.text ? ` label='${el.text}'` : "";
            return `[${el.id}] ${el.type} (${Math.round(el.x)},${Math.round(el.y)}) ${Math.round(el.width || 0)}x${Math.round(el.height || 0)}${label}`;
          })
          .join("; ");
      },

      // Accepts ExcalidrawElementSkeleton[] from the LLM.
      // Converts to full elements via convertToExcalidrawElements, then patches
      // arrow bindings that reference elements already on the board (not in this batch).
      addElements: (skeletons) => {
        if (!excalidrawAPI || !skeletons?.length) return;

        const current = excalidrawAPI.getSceneElements();
        const existingIds = new Set(current.map((el) => el.id));

        // Deduplicate: skip any skeleton whose ID is already on the board
        const fresh = skeletons.filter((s) => !s.id || !existingIds.has(s.id));
        if (!fresh.length) return;

        // Convert skeleton → full Excalidraw elements (handles text labels,
        // arrow endpoints, required fields, auto-sizing, etc.)
        const converted = convertToExcalidrawElements(fresh, { regenerateIds: false });

        // convertToExcalidrawElements only resolves bindings for elements inside
        // the same call. For arrows that reference elements already on the board,
        // we patch startBinding / endBinding manually.
        const freshById = Object.fromEntries(fresh.map((s) => [s.id, s]));
        for (const el of converted) {
          if (el.type !== "arrow") continue;
          const skel = el.id ? freshById[el.id] : null;
          if (!skel) continue;
          if (skel.start?.id && existingIds.has(skel.start.id) && !el.startBinding) {
            el.startBinding = { elementId: skel.start.id, focus: 0, gap: 1 };
          }
          if (skel.end?.id && existingIds.has(skel.end.id) && !el.endBinding) {
            el.endBinding = { elementId: skel.end.id, focus: 0, gap: 1 };
          }
        }

        excalidrawAPI.updateScene({ elements: [...current, ...converted] });

        // Animate viewport to fit the new elements
        requestAnimationFrame(() => {
          excalidrawAPI.scrollToContent(converted, {
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
