import React, { useImperativeHandle, forwardRef, useRef } from "react";
import { Excalidraw, exportToBlob } from "@excalidraw/excalidraw";

const whiteboardStyle = {
  flex: 1,
  height: "100%",
  width: "100%",
  position: "relative",
  overflow: "hidden",
};

const excalidrawWrapperStyle = {
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
};

const Whiteboard = forwardRef((props, ref) => {
  const excalidrawRef = useRef(null);

  useImperativeHandle(ref, () => ({
    exportToImage: async () => {
      if (excalidrawRef.current) {
        const blob = await exportToBlob({
          elements: excalidrawRef.current.getSceneElements(),
          appState: excalidrawRef.current.getAppState(),
          mimeType: "image/png",
        });
        return blob;
      }
      return null;
    },
    getSceneAndState: () => {
      if (!excalidrawRef.current) {
        return { elements: [], appState: {} };
      }
      return {
        elements: excalidrawRef.current.getSceneElements(),
        appState: excalidrawRef.current.getAppState(),
      };
    },
    summarizeScene: () => {
      if (!excalidrawRef.current) return '';
      const elements = excalidrawRef.current.getSceneElements();
      return elements.map((el) => {
        const { id, type, x, y, width, height, text } = el;
        const label = text ? ` label='${text}'` : '';
        if (width && height) {
          return `[${id}] ${type} (${Math.round(x)},${Math.round(y)}) ${Math.round(width)}x${Math.round(height)}${label}`;
        }
        return `[${id}] ${type} (${Math.round(x)},${Math.round(y)})${label}`;
      }).join('; ');
    },
    updateScene: ({ elements }) => {
      if (excalidrawRef.current && typeof excalidrawRef.current.updateScene === "function") {
        const currentElements = excalidrawRef.current.getSceneElements();
        const merged = [...currentElements, ...elements];
        excalidrawRef.current.updateScene({ elements: merged, scrollToContent: true });
      }
    }
  }));

  return (
    <div style={whiteboardStyle}>
      <div style={excalidrawWrapperStyle}>
        <Excalidraw ref={excalidrawRef} />
      </div>
    </div>
  );
});

export default Whiteboard;